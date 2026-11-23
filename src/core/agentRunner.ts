import { execFileSync } from 'node:child_process';
import { generateId } from '../auth/crypto.js';
import type { GatewayStore } from '../db/sqlite.js';
import type { AgentDriverName, AppConfig, JobRecord } from '../types.js';
import { buildSandboxedEnv, spawnManagedProcess } from '../utils/exec.js';
import type { SecretScrubber } from '../utils/secretScrubber.js';
import { createGitCheckpoint } from './gitSnapshot.js';
import { resolveSafeWorkspacePath } from './workspaceSecurity.js';

export function findCommandOnPath(binary: string): string {
  if (process.platform === 'win32') {
    for (const candidate of [`${binary}.exe`, `${binary}.cmd`, `${binary}.ps1`, binary]) {
      try {
        const out = execFileSync('where.exe', [candidate], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        if (first) return first;
      } catch {
        // try next extension
      }
    }
  }
  return binary;
}

function buildAgentInvocation(params: {
  driver: AgentDriverName;
  mode: 'readonly' | 'write';
  prompt: string;
  model?: string;
  config: AppConfig;
}): { command: string; args: string[]; env: Record<string, string> } {
  const { driver, mode, prompt, model, config } = params;

  switch (driver) {
    case 'codex': {
      const cmd = findCommandOnPath('codex');
      const args = [
        'exec',
        '--sandbox',
        mode === 'readonly' ? 'read-only' : 'workspace-write',
        '--skip-git-repo-check',
      ];
      if (model) args.push('--model', model);
      args.push(prompt);
      return {
        command: cmd,
        args,
        env: buildSandboxedEnv(process.env, {
          OPENAI_API_KEY: config.openaiApiKey,
          CODEX_API_KEY: config.codexApiKey,
        }),
      };
    }

    case 'claude_code': {
      const cmd = findCommandOnPath('claude');
      const args = [
        '-p',
        prompt,
        '--permission-mode',
        mode === 'readonly' ? 'plan' : 'acceptEdits',
      ];
      if (model) args.push('--model', model);
      return {
        command: cmd,
        args,
        env: buildSandboxedEnv(process.env, {
          ANTHROPIC_API_KEY: config.anthropicApiKey,
        }),
      };
    }

    case 'opencode': {
      const cmd = findCommandOnPath('opencode');
      const args = ['run', prompt];
      if (model) args.push('--model', model);
      return {
        command: cmd,
        args,
        env: buildSandboxedEnv(process.env, {
          OPENAI_API_KEY: config.openaiApiKey,
          ANTHROPIC_API_KEY: config.anthropicApiKey,
        }),
      };
    }
  }
}

export class JobRunnerService {
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: GatewayStore,
    private readonly scrubber: SecretScrubber,
  ) {}

  async cancelJob(jobId: string): Promise<boolean> {
    const controller = this.activeControllers.get(jobId);
    if (!controller) return false;
    controller.abort();
    this.store.appendJobEvent(jobId, 'cancel', 'Cancellation requested by operator.');
    this.store.updateJobStatus(jobId, 'cancelled', { error_message: 'Cancelled by user.' });
    return true;
  }

  async cancelAllActiveJobs(): Promise<void> {
    for (const [jobId, controller] of this.activeControllers.entries()) {
      controller.abort();
      this.store.updateJobStatus(jobId, 'cancelled', {
        error_message: 'Server shutting down.',
      });
    }
    this.activeControllers.clear();
  }

  /**
   * Executes a workspace command synchronously up to `waitMs` (max 15s).
   * If still running after `waitMs`, automatically promotes it into a tracked background SQLite job.
   */
  async executeWorkspaceCommand(params: {
    workspaceSlug: string;
    workspaceRoot: string;
    command: string;
    args?: string[];
    cwd?: string;
    waitMs?: number;
    maxDurationSec?: number;
    useShell?: boolean;
  }): Promise<
    | { promoted: false; exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean }
    | { promoted: true; jobId: string; partialOutput: string }
  > {
    const waitMs = Math.max(500, Math.min(params.waitMs ?? 12_000, 15_000));
    const maxDurationMs =
      Math.max(15, Math.min(params.maxDurationSec ?? this.config.agentMaxDurationSec, this.config.agentMaxDurationSec)) *
      1000;

    const effectiveCwd =
      params.cwd && params.cwd !== '.'
        ? resolveSafeWorkspacePath(params.workspaceRoot, params.cwd, { mustExist: true }).absolutePath
        : params.workspaceRoot;

    const resolvedCmd = params.useShell ? params.command : findCommandOnPath(params.command);
    const controller = new AbortController();
    const jobId = generateId('job', 8);
    let partialBuffer = '';
    let promoted = false;

    const { promise } = spawnManagedProcess({
      command: resolvedCmd,
      args: params.args ?? [],
      cwd: effectiveCwd,
      env: buildSandboxedEnv(),
      timeoutMs: maxDurationMs,
      shell: params.useShell ?? false,
      signal: controller.signal,
      onStdout: (chunk) => {
        const clean = this.scrubber.scrub(chunk);
        partialBuffer = (partialBuffer + clean).slice(-16_000);
        if (promoted) {
          this.store.appendJobEvent(jobId, 'stdout', clean.slice(0, 1000));
        }
      },
      onStderr: (chunk) => {
        const clean = this.scrubber.scrub(chunk);
        partialBuffer = (partialBuffer + clean).slice(-16_000);
        if (promoted) {
          this.store.appendJobEvent(jobId, 'stderr', clean.slice(0, 1000));
        }
      },
    });

    const raceResult = await Promise.race([
      promise.then((res) => ({ finished: true as const, res })),
      new Promise<{ finished: false }>((resolve) =>
        setTimeout(() => resolve({ finished: false }), waitMs),
      ),
    ]);

    if (raceResult.finished) {
      return {
        promoted: false,
        exitCode: raceResult.res.exitCode,
        stdout: this.scrubber.scrub(raceResult.res.stdout),
        stderr: this.scrubber.scrub(raceResult.res.stderr),
        durationMs: raceResult.res.durationMs,
        timedOut: raceResult.res.timedOut,
      };
    }

    // Promote to background job
    promoted = true;
    const now = Date.now();
    this.activeControllers.set(jobId, controller);
    this.store.createJob({
      job_id: jobId,
      workspace_slug: params.workspaceSlug,
      runner_type: 'shell_task',
      status: 'running',
      command_or_objective: [params.command, ...(params.args ?? [])].join(' '),
      checkpoint_id: null,
      created_at: now,
      updated_at: now,
    });
    this.store.appendJobEvent(
      jobId,
      'promoted',
      `Command exceeded ${waitMs}ms sync wait; promoted to background job.`,
    );

    void promise.then((res) => {
      this.activeControllers.delete(jobId);
      const combined = this.scrubber.scrub(
        [res.stdout, res.stderr ? `\n[stderr]\n${res.stderr}` : ''].filter(Boolean).join('\n'),
      );
      if (res.aborted) {
        this.store.updateJobStatus(jobId, 'cancelled', {
          final_output: combined,
          error_message: 'Cancelled',
        });
      } else if (res.timedOut) {
        this.store.updateJobStatus(jobId, 'timed_out', {
          final_output: combined,
          error_message: `Timed out after ${Math.round(maxDurationMs / 1000)}s`,
        });
      } else if (res.exitCode === 0) {
        this.store.updateJobStatus(jobId, 'completed', { final_output: combined });
      } else {
        this.store.updateJobStatus(jobId, 'failed', {
          final_output: combined,
          error_message: `Exited with code ${res.exitCode}`,
        });
      }
    });

    return {
      promoted: true,
      jobId,
      partialOutput: partialBuffer,
    };
  }

  /**
   * Dispatches a background local coding agent (codex, claude_code, opencode) or shell task.
   */
  async dispatchAgentJob(params: {
    workspaceSlug: string;
    workspaceRoot: string;
    mode: 'agent_readonly' | 'agent_write' | 'shell_task';
    objective: string;
    driver?: AgentDriverName;
    model?: string;
    includeMemory?: boolean;
    maxDurationSec?: number;
  }): Promise<JobRecord> {
    const jobId = generateId('job', 8);
    const now = Date.now();
    const driver = params.driver ?? this.config.defaultAgentDriver;
    const maxDurationMs =
      Math.max(
        15,
        Math.min(
          params.maxDurationSec ?? this.config.agentMaxDurationSec,
          this.config.agentMaxDurationSec,
        ),
      ) * 1000;

    let checkpointId: string | null = null;
    if (params.mode === 'agent_write') {
      const cp = await createGitCheckpoint(
        this.store,
        params.workspaceSlug,
        params.workspaceRoot,
        `pre-agent:${driver}`,
      );
      checkpointId = cp?.checkpoint_id ?? null;
    }

    let fullPrompt = params.objective;
    if (params.mode !== 'shell_task' && params.includeMemory !== false) {
      const memories = this.store.listMemories(params.workspaceSlug, undefined, 15);
      if (memories.length > 0) {
        const memBlock = memories
          .map((m) => `- [${m.category}${m.pinned ? ', pinned' : ''}] ${m.key}: ${m.content}`)
          .join('\n');
        fullPrompt = `[Workspace Persistent Memory]\n${memBlock}\n\n[Task]\n${params.objective}`;
      }
    }

    const runnerType = params.mode === 'shell_task' ? 'shell_task' : `${params.mode}:${driver}`;
    this.store.createJob({
      job_id: jobId,
      workspace_slug: params.workspaceSlug,
      runner_type: runnerType,
      status: 'running',
      command_or_objective: params.objective,
      checkpoint_id: checkpointId,
      created_at: now,
      updated_at: now,
    });

    const controller = new AbortController();
    this.activeControllers.set(jobId, controller);

    const invocation =
      params.mode === 'shell_task'
        ? {
            command: process.platform === 'win32' ? 'powershell.exe' : 'sh',
            args:
              process.platform === 'win32'
                ? ['-NoProfile', '-Command', params.objective]
                : ['-c', params.objective],
            env: buildSandboxedEnv(),
          }
        : buildAgentInvocation({
            driver,
            mode: params.mode === 'agent_readonly' ? 'readonly' : 'write',
            prompt: fullPrompt,
            model: params.model,
            config: this.config,
          });

    this.store.appendJobEvent(jobId, 'start', `Started ${runnerType} in ${params.workspaceRoot}`);

    const { promise } = spawnManagedProcess({
      command: invocation.command,
      args: invocation.args,
      cwd: params.workspaceRoot,
      env: invocation.env,
      timeoutMs: maxDurationMs,
      signal: controller.signal,
      onStdout: (chunk) => {
        const text = this.scrubber.scrub(chunk).trim();
        if (text) this.store.appendJobEvent(jobId, 'stdout', text.slice(0, 1200));
      },
      onStderr: (chunk) => {
        const text = this.scrubber.scrub(chunk).trim();
        if (text) this.store.appendJobEvent(jobId, 'stderr', text.slice(0, 1200));
      },
    });

    void promise.then((res) => {
      this.activeControllers.delete(jobId);
      const combined = this.scrubber.scrub(
        [res.stdout, res.stderr ? `\n[stderr]\n${res.stderr}` : ''].filter(Boolean).join('\n'),
      );
      if (res.aborted) {
        this.store.updateJobStatus(jobId, 'cancelled', {
          final_output: combined,
          error_message: 'Cancelled',
        });
      } else if (res.timedOut) {
        this.store.updateJobStatus(jobId, 'timed_out', {
          final_output: combined,
          error_message: `Timed out after ${Math.round(maxDurationMs / 1000)}s`,
        });
      } else if (res.exitCode === 0) {
        this.store.updateJobStatus(jobId, 'completed', { final_output: combined });
      } else {
        this.store.updateJobStatus(jobId, 'failed', {
          final_output: combined,
          error_message: `Process exited with code ${res.exitCode}`,
        });
      }
    });

    return this.store.getJob(jobId)!;
  }
}
