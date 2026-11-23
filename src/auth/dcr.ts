import { Hono } from 'hono';
import type { GatewayStore } from '../db/sqlite.js';
import type { AppConfig } from '../types.js';
import { generateId, generateRandomToken, hashToken } from './crypto.js';

export const MAX_DCR_REDIRECT_URIS = 16;
export const MAX_DYNAMIC_CLIENTS = 500;

export const STATIC_GOOGLE_REDIRECT_PATTERNS = [
  'https://oauth-redirect.googleusercontent.com/r/*',
  'https://oauth-redirect.googleusercontent.com/a/*',
  'https://oauth-redirect-sandbox.googleusercontent.com/*',
  'https://oauth-redirect-test.googleusercontent.com/*',
  'https://vertexaisearch.cloud.google.com/oauth-redirect',
] as const;

/**
 * Validates redirect URIs against Google Gemini Connected Apps, loopback, and configured hosts.
 */
export function isAllowedRedirectUri(uri: string, allowedHosts: string[]): boolean {
  if (!uri || uri.includes('#') || uri.includes('*') || uri.includes('\\')) return false;
  if (/[\s\x00-\x1f\x7f]/.test(uri)) return false;

  const schemeEnd = uri.indexOf('://');
  if (schemeEnd <= 0) return false;
  const afterScheme = uri.slice(schemeEnd + 3);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (!authority || authority.includes('@')) return false;

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') return false;
  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname.includes('%')) return false;

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return protocol === 'http:' || protocol === 'https:';
  }

  if (protocol !== 'https:') return false;

  const rawPathAndQuery = authorityEnd === -1 ? '' : afterScheme.slice(authorityEnd);
  const queryStart = rawPathAndQuery.indexOf('?');
  const rawPath = queryStart === -1 ? rawPathAndQuery : rawPathAndQuery.slice(0, queryStart);
  const hasEncodedTraversal = /%2e|%2f|%5c/i.test(rawPath) || rawPath.includes('..');

  if (hostname === 'oauth-redirect.googleusercontent.com') {
    if (hasEncodedTraversal) return false;
    return parsed.pathname.startsWith('/r/') || parsed.pathname.startsWith('/a/');
  }

  if (
    hostname === 'oauth-redirect-sandbox.googleusercontent.com' ||
    hostname === 'oauth-redirect-test.googleusercontent.com'
  ) {
    return true;
  }

  if (hostname === 'vertexaisearch.cloud.google.com') {
    if (hasEncodedTraversal) return false;
    return (
      parsed.pathname === '/oauth-redirect' || parsed.pathname.startsWith('/oauth-redirect/')
    );
  }

  const normalizedHosts = allowedHosts.map((h) => h.trim().toLowerCase());
  return normalizedHosts.includes(hostname);
}

export function matchRegisteredRedirectUri(
  requestedUri: string,
  registeredUris: string[],
  allowedHosts: string[],
): boolean {
  if (!isAllowedRedirectUri(requestedUri, allowedHosts)) return false;
  for (const pattern of registeredUris) {
    if (pattern === requestedUri) return true;
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (requestedUri.startsWith(prefix)) return true;
    }
  }
  return false;
}

export function ensureStaticClient(config: AppConfig, store: GatewayStore): void {
  store.retireStaleStaticClients(config.oauthStaticClientId);
  if (!config.oauthStaticClientId) return;

  store.upsertStaticClient({
    client_id: config.oauthStaticClientId,
    client_secret_hash: config.oauthStaticClientSecret
      ? hashToken(config.oauthStaticClientSecret)
      : null,
    client_name: 'Static Fallback Client',
    redirect_uris: [...STATIC_GOOGLE_REDIRECT_PATTERNS],
  });
}

export function createDcrRoutes(config: AppConfig, store: GatewayStore): Hono {
  const app = new Hono();

  app.post('/oauth/register', async (c) => {
    const rawText = await c.req.text();
    if (Buffer.byteLength(rawText, 'utf8') > 65536) {
      return c.json(
        { error: 'invalid_request', error_description: 'Request body exceeds 64KB limit' },
        413,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      return c.json(
        { error: 'invalid_client_metadata', error_description: 'Body must be valid JSON' },
        400,
      );
    }

    const dynamicCount = store.listOAuthClients().filter((x) => !x.is_static).length;
    if (dynamicCount >= MAX_DYNAMIC_CLIENTS) {
      return c.json(
        { error: 'too_many_requests', error_description: 'Dynamic client limit reached' },
        429,
      );
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json(
        { error: 'invalid_client_metadata', error_description: 'Metadata must be a JSON object' },
        400,
      );
    }

    const payload = body as Record<string, unknown>;
    if (!Array.isArray(payload.redirect_uris) || payload.redirect_uris.length === 0) {
      return c.json(
        { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be non-empty' },
        400,
      );
    }
    if (payload.redirect_uris.length > MAX_DCR_REDIRECT_URIS) {
      return c.json(
        {
          error: 'invalid_redirect_uri',
          error_description: `At most ${MAX_DCR_REDIRECT_URIS} redirect_uris allowed`,
        },
        400,
      );
    }

    const redirectUris: string[] = [];
    for (const item of payload.redirect_uris) {
      if (typeof item !== 'string' || !isAllowedRedirectUri(item, config.oauthAllowedRedirectHosts)) {
        return c.json(
          { error: 'invalid_redirect_uri', error_description: `Disallowed redirect_uri: ${String(item)}` },
          400,
        );
      }
      redirectUris.push(item);
    }

    const authMethod = payload.token_endpoint_auth_method ?? 'none';
    if (authMethod !== 'none' && authMethod !== 'client_secret_post') {
      return c.json(
        { error: 'invalid_client_metadata', error_description: 'Unsupported token_endpoint_auth_method' },
        400,
      );
    }

    const clientName =
      typeof payload.client_name === 'string' && payload.client_name.trim()
        ? payload.client_name.trim().slice(0, 200)
        : 'MCP OAuth Client';

    const clientId = generateId('dcr', 16);
    const clientSecret = authMethod === 'client_secret_post' ? generateRandomToken(32) : undefined;
    const createdAt = Date.now();

    store.createOAuthClient({
      client_id: clientId,
      client_secret_hash: clientSecret ? hashToken(clientSecret) : null,
      client_name: clientName,
      redirect_uris: redirectUris,
      is_static: false,
      created_at: createdAt,
    });

    store.recordAudit({
      actor: 'oauth_dcr',
      action: 'oauth_client_register',
      target: clientId,
      status: 'success',
      details: { clientName, redirectCount: redirectUris.length },
    });

    const response: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: Math.floor(createdAt / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: authMethod,
    };
    if (clientSecret) {
      response.client_secret = clientSecret;
      response.client_secret_expires_at = 0;
    }

    return c.json(response, 201, { 'Cache-Control': 'no-store' });
  });

  return app;
}
