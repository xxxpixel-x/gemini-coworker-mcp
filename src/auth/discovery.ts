import { Hono } from 'hono';
import type { AppConfig } from '../types.js';

export const DEFAULT_SCOPES_SUPPORTED = ['mcp:tools', 'mcp:read', 'mcp:write'] as const;

export function getCanonicalResource(publicDomain: string): string {
  return `${publicDomain.replace(/\/+$/, '')}/mcp`;
}

export function isValidResource(resource: string, publicDomain: string): boolean {
  const base = publicDomain.replace(/\/+$/, '');
  return resource === base || resource === `${base}/mcp`;
}

export function buildProtectedResourceMetadata(config: AppConfig): Record<string, unknown> {
  const base = config.publicDomain.replace(/\/+$/, '');
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [...DEFAULT_SCOPES_SUPPORTED],
  };
}

export function buildAuthorizationServerMetadata(config: AppConfig): Record<string, unknown> {
  const base = config.publicDomain.replace(/\/+$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...DEFAULT_SCOPES_SUPPORTED],
  };
}

export function createDiscoveryRoutes(config: AppConfig): Hono {
  const app = new Hono();

  app.get('/.well-known/oauth-protected-resource', (c) =>
    c.json(buildProtectedResourceMetadata(config), 200, { 'Cache-Control': 'no-store' }),
  );

  app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
    c.json(buildProtectedResourceMetadata(config), 200, { 'Cache-Control': 'no-store' }),
  );

  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json(buildAuthorizationServerMetadata(config), 200, { 'Cache-Control': 'no-store' }),
  );

  return app;
}
