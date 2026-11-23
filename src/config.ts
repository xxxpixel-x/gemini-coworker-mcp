import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import type { AgentDriverName, AppConfig, AuthMode, ToolProfile, TransportMode } from './types.js';

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseIntBounded(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (!value || value.trim() === '') return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveCanonicalPath(target: string): string {
  const resolved = path.resolve(target);
  try {
    if (fs.existsSync(resolved)) {
      return fs.realpathSync(resolved);
    }
  } catch {
    // fall through
  }
  return resolved;
}

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  MCP_TRANSPORT: z.enum(['stdio', 'http']).optional(),
  HOST: z.string().optional(),
  PORT: z.string().optional(),
  PUBLIC_DOMAIN: z.string().optional(),
  AUTH_MODE: z.enum(['none', 'bearer', 'oauth']).optional(),
  MCP_BEARER_TOKEN: z.string().optional(),
  OAUTH_SIGNING_SECRET: z.string().optional(),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  OAUTH_ALLOWED_REDIRECT_HOSTS: z.string().optional(),
  OAUTH_STATIC_CLIENT_ID: z.string().optional(),
  OAUTH_STATIC_CLIENT_SECRET: z.string().optional(),
  OAUTH_ACCESS_TOKEN_TTL_SEC: z.string().optional(),
  OAUTH_REFRESH_TOKEN_TTL_SEC: z.string().optional(),
  OAUTH_REFRESH_GRACE_SEC: z.string().optional(),
  TRUST_CF_CONNECTING_IP: z.string().optional(),
  DATA_DIR: z.string().optional(),
  DATABASE_PATH: z.string().optional(),
  ALLOWED_WORKSPACE_ROOTS: z.string().optional(),
  TOOL_PROFILE: z.enum(['full', 'gemini_only']).optional(),
  MCP_TRUST_SANDBOX_HINTS: z.string().optional(),
  INLINE_OUTPUT_MAX_BYTES: z.string().optional(),
  DEFAULT_AGENT_DRIVER: z.enum(['codex', 'claude_code', 'opencode']).optional(),
  AGENT_MAX_DURATION_SEC: z.string().optional(),
  ENABLE_DESKTOP_CONTROL: z.string().optional(),
  GEMINI_DESKTOP_MODE: z.enum(['interactive', 'isolated']).optional(),
  ENABLE_DESKTOP_POWERSHELL: z.string().optional(),
  GH_TOKEN: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  CODEX_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
});

const DEFAULT_REDIRECT_HOSTS = [
  'gemini.google.com',
  'aistudio.google.com',
  'accounts.google.com',
  'claude.ai',
  'chatgpt.com',
];

