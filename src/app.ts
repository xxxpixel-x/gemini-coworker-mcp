import { Hono } from 'hono';
import { DesktopGateway, WindowsGeminiDesktop, type DesktopAdapter } from './core/desktopGateway.js';
import { createMcpAuthMiddleware, createOAuthApp } from './auth/oauth.js';
import { JobRunnerService } from './core/agentRunner.js';
import { WorkspaceLockManager } from './core/workspaceSecurity.js';
import { GatewayStore } from './db/sqlite.js';
import {
  createMcpHttpHandler,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from './mcp/server.js';
import { buildToolRegistry, type McpToolContext } from './mcp/tools/index.js';
import type { AppConfig, OAuthAuthContext } from './types.js';
import { SecretScrubber } from './utils/secretScrubber.js';

export interface GatewayRuntime {
  app: Hono<{ Variables: { oauthAuth?: OAuthAuthContext } }>;
  ctx: McpToolContext;
  toolNames: string[];
  shutdown: () => Promise<void>;
}

export interface GatewayRuntimeOptions {
  desktopAdapter?: DesktopAdapter;
}

export function createGatewayRuntime(
  config: AppConfig,
  options: GatewayRuntimeOptions = {},
): GatewayRuntime {
  const store = new GatewayStore(config.databasePath);
  store.reconcileOrphanJobs();

  const scrubber = new SecretScrubber(config);
  const locks = new WorkspaceLockManager();
  const runner = new JobRunnerService(config, store, scrubber);

  const ctx: McpToolContext = {
    config,
    store,
    scrubber,
    locks,
    runner,
    desktop: new DesktopGateway(store, options.desktopAdapter ?? new WindowsGeminiDesktop(store, config.geminiDesktopMode), scrubber, config.enableDesktopControl),
  };

  const toolNames = buildToolRegistry(ctx).listToolNames();
  const app = new Hono<{ Variables: { oauthAuth?: OAuthAuthContext } }>();

  app.get('/healthz', (c) => {
    const ok = store.ping();
    return c.json(
      {
        status: ok ? 'ok' : 'degraded',
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
        auth_mode: config.authMode,
        tool_profile: config.toolProfile,
        tools: toolNames.length,
      },
      ok ? 200 : 503,
    );
  });

  app.get('/', (c) => {
    const mcpUrl = `${config.publicDomain.replace(/\/+$/, '')}/mcp`;
    if ((c.req.header('accept') ?? '').includes('application/json')) {
      return c.json({
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
        mcp_endpoint: mcpUrl,
        auth_mode: config.authMode,
        tools: toolNames,
      });
    }
    return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${MCP_SERVER_NAME}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 32px 16px; }
    .wrap { max-width: 720px; margin: 0 auto; background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 1.5rem; }
    code { background: #0f172a; padding: 3px 8px; border-radius: 6px; color: #38bdf8; }
    .badges { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .badge { background: #0f172a; border: 1px solid #334155; padding: 6px 10px; border-radius: 8px; font-size: 0.85rem; }
    a { color: #60a5fa; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${MCP_SERVER_NAME} <small style="color:#94a3b8">v${MCP_SERVER_VERSION}</small></h1>
    <p>Local-first Windows MCP gateway (Stdio + Stateless Streamable HTTP + Gemini OAuth 2.1 DCR).</p>
    <p><strong>MCP Endpoint:</strong> <code>${mcpUrl}</code></p>
    <p><strong>Auth Mode:</strong> <code>${config.authMode}</code></p>
    ${
      config.authMode === 'oauth'
        ? `<p><strong>OAuth Discovery:</strong> <a href="/.well-known/oauth-protected-resource">/.well-known/oauth-protected-resource</a> · <a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a></p>`
        : ''
    }
    <h3>Registered Tools (${toolNames.length})</h3>
    <div class="badges">${toolNames.map((t) => `<span class="badge">${t}</span>`).join('')}</div>
  </div>
</body>
</html>`);
  });

  if (config.authMode === 'oauth') {
    app.route('/', createOAuthApp(config, store));
  }

  app.use('/mcp', createMcpAuthMiddleware(config, store));
  app.all('/mcp', createMcpHttpHandler(ctx));

  const shutdown = async () => {
    await ctx.desktop.close();
    await runner.cancelAllActiveJobs();
    store.close();
  };

  return { app, ctx, toolNames, shutdown };
}
