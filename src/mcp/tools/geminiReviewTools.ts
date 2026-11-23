import { desktopTurnFields, desktopAnnotations, desktopGuard, runTurn } from './desktopTurn.js';
import { z } from 'zod';
import { prepareGeminiReview } from '../../core/geminiReview.js';
import type { McpToolRegistry } from '../registry.js';
import { requireWorkspace, type McpToolContext } from './context.js';

export function registerGeminiReviewTools(
  registry: McpToolRegistry,
  ctx: McpToolContext,
): void {
  registry.register({
    name: 'gemini_review',
    title: 'Synchronous Gemini Specialist Reviewer',
    description:
      'Ask Gemini for a synchronous second-opinion review (`code_review`, `security_audit`, `debug_root_cause`, or `arch_review`) on git diffs, workspace/absolute files, or inline code. Returns a `session_id` so the calling agent can follow up after fixes.',
    inputSchema: {
      mode: z
        .enum(['code_review', 'security_audit', 'debug_root_cause', 'arch_review'])
        .optional()
        .describe('Specialist review mode (default: code_review)'),
      workspace_slug: z
        .string()
        .optional()
        .describe('Registered workspace slug (needed for git diff or relative file paths)'),
      include_git_diff: z
        .boolean()
        .optional()
        .describe('Include workspace git diff (defaults to true when workspace_slug is set and files/code are omitted)'),
      staged: z.boolean().optional().describe('Use staged diff (`git diff --cached`)'),
      base_ref: z.string().optional().describe('Optional git base ref for diff (e.g. "HEAD~1" or "main")'),
      files: z
        .array(z.string().min(1))
        .max(20)
        .optional()
        .describe('File paths to review (workspace-relative with workspace_slug, or absolute paths inside ALLOWED_WORKSPACE_ROOTS)'),
      code: z
        .string()
        .optional()
        .describe('Optional raw code or diff snippet to review directly'),
      focus: z
        .string()
        .optional()
        .describe('Review focus areas (e.g. "security, race conditions, performance")'),
      question: z
        .string()
        .optional()
        .describe('Specific question or concern for Gemini to address'),
      ...desktopTurnFields,
    },
    annotations: desktopAnnotations, preserveAnnotations: true, requiredScope: 'write',
    guard: desktopGuard(ctx, 'gemini_review'),
    handler: (args, extra) => runTurn(ctx, extra, 'gemini_review', args, args.focus || 'Code review',
      async send => {
        const ws = args.workspace_slug ? requireWorkspace(ctx, args.workspace_slug) : undefined;
        const prompt = await prepareGeminiReview(ctx, { workspaceRoot: ws?.root_path,
          includeGitDiff: args.include_git_diff, staged: args.staged, baseRef: args.base_ref,
          files: args.files, code: args.code, mode: args.mode, focus: args.focus, question: args.question });
        return send(prompt);
      }),
  });
}
