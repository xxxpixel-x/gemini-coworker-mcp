import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpHandlerExtraLike } from '../outputGuard.js';
import type { McpToolContext } from './context.js';
import type { DesktopGateway } from '../../core/desktopGateway.js';

export const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const desktopTurnFields = {
  request_id: requestIdSchema.optional().describe('Reuse this ID for retries. Supply it before a long request.'),
  session_id: z.string().regex(/^MCP-[A-Za-z0-9_-]{1,64}$/).optional().describe('Dedicated desktop chat returned by gemini_desktop_status.'),
};
export const desktopAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
export function desktopGuard(ctx: McpToolContext, label: string) {
  return { label, scrubber: ctx.scrubber, artifactsDir: ctx.config.artifactsDir, maxBytes: ctx.config.inlineOutputMaxBytes };
}
export async function runTurn(ctx: McpToolContext, extra: McpHandlerExtraLike, tool: string,
  args: { request_id?: string; session_id?: string }, title: string, work: Parameters<DesktopGateway['run']>[1], returnImmediately = false) {
  const requestId = args.request_id ?? randomUUID();
  const caller = extra.authInfo?.clientId ?? 'local';
  const background = tool === 'gemini_run_task';
  const signal = !background && extra.signal instanceof AbortSignal ? extra.signal : undefined;
  const operation = ctx.desktop.run({ requestId, session: args.session_id, tool, title, args, caller, signal }, work);
  if (background && returnImmediately) {
    return ctx.desktop.result(requestId, caller, 0, ctx.config.inlineOutputMaxBytes);
  } else if (background) {
    // Long tasks outlive the MCP host's initial RPC deadline.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([operation, new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000); })]);
    } finally {
      clearTimeout(timer);
    }
  } else {
    await operation;
  }
  return ctx.desktop.result(requestId, caller, 0, ctx.config.inlineOutputMaxBytes);
}
