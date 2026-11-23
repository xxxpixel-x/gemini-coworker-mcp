import { z } from 'zod';
import { loadScrubbedTextFiles } from '../../core/geminiClient.js';
import { runWorkspaceTask, taskPermissions } from '../../core/desktopTask.js';
import type { McpToolRegistry } from '../registry.js';
import { requireWorkspace, type McpToolContext } from './context.js';
import { desktopAnnotations, desktopGuard, desktopTurnFields, requestIdSchema, runTurn } from './desktopTurn.js';

export function registerGeminiHubTools(registry: McpToolRegistry, ctx: McpToolContext): void {
  registry.register({
    name: 'gemini_desktop_status',
    title: 'Gemini Desktop Status and Request Results',
    description: 'Check installation and eligible chat windows, inspect a request, read more reply text, or cancel a queued request.',
    inputSchema: { request_id: requestIdSchema.optional(), offset: z.number().int().nonnegative().optional(),
      cancel: z.boolean().optional() },
    requiredScope: args => args.cancel ? 'write' : 'read',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, preserveAnnotations: true,
    guard: desktopGuard(ctx, 'gemini_desktop_status'),
    handler: async (args, extra) => {
      if (!args.request_id) {
        if (args.cancel || args.offset) throw new Error('request_id is required.');
        return ctx.desktop.inspect();
      }
      const caller = extra.authInfo?.clientId ?? 'local';
      if (args.cancel) ctx.desktop.cancel(args.request_id, caller);
      return ctx.desktop.result(args.request_id, caller, args.offset, ctx.config.inlineOutputMaxBytes);
    },
  });
  registry.register({
    name: 'gemini_chat', title: 'Chat with Gemini Desktop',
    description: 'Send text and optional locally scrubbed files to a dedicated Gemini desktop conversation.',
    inputSchema: { ...desktopTurnFields, message: z.string().min(1), title: z.string().optional(),
      system_instruction: z.string().optional(), workspace_slug: z.string().optional(),
      files: z.array(z.string().min(1)).max(20).optional() },
    requiredScope: 'write', annotations: desktopAnnotations, preserveAnnotations: true,
    guard: desktopGuard(ctx, 'gemini_chat'),
    handler: (args, extra) => runTurn(ctx, extra, 'gemini_chat', args, args.title || args.message,
      async send => {
        const root = args.workspace_slug ? requireWorkspace(ctx, args.workspace_slug).root_path : undefined;
        const { textBlock } = loadScrubbedTextFiles(ctx, args.files ?? [], root);
        return send([args.system_instruction, args.message, textBlock].filter(Boolean).join('\n\n'));
      }),
  });
  registry.register({
    name: 'gemini_run_task', title: 'Delegate a Task to Gemini Desktop',
    description: 'Delegate to Gemini Desktop. Set return_immediately=true to keep chatting with the user. Return the request ID, then use gemini_desktop_status when the user wants the result. Reuse the dedicated session_id for subsequent tasks.',
    inputSchema: { ...desktopTurnFields, request_id: requestIdSchema, objective: z.string().min(1),
      workspace_slug: z.string().optional(), permissions: taskPermissions.optional(),
      return_immediately: z.boolean().optional().describe('Return a request ID without waiting for Gemini. Defaults to true on the isolated desktop.') },
    requiredScope: 'write', annotations: { ...desktopAnnotations, destructiveHint: true }, preserveAnnotations: true,
    guard: desktopGuard(ctx, 'gemini_run_task'),
    handler: (args, extra) => {
      if (args.permissions && !args.workspace_slug) throw new Error('Workspace permissions require workspace_slug.');
      const ws = args.workspace_slug ? requireWorkspace(ctx, args.workspace_slug) : undefined;
      const { return_immediately, ...task } = args;
      return runTurn(ctx, extra, 'gemini_run_task', task, task.objective, (send,signal) =>
        ws && task.permissions ? runWorkspaceTask(ctx, ws, task.objective, task.permissions, send, signal) : send(task.objective),
        return_immediately ?? ctx.config.geminiDesktopMode === 'isolated');
    },
  });
  // 5. gemini_sessions: Manage persistent Gemini sessions & inspect token usage
  registry.register({
    name: 'gemini_sessions',
    title: 'Gemini Sessions & Token Usage Manager',
    description:
      'List, inspect, or delete persistent Gemini chat/review sessions, or inspect historic API usage. Desktop does not expose token counts.',
    inputSchema: {
      action: z.enum(['list', 'get', 'delete', 'usage']),
      session_id: z.string().optional().describe('Session ID (required for get / delete)'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    requiredScope: (args) => (args.action === 'delete' ? 'write' : 'read'),
    guard: desktopGuard(ctx, 'gemini_sessions'),
    handler: async (args, extra) => {
      const caller = extra.authInfo?.clientId ?? 'local';
      if (args.session_id && !ctx.desktop.ownsSession(args.session_id, caller)) throw new Error('Unknown session.');
      switch (args.action) {
        case 'list':
          return JSON.stringify({ sessions: ctx.store.listGeminiSessions(args.limit ?? 30).filter(s => ctx.desktop.ownsSession(s.session_id, caller)) }, null, 2);

        case 'get': {
          if (!args.session_id) throw new Error('session_id is required for action="get".');
          const session = ctx.store.getGeminiSession(args.session_id);
          if (!session) throw new Error(`Gemini session "${args.session_id}" not found.`);
          const messages = ctx.store.getGeminiMessages(args.session_id, args.limit ?? 50);
          return JSON.stringify({ session, messages }, null, 2);
        }

        case 'delete': {
          if (!args.session_id) throw new Error('session_id is required for action="delete".');
          const deleted = ctx.desktop.forgetSession(args.session_id, caller);
          return JSON.stringify({ session_id: args.session_id, deleted }, null, 2);
        }

        case 'usage':
          return JSON.stringify(ctx.store.getGeminiUsageSummary(), null, 2);
      }
    },
  });
}
