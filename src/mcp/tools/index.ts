import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolRegistry } from '../registry.js';
import type { McpToolContext } from './context.js';
import { registerDesktopAndGithubTools } from './desktopGithubTools.js';
import { registerExecAgentTools } from './execAgentTools.js';
import { registerGeminiHubTools } from './geminiHubTools.js';
import { registerGeminiReviewTools } from './geminiReviewTools.js';
import { registerWorkspaceTools } from './workspaceTools.js';

export type { McpToolContext } from './context.js';

export function buildToolRegistry(ctx: McpToolContext): McpToolRegistry {
  const registry = new McpToolRegistry({
    trustSandboxHints: ctx.config.trustSandboxHints,
  });

  if (ctx.config.toolProfile === 'full') {
    registerWorkspaceTools(registry, ctx);
    registerExecAgentTools(registry, ctx);
    registerDesktopAndGithubTools(registry, ctx);
  }

  registerGeminiReviewTools(registry, ctx);
  registerGeminiHubTools(registry, ctx);

  return registry;
}

export function registerAllTools(server: McpServer, ctx: McpToolContext): McpToolRegistry {
  const registry = buildToolRegistry(ctx);
  registry.attachToServer(server);
  return registry;
}
