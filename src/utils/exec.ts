import { spawn, type ChildProcess } from 'node:child_process';

const FORBIDDEN_ENV_PATTERN =
  /^(?:MCP_BEARER_TOKEN|OAUTH_.*|ADMIN_PASSWORD_HASH|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|CLOUDFLARE_.*|AWS_SECRET_.*|.*_SECRET_KEY|.*_PRIVATE_KEY)$/i;

/**
 * Builds a scrubbed subprocess environment suitable for running workspace commands
 * without leaking gateway/OAuth/API secrets.
 */
export function buildSandboxedEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  extraEnv: Record<string, string | undefined> = {},
): Record<string, string> {
  const clean: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (FORBIDDEN_ENV_PATTERN.test(key)) continue;
    clean[key] = value;
  }

  clean.CI = 'true';
  clean.GIT_TERMINAL_PROMPT = '0';
  clean.PAGER = 'cat';
  clean.GIT_PAGER = 'cat';
  clean.NO_COLOR = '1';

  for (const [key, value] of Object.entries(extraEnv)) {
    if (value !== undefined) {
      clean[key] = value;
    }
  }

  return clean;
}

/**
 * Kills a process and its entire child process tree (Windows-native via taskkill /T /F).
 */
export async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid || pid <= 0) return;

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }

  await new Promise((r) => setTimeout(r, 300));
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already exited
    }
  }
}

export interface RunCommandOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  shell?: boolean;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

/**
 * Resolves Windows .ps1 / .cmd / .bat shims cleanly when spawning CLI commands.
 */
export function resolveSpawnTarget(
  command: string,
  args: string[],
  shell = false,
): { file: string; args: string[]; shell: boolean } {
  if (process.platform === 'win32' && !shell) {
    const lower = command.toLowerCase();
    if (lower.endsWith('.ps1')) {
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args],
        shell: false,
      };
    }
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      return {
        file: 'cmd.exe',
        args: ['/d', '/s', '/c', command, ...args],
        shell: false,
      };
    }
  }
  return { file: command, args, shell };
}

export function spawnManagedProcess(options: RunCommandOptions): {
  child: ChildProcess;
  promise: Promise<RunCommandResult>;
} {
  const startMs = Date.now();
  const maxBytes = options.maxOutputBytes ?? 512 * 1024;
  const resolved = resolveSpawnTarget(options.command, options.args ?? [], options.shell ?? false);

  const child = spawn(resolved.file, resolved.args, {
    cwd: options.cwd,
    env: options.env ?? buildSandboxedEnv(),
    shell: resolved.shell,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const promise = new Promise<RunCommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        aborted,
        durationMs: Math.max(0, Date.now() - startMs),
      });
    };

    const onAbort = () => {
      aborted = true;
      void killProcessTree(child.pid);
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            void killProcessTree(child.pid);
          }, options.timeoutMs)
        : undefined;

    child.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8');
      options.onStdout?.(text);
      if (stdoutBytes < maxBytes) {
        const remaining = maxBytes - stdoutBytes;
        stdout += buf.subarray(0, remaining).toString('utf8');
        stdoutBytes += Math.min(buf.length, remaining);
      }
    });

    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8');
      options.onStderr?.(text);
      if (stderrBytes < maxBytes) {
        const remaining = maxBytes - stderrBytes;
        stderr += buf.subarray(0, remaining).toString('utf8');
        stderrBytes += Math.min(buf.length, remaining);
      }
    });

    child.on('error', (err) => {
      stderr += (stderr ? '\n' : '') + err.message;
      finish(1, null);
    });

    child.on('close', (code, signal) => {
      finish(code, signal);
    });

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
  });

  return { child, promise };
}

export async function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  return spawnManagedProcess(options).promise;
}
