import { Hono, type MiddlewareHandler } from 'hono';
import type { GatewayStore } from '../db/sqlite.js';
import type { AppConfig, OAuthAuthContext } from '../types.js';
import {
  computeS256Challenge,
  generateId,
  generateRandomToken,
  hashToken,
  safeEqual,
  verifyPassword,
} from './crypto.js';
import { createDcrRoutes, ensureStaticClient, matchRegisteredRedirectUri } from './dcr.js';
import {
  createDiscoveryRoutes,
  DEFAULT_SCOPES_SUPPORTED,
  getCanonicalResource,
  isValidResource,
} from './discovery.js';

const MAX_STATE_BYTES = 8192;
const AUTH_REQ_TTL_MS = 10 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAuthorizePage(params: {
  authReqId: string;
  csrfToken: string;
  clientName: string;
  scope: string;
  resource: string;
  error?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Authorize Gemini Coworker</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { width: 100%; max-width: 420px; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; box-shadow: 0 16px 40px rgba(0,0,0,0.4); }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { font-size: 0.9rem; color: #94a3b8; margin: 6px 0; }
    .meta { background: #0f172a; padding: 12px; border-radius: 8px; margin: 14px 0; font-size: 0.85rem; }
    .err { background: #7f1d1d; color: #fecaca; padding: 10px 12px; border-radius: 8px; margin: 12px 0; font-size: 0.85rem; }
    label { display: block; font-size: 0.85rem; margin: 12px 0 6px; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #f8fafc; font-size: 0.95rem; }
    .actions { display: flex; gap: 10px; margin-top: 16px; }
    button { flex: 1; padding: 10px 14px; border: 0; border-radius: 8px; font-weight: 600; cursor: pointer; }
    .approve { background: #2563eb; color: #fff; }
    .deny { background: #334155; color: #e2e8f0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize MCP Client</h1>
    <p><strong>${escapeHtml(params.clientName)}</strong> requests access to your local Gemini Coworker gateway.</p>
    <div class="meta">
      <div><strong>Resource:</strong> ${escapeHtml(params.resource)}</div>
      <div><strong>Scope:</strong> ${escapeHtml(params.scope)}</div>
    </div>
    ${params.error ? `<div class="err">${escapeHtml(params.error)}</div>` : ''}
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="auth_req_id" value="${escapeHtml(params.authReqId)}" />
      <input type="hidden" name="csrf_token" value="${escapeHtml(params.csrfToken)}" />
      <label for="password">Operator Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
      <div class="actions">
        <button class="approve" type="submit" name="decision" value="approve">Approve</button>
        <button class="deny" type="submit" name="decision" value="deny" formnovalidate>Deny</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

function redirectWithParams(baseUri: string, params: Record<string, string | null | undefined>): Response {
  const url = new URL(baseUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined) {
      url.searchParams.set(k, v);
    }
  }
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), 'Cache-Control': 'no-store' },
  });
}

function normalizeScope(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return 'mcp:tools';
  const allowed = new Set<string>(DEFAULT_SCOPES_SUPPORTED);
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'mcp:tools';
  for (const p of parts) {
    if (!allowed.has(p)) return null;
  }
  return Array.from(new Set(parts)).join(' ');
}

export function createOAuthApp(config: AppConfig, store: GatewayStore): Hono {
  ensureStaticClient(config, store);

  const app = new Hono();
  app.route('/', createDiscoveryRoutes(config));
  app.route('/', createDcrRoutes(config, store));

  app.get('/oauth/authorize', (c) => {
    const clientId = c.req.query('client_id') ?? '';
    const redirectUri = c.req.query('redirect_uri') ?? '';
    const responseType = c.req.query('response_type') ?? '';
    const codeChallenge = c.req.query('code_challenge') ?? '';
    const codeChallengeMethod = c.req.query('code_challenge_method') ?? '';
    const state = c.req.query('state') ?? null;
    const rawScope = c.req.query('scope');
    const rawResource = c.req.query('resource') ?? getCanonicalResource(config.publicDomain);

    const client = store.getOAuthClient(clientId);
    if (!client) {
      return c.text('Unknown client_id', 400);
    }
    if (!matchRegisteredRedirectUri(redirectUri, client.redirect_uris, config.oauthAllowedRedirectHosts)) {
      return c.text('Invalid or unregistered redirect_uri', 400);
    }
    if (state !== null && Buffer.byteLength(state, 'utf8') > MAX_STATE_BYTES) {
      return redirectWithParams(redirectUri, {
        error: 'invalid_request',
        error_description: 'state exceeds 8192 bytes',
      });
    }
    if (responseType !== 'code') {
      return redirectWithParams(redirectUri, {
        error: 'unsupported_response_type',
        state,
      });
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      return redirectWithParams(redirectUri, {
        error: 'invalid_request',
        error_description: 'PKCE S256 is required',
        state,
      });
    }
    if (!isValidResource(rawResource, config.publicDomain)) {
      return redirectWithParams(redirectUri, {
        error: 'invalid_target',
        error_description: 'Invalid resource indicator',
        state,
      });
    }
    const scope = normalizeScope(rawScope);
    if (!scope) {
      return redirectWithParams(redirectUri, {
        error: 'invalid_scope',
        state,
      });
    }

    const authReqId = generateId('areq', 16);
    const csrfToken = generateRandomToken(24);

    store.createAuthRequest({
      auth_req_id: authReqId,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope,
      resource: rawResource,
      csrf_token: csrfToken,
      expires_at: Date.now() + AUTH_REQ_TTL_MS,
      used: false,
    });

    c.header('Cache-Control', 'no-store');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    return c.html(
      renderAuthorizePage({
        authReqId,
        csrfToken,
        clientName: client.client_name,
        scope,
        resource: rawResource,
      }),
    );
  });

  app.post('/oauth/authorize', async (c) => {
    const body = await c.req.parseBody();
    const authReqId = String(body.auth_req_id ?? '');
    const csrfToken = String(body.csrf_token ?? '');
    const password = String(body.password ?? '');
    const decision = String(body.decision ?? 'approve');

    const req = store.getAuthRequest(authReqId);
    if (!req || req.used || req.expires_at < Date.now()) {
      return c.text('Authorization request expired or invalid', 400);
    }
    if (!safeEqual(csrfToken, req.csrf_token)) {
      return c.text('Invalid CSRF token', 403);
    }

    const client = store.getOAuthClient(req.client_id);
    if (!client) return c.text('Unknown client', 400);

    if (decision === 'deny') {
      store.markAuthRequestUsed(req.auth_req_id);
      return redirectWithParams(req.redirect_uri, {
        error: 'access_denied',
        state: req.state,
      });
    }

    const allowPlain = config.nodeEnv !== 'production';
    const passwordValid =
      Boolean(config.adminPasswordHash) &&
      verifyPassword(password, config.adminPasswordHash!, allowPlain);

    if (!passwordValid) {
      const nextCsrf = generateRandomToken(24);
      store.rotateAuthRequestCsrf(req.auth_req_id, nextCsrf);
      c.header('Cache-Control', 'no-store');
      c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      return c.html(
        renderAuthorizePage({
          authReqId: req.auth_req_id,
          csrfToken: nextCsrf,
          clientName: client.client_name,
          scope: req.scope,
          resource: req.resource,
          error: 'Invalid password. Please try again.',
        }),
        401,
      );
    }

    if (!store.markAuthRequestUsed(req.auth_req_id)) {
      return c.text('Authorization request already consumed', 400);
    }

    const code = generateRandomToken(32);
    store.createAuthCode({
      code,
      client_id: req.client_id,
      redirect_uri: req.redirect_uri,
      code_challenge: req.code_challenge,
      scope: req.scope,
      resource: req.resource,
      expires_at: Date.now() + AUTH_CODE_TTL_MS,
      used: false,
      token_family_id: null,
    });

    store.recordAudit({
      actor: 'operator',
      action: 'oauth_authorize_approve',
      target: req.client_id,
      status: 'success',
    });

    return redirectWithParams(req.redirect_uri, {
      code,
      state: req.state,
    });
  });

  app.post('/oauth/token', async (c) => {
    const form = await c.req.parseBody();
    const grantType = String(form.grant_type ?? '');
    const clientId = String(form.client_id ?? '');
    const clientSecret = form.client_secret ? String(form.client_secret) : undefined;

    const client = store.getOAuthClient(clientId);
    if (!client) {
      return c.json({ error: 'invalid_client' }, 401, { 'Cache-Control': 'no-store' });
    }
    if (client.client_secret_hash) {
      if (!clientSecret || !safeEqual(hashToken(clientSecret), client.client_secret_hash)) {
        return c.json({ error: 'invalid_client' }, 401, { 'Cache-Control': 'no-store' });
      }
    }

    if (grantType === 'authorization_code') {
      const code = String(form.code ?? '');
      const redirectUri = String(form.redirect_uri ?? '');
      const codeVerifier = String(form.code_verifier ?? '');
      const requestedResource = form.resource ? String(form.resource) : undefined;

      const record = store.getAuthCode(code);
      if (!record) {
        return c.json({ error: 'invalid_grant' }, 400, { 'Cache-Control': 'no-store' });
      }
      if (record.used) {
        // OAuth 2.1 §4.1.2: Replay of authorization code revokes token family
        if (record.token_family_id) {
          store.revokeTokenFamily(record.token_family_id);
        }
        return c.json({ error: 'invalid_grant', error_description: 'Code already used' }, 400, {
          'Cache-Control': 'no-store',
        });
      }
      if (record.expires_at < Date.now()) {
        return c.json({ error: 'invalid_grant', error_description: 'Code expired' }, 400, {
          'Cache-Control': 'no-store',
        });
      }
      if (record.client_id !== clientId || record.redirect_uri !== redirectUri) {
        return c.json({ error: 'invalid_grant' }, 400, { 'Cache-Control': 'no-store' });
      }
      if (requestedResource && requestedResource !== record.resource) {
        return c.json({ error: 'invalid_target' }, 400, { 'Cache-Control': 'no-store' });
      }
      if (!codeVerifier || !safeEqual(computeS256Challenge(codeVerifier), record.code_challenge)) {
        return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400, {
          'Cache-Control': 'no-store',
        });
      }

      const familyId = generateId('fam', 12);
      if (!store.consumeAuthCode(code, familyId)) {
        return c.json({ error: 'invalid_grant' }, 400, { 'Cache-Control': 'no-store' });
      }

      const accessToken = generateRandomToken(32);
      const refreshToken = generateRandomToken(32);
      const now = Date.now();

      store.createToken({
        token_hash: hashToken(accessToken),
        token_type: 'access',
        client_id: client.client_id,
        scope: record.scope,
        resource: record.resource,
        token_family_id: familyId,
        expires_at: now + config.oauthAccessTokenTtlSec * 1000,
        grace_expires_at: null,
      });

      store.createToken({
        token_hash: hashToken(refreshToken),
        token_type: 'refresh',
        client_id: client.client_id,
        scope: record.scope,
        resource: record.resource,
        token_family_id: familyId,
        expires_at: now + config.oauthRefreshTokenTtlSec * 1000,
        grace_expires_at: null,
      });

      return c.json(
        {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: config.oauthAccessTokenTtlSec,
          scope: record.scope,
        },
        200,
        { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      );
    }

    if (grantType === 'refresh_token') {
      const refreshTokenRaw = String(form.refresh_token ?? '');
      const existing = store.getTokenByHash(hashToken(refreshTokenRaw));
      if (!existing || existing.token_type !== 'refresh' || existing.client_id !== clientId) {
        return c.json({ error: 'invalid_grant' }, 400, { 'Cache-Control': 'no-store' });
      }
      const now = Date.now();
      if (existing.revoked || existing.expires_at < now) {
        store.revokeTokenFamily(existing.token_family_id);
        return c.json({ error: 'invalid_grant' }, 400, { 'Cache-Control': 'no-store' });
      }
      if (existing.grace_expires_at !== null && now > existing.grace_expires_at) {
        // Replay outside concurrent grace window -> revoke entire family
        store.revokeTokenFamily(existing.token_family_id);
        return c.json({ error: 'invalid_grant' }, 400, { 'Cache-Control': 'no-store' });
      }

      if (existing.grace_expires_at === null) {
        store.setTokenGraceExpiry(
          existing.token_hash,
          now + config.oauthRefreshGraceSec * 1000,
        );
      }

      const nextAccess = generateRandomToken(32);
      const nextRefresh = generateRandomToken(32);

      store.createToken({
        token_hash: hashToken(nextAccess),
        token_type: 'access',
        client_id: existing.client_id,
        scope: existing.scope,
        resource: existing.resource,
        token_family_id: existing.token_family_id,
        expires_at: now + config.oauthAccessTokenTtlSec * 1000,
        grace_expires_at: null,
      });

      store.createToken({
        token_hash: hashToken(nextRefresh),
        token_type: 'refresh',
        client_id: existing.client_id,
        scope: existing.scope,
        resource: existing.resource,
        token_family_id: existing.token_family_id,
        expires_at: now + config.oauthRefreshTokenTtlSec * 1000,
        grace_expires_at: null,
      });

      return c.json(
        {
          access_token: nextAccess,
          refresh_token: nextRefresh,
          token_type: 'Bearer',
          expires_in: config.oauthAccessTokenTtlSec,
          scope: existing.scope,
        },
        200,
        { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      );
    }

    return c.json({ error: 'unsupported_grant_type' }, 400, { 'Cache-Control': 'no-store' });
  });

  app.post('/oauth/revoke', async (c) => {
    const form = await c.req.parseBody();
    const tokenRaw = String(form.token ?? '');
    if (tokenRaw) {
      const record = store.getTokenByHash(hashToken(tokenRaw));
      if (record) {
        if (record.token_type === 'refresh') {
          store.revokeTokenFamily(record.token_family_id);
        } else {
          store.revokeToken(record.token_hash);
        }
      }
    }
    return c.json({ revoked: true }, 200, { 'Cache-Control': 'no-store' });
  });

  return app;
}

export function createMcpAuthMiddleware(
  config: AppConfig,
  store: GatewayStore,
): MiddlewareHandler<{ Variables: { oauthAuth?: OAuthAuthContext } }> {
  return async (c, next) => {
    if (config.authMode === 'none') {
      await next();
      return;
    }

    const authHeader = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    const token = match?.[1]?.trim();

    if (config.authMode === 'bearer') {
      if (!token || !config.bearerToken || !safeEqual(token, config.bearerToken)) {
        return c.json(
          { error: 'unauthorized', message: 'Valid Bearer token required.' },
          401,
          { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' },
        );
      }
      c.set('oauthAuth', {
        clientId: 'static-bearer',
        scope: 'mcp:tools',
        scopes: ['mcp:tools'],
        resource: getCanonicalResource(config.publicDomain),
      });
      await next();
      return;
    }

    const wwwAuth = `Bearer resource_metadata="${config.publicDomain.replace(/\/+$/, '')}/.well-known/oauth-protected-resource"`;
    if (!token) {
      return c.json({ error: 'unauthorized' }, 401, {
        'WWW-Authenticate': wwwAuth,
        'Cache-Control': 'no-store',
      });
    }

    const record = store.getTokenByHash(hashToken(token));
    if (
      !record ||
      record.token_type !== 'access' ||
      record.revoked ||
      record.expires_at < Date.now() ||
      !isValidResource(record.resource, config.publicDomain)
    ) {
      return c.json({ error: 'invalid_token' }, 401, {
        'WWW-Authenticate': wwwAuth,
        'Cache-Control': 'no-store',
      });
    }

    c.set('oauthAuth', {
      clientId: record.client_id,
      scope: record.scope,
      scopes: record.scope.split(/\s+/).filter(Boolean),
      resource: record.resource,
    });
    await next();
  };
}
