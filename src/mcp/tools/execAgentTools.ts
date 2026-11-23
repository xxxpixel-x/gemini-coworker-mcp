import { z } from 'zod';
import { getGitStatusOrDiff } from '../../core/codeTools.js';
import type { AgentDriverName } from '../../types.js';
import type { McpToolRegistry } from '../registry.js';
import { requireWorkspace, type McpToolContext } from './context.js';

export function registerExecAgentTools(registry: McpToolRegistry, ctx: McpToolContext): void {
  const baseGuard = (label: string) => ({
    scrubber: ctx.scrubber,
    artifactsDir: ctx.config.artifactsDir,
    maxBytes: ctx.config.inlineOutputMaxBytes,
    label,
  });

  // Tool #4: workspace_exec
  registry.register({
    name: 'workspace_exec',
    title: 'Workspace Command Runner',
    description:
      'Run a build, test, or CLI command inside a registered workspace with scrubbed env. Runs synchronously up to wait_ms (<=15s) and automatically promotes long commands to a background job_id.',
    inputSchema: {
      workspace_slug: z.string().min(1),
      command: z.string().min(1).describe('Executable or command name (e.g. "npm", "git", "python")'),
      args: z.array(z.string()).optional().describe('Command arguments'),
      cwd: z.string().optional().describe('Optional workspace-relative subdirectory'),
      wait_ms: z.number().int().min(500).max(15000).optional(),
      max_duration_sec: z.number().int().min(15).max(3600).optional(),
      use_shell: z.boolean().optional().describe('Set true to run via shell'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    requiredScope: 'write',
    guard: baseGuard('workspace_exec'),
    handler: async (args) => {
      const ws = requireWorkspace(ctx, args.workspace_slug);
      const res = await ctx.runner.executeWorkspaceCommand({
        workspaceSlug: ws.slug,
        workspaceRoot: ws.root_path,
        command: args.command,
        args: args.args,
        cwd: args.cwd,
        waitMs: args.wait_ms,
        maxDurationSec: args.max_duration_sec,
        useShell: args.use_shell,
      });

      if (res.promoted) {
        return JSON.stringify(
          {
            status: 'promoted_to_background_job',
            job_id: res.jobId,
            hint: `Poll job_status(job_id="${res.jobId}") for progress or cancel=true to abort.`,
            partial_output: res.partialOutput,
          },
          null,
          2,
        );
      }

      return JSON.stringify(
        {
          exit_code: res.exitCode,
          timed_out: res.timedOut,
          duration_ms: res.durationMs,
          stdout: res.stdout,
          stderr: res.stderr,
        },
        null,
        2,
      );
    },
  });

  // Tool #5: dispatch_agent
  registry.register({
    name: 'dispatch_agent',
    title: 'Multi-Agent Background Runner',
    description:
      'Dispatch a background coding agent (codex, claude_code, opencode) or shell_task in a workspace. Automatically creates a pre-run Git checkpoint in write mode and injects workspace memories.',
    inputSchema: {
      workspace_slug: z.string().min(1),
      mode: z.enum(['agent_readonly', 'agent_write', 'shell_task']),
      objective: z.string().min(1).describe('Task prompt for the agent or command for shell_task'),
      driver: z.enum(['codex', 'claude_code', 'opencode']).optional(),
      model: z.string().optional(),
      include_memory: z.boolean().optional(),
      max_duration_sec: z.number().int().min(15).max(3600).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    requiredScope: 'write',
    guard: baseGuard('dispatch_agent'),
    handler: async (args) => {
      const ws = requireWorkspace(ctx, args.workspace_slug);
      const job = await ctx.runner.dispatchAgentJob({
        workspaceSlug: ws.slug,
        workspaceRoot: ws.root_path,
        mode: args.mode,
        objective: args.objective,
        driver: args.driver as AgentDriverName | undefined,
        model: args.model,
        includeMemory: args.include_memory,
        maxDurationSec: args.max_duration_sec,
      });
      return JSON.stringify(
        {
          job_id: job.job_id,
          workspace_slug: job.workspace_slug,
          runner_type: job.runner_type,
          status: job.status,
          checkpoint_id: job.checkpoint_id,
          hint: `Use job_status(job_id="${job.job_id}") to check progress or cancel.`,
        },
        null,
        2,
      );
    },
  });

  // Tool #6: job_status
  registry.register({
    name: 'job_status',
    title: 'Background Job Inspector & Cancellation',
    description:
      'Inspect status, incremental events, git status, and final output of background jobs (or list recent jobs), or cancel a running job.',
    inputSchema: {
      job_id: z.string().optional().describe('Target job ID (omit to list recent jobs)'),
      workspace_slug: z.string().optional().describe('Optional workspace filter when listing jobs'),
      since_seq: z.number().int().min(0).optional().describe('Only return events with seq > since_seq'),
      cancel: z.boolean().optional().describe('Set true to abort the running job'),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    requiredScope: (args) => (args.cancel ? 'write' : 'read'),
    guard: baseGuard('job_status'),
    handler: async (args) => {
      if (!args.job_id) {
        const jobs = ctx.store.listJobs(args.workspace_slug, args.limit ?? 20).map((j) => ({
          job_id: j.job_id,
          workspace_slug: j.workspace_slug,
          runner_type: j.runner_type,
          status: j.status,
          checkpoint_id: j.checkpoint_id,
          updated_at: j.updated_at,
        }));
        return JSON.stringify({ jobs }, null, 2);
      }

      if (args.cancel) {
        const cancelled = await ctx.runner.cancelJob(args.job_id);
        return JSON.stringify({ job_id: args.job_id, cancel_requested: cancelled }, null, 2);
      }

      const job = ctx.store.getJob(args.job_id);
      if (!job) {
        throw new Error(`Job "${args.job_id}" not found.`);
      }

      const events =
        args.since_seq !== undefined
          ? job.events.filter((e) => e.seq > args.since_seq!)
          : job.events.slice(-20);

      const ws = ctx.store.getWorkspace(job.workspace_slug);
      const gitStatus = ws ? await getGitStatusOrDiff(ws.root_path, 'git_status') : undefined;

      return JSON.stringify(
        {
          job_id: job.job_id,
          workspace_slug: job.workspace_slug,
          runner_type: job.runner_type,
          status: job.status,
          checkpoint_id: job.checkpoint_id,
          duration_ms: Math.max(0, job.updated_at - job.created_at),
          events,
          git_status: gitStatus,
          final_output: job.final_output,
          error_message: job.error_message,
        },
        null,
        2,
      );
    },
  });
}