export function loadConfig(
  rawEnv: Record<string, string | undefined> = process.env,
  overrides: { transport?: TransportMode; toolProfile?: ToolProfile } = {},
): AppConfig {
  const env = envSchema.parse(rawEnv);
  const nodeEnv = env.NODE_ENV?.trim() || 'development';
  const transport: TransportMode = overrides.transport ?? env.MCP_TRANSPORT ?? 'http';
  const host = env.HOST?.trim() || '127.0.0.1';
  const port = parseIntBounded(env.PORT, 8787, 1, 65535);
  const publicDomain = (env.PUBLIC_DOMAIN?.trim() || `http://${host}:${port}`).replace(/\/+$/, '');
  const authMode: AuthMode = env.AUTH_MODE ?? 'none';

  const isLoopbackHost = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (transport === 'http' && authMode === 'none' && !isLoopbackHost) {
    throw new Error(
      `Refusing to start HTTP server with AUTH_MODE=none on non-loopback HOST="${host}". Use HOST=127.0.0.1 or set AUTH_MODE=bearer|oauth.`,
    );
  }

  const bearerToken = env.MCP_BEARER_TOKEN?.trim() || undefined;
  if (transport === 'http' && authMode === 'bearer') {
    if (!bearerToken || bearerToken.length < 16) {
      throw new Error('AUTH_MODE=bearer requires MCP_BEARER_TOKEN (at least 16 characters).');
    }
  }

  const oauthSigningSecret = env.OAUTH_SIGNING_SECRET?.trim() || undefined;
  const adminPasswordHash = env.ADMIN_PASSWORD_HASH?.trim() || undefined;
  if (transport === 'http' && authMode === 'oauth') {
    if (!oauthSigningSecret || oauthSigningSecret.length < 32) {
      throw new Error('AUTH_MODE=oauth requires OAUTH_SIGNING_SECRET (>= 32 characters).');
    }
    if (!adminPasswordHash) {
      throw new Error('AUTH_MODE=oauth requires ADMIN_PASSWORD_HASH.');
    }
  }

  const dataDir = path.resolve(env.DATA_DIR?.trim() || fileURLToPath(new URL('../.data', import.meta.url)));
  const artifactsDir = path.join(dataDir, 'artifacts');
  const databasePath = env.DATABASE_PATH?.trim()
    ? env.DATABASE_PATH.trim() === ':memory:'
      ? ':memory:'
      : path.resolve(env.DATABASE_PATH.trim())
    : path.join(dataDir, 'gateway.db');

  const configuredRoots = parseCsv(env.ALLOWED_WORKSPACE_ROOTS);
  const allowedWorkspaceRoots = (
    configuredRoots.length > 0 ? configuredRoots : [process.cwd()]
  ).map((root) => resolveCanonicalPath(root));

  const redirectHosts = parseCsv(env.OAUTH_ALLOWED_REDIRECT_HOSTS);
  const toolProfile: ToolProfile = overrides.toolProfile ?? env.TOOL_PROFILE ?? 'full';

  return {
    nodeEnv,
    transport,
    host,
    port,
    publicDomain,
    authMode,
    bearerToken,
    oauthSigningSecret,
    adminPasswordHash,
    oauthAllowedRedirectHosts: redirectHosts.length > 0 ? redirectHosts : DEFAULT_REDIRECT_HOSTS,
    oauthStaticClientId: env.OAUTH_STATIC_CLIENT_ID?.trim() || undefined,
    oauthStaticClientSecret: env.OAUTH_STATIC_CLIENT_SECRET?.trim() || undefined,
    oauthAccessTokenTtlSec: parseIntBounded(env.OAUTH_ACCESS_TOKEN_TTL_SEC, 3600, 60, 86400),
    oauthRefreshTokenTtlSec: parseIntBounded(
      env.OAUTH_REFRESH_TOKEN_TTL_SEC,
      2592000,
      300,
      31536000,
    ),
    oauthRefreshGraceSec: parseIntBounded(env.OAUTH_REFRESH_GRACE_SEC, 60, 0, 600),
    trustCfConnectingIp: parseBool(env.TRUST_CF_CONNECTING_IP, false),
    dataDir,
    artifactsDir,
    databasePath,
    allowedWorkspaceRoots,
    toolProfile,
    trustSandboxHints: parseBool(env.MCP_TRUST_SANDBOX_HINTS, true),
    inlineOutputMaxBytes: parseIntBounded(env.INLINE_OUTPUT_MAX_BYTES, 60000, 4096, 512000),
    defaultAgentDriver: (env.DEFAULT_AGENT_DRIVER ?? 'codex') as AgentDriverName,
    agentMaxDurationSec: parseIntBounded(env.AGENT_MAX_DURATION_SEC, 600, 15, 3600),
    enableDesktopControl: parseBool(env.ENABLE_DESKTOP_CONTROL, true),
    geminiDesktopMode: env.GEMINI_DESKTOP_MODE ?? 'interactive',
    enableDesktopPowershell: parseBool(env.ENABLE_DESKTOP_POWERSHELL, false),
    ghToken: env.GH_TOKEN?.trim() || undefined,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
    codexApiKey: env.CODEX_API_KEY?.trim() || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
  };
}
