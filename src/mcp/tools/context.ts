import type { DesktopGateway } from '../../core/desktopGateway.js';
import type { JobRunnerService } from '../../core/agentRunner.js';
import type { WorkspaceLockManager } from '../../core/workspaceSecurity.js';
import type { GatewayStore } from '../../db/sqlite.js';
import type { AppConfig, WorkspaceRecord } from '../../types.js';
import type { SecretScrubber } from '../../utils/secretScrubber.js';

export interface McpToolContext {
  config: AppConfig;
  store: GatewayStore;
  scrubber: SecretScrubber;
  locks: WorkspaceLockManager;
  runner: JobRunnerService;
  desktop: DesktopGateway;
}

export function requireWorkspace(ctx: McpToolContext, slug: string): WorkspaceRecord {
  const ws = ctx.store.getWorkspace(slug);
  if (!ws) {
    throw new Error(
      `Workspace "${slug}" is not registered. Call workspace_manage(action="list") or workspace_manage(action="register", slug="${slug}", path="<dir>") first.`,
    );
  }
  return ws;
}
