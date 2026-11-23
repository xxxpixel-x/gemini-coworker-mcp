import { z } from 'zod';
import { runDesktopAction } from '../../core/desktopControl.js';
import { inspectGitHub, publishExternalChanges } from '../../core/githubService.js';
import type { McpToolRegistry } from '../registry.js';
import { requireWorkspace, type McpToolContext } from './context.js';

export function registerDesktopAndGithubTools(
  registry: McpToolRegistry,
  ctx: McpToolContext,
): void {
  const baseGuard = (label: string, untrustedSource?: string) => ({
    scrubber: ctx.scrubber,
    artifactsDir: ctx.config.artifactsDir,
    maxBytes: ctx.config.inlineOutputMaxBytes,
    label,
    untrustedSource,
  });

  // Tool #7: desktop_control (Windows desktop automation)
  registry.register({
    name: 'desktop_control',
    title: 'Windows Desktop Automation',
    description:
      'Interact with the local Windows desktop: inspect system_info, read/write clipboard, list open windows, show desktop notifications, open URLs/files/folders, or run PowerShell (when explicitly enabled).',
    inputSchema: {
      action: z.enum([
        'system_info',
        'clipboard_read',
        'clipboard_write',
        'list_windows',
        'notify',
        'open_target',
        'run_powershell',
      ]),
      text: z.string().optional().describe('Clipboard text or notification body'),
      title: z.string().optional().describe('Notification title'),
      target: z.string().optional().describe('URL or existing local file/folder path to open'),
      script: z.string().optional().describe('PowerShell script (requires ENABLE_DESKTOP_POWERSHELL=true)'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    requiredScope: (args) =>
      ['system_info', 'clipboard_read', 'list_windows'].includes(args.action) ? 'read' : 'write',
    guard: baseGuard('desktop_control'),
    handler: async (args) => {
      const output = await runDesktopAction(ctx.config, {
        action: args.action,
        text: args.text,
        title: args.title,
        target: args.target,
        script: args.script,
      });
      ctx.store.recordAudit({
        actor: 'mcp',
        action: `desktop_${args.action}`,
        target: args.target ?? args.action,
        status: 'success',
      });
      return output;
    },
  });

  // Tool #8: github_inspect (read-only with untrusted data boundary)
  registry.register({
    name: 'github_inspect',
    title: 'Read-Only GitHub Inspector',
    description:
      'Read-only inspection of GitHub repositories, pull requests, issues, and Actions workflow runs via local gh CLI or GitHub API. External content is wrapped in untrusted data boundaries.',
    inputSchema: {
      mode: z.enum(['repo_info', 'pr', 'issue', 'workflow_runs']),
      repo: z.string().min(3).describe('Repository in "owner/name" format'),
      number: z.number().int().min(1).optional().describe('PR or Issue number'),
      limit: z.number().int().min(1).max(30).optional().describe('Max workflow runs to list'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    requiredScope: 'read',
    guard: (args) => baseGuard('github_inspect', `github:${args.repo}:${args.mode}`),
    handler: async (args) =>
      inspectGitHub(ctx.config, {
        mode: args.mode,
        repo: args.repo,
        number: args.number,
        limit: args.limit,
      }),
  });

  // Tool #9: publish_changes (SOLE external write approval gate)
  registry.register({
    name: 'publish_changes',
    title: 'External Publish Gate (Git Push / GitHub PR / Comment)',
    description:
      'Sole external write gate: commit & push to a non-protected branch, open a GitHub PR (draft by default), or post a GitHub comment. Physically blocks direct pushes to main/master/default branch and sensitive files.',
    inputSchema: {
      action: z.enum(['git_commit_push', 'github_pr', 'github_comment']),
      workspace_slug: z.string().optional().describe('Workspace slug (required for git_commit_push & github_pr)'),
      branch: z.string().optional().describe('Target non-protected feature branch name'),
      commit_message: z.string().optional().describe('Commit message when uncommitted changes exist'),
      repo: z.string().optional().describe('Optional "owner/name" repo override'),
      title: z.string().optional().describe('Pull request title'),
      body: z.string().optional().describe('Pull request or comment body'),
      base_branch: z.string().optional().describe('PR target base branch'),
      draft: z.boolean().optional().describe('Create PR as draft (default true)'),
      issue_or_pr_number: z.number().int().min(1).optional().describe('Issue/PR number for github_comment'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    isExternalWriteGate: true,
    requiredScope: 'write',
    guard: baseGuard('publish_changes'),
    handler: async (args) => {
      const ws = args.workspace_slug ? requireWorkspace(ctx, args.workspace_slug) : null;
      const result = await publishExternalChanges(ctx.config, {
        action: args.action,
        workspaceRoot: ws?.root_path,
        defaultBranch: ws?.default_branch,
        branch: args.branch,
        commitMessage: args.commit_message,
        repo: args.repo,
        title: args.title,
        body: args.body,
        baseBranch: args.base_branch,
        draft: args.draft,
        issueOrPrNumber: args.issue_or_pr_number,
      });

      ctx.store.recordAudit({
        actor: 'mcp',
        action: `publish_${args.action}`,
        target: args.repo ?? args.workspace_slug ?? 'external',
        status: 'success',
        details: { branch: args.branch },
      });
      return result;
    },
  });
}
