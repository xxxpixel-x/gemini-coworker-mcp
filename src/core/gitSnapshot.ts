import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateId } from '../auth/crypto.js';
import type { GatewayStore } from '../db/sqlite.js';
import type { CheckpointRecord } from '../types.js';
import { buildSandboxedEnv, runCommand } from '../utils/exec.js';

const GIT_SAFE_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper='];

async function runGit(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await runCommand({
    command: 'git',
    args: [...GIT_SAFE_ARGS, ...args],
    cwd,
    env: buildSandboxedEnv(process.env, extraEnv),
    timeoutMs: 30_000,
  });
  return {
    ok: res.exitCode === 0 && !res.timedOut,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
  };
}

export async function isGitRepository(workspaceRoot: string): Promise<boolean> {
  const res = await runGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.stdout === 'true';
}

export async function detectDefaultBranch(workspaceRoot: string): Promise<string> {
  if (!(await isGitRepository(workspaceRoot))) return 'main';
  const sym = await runGit(workspaceRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (sym.ok && sym.stdout.startsWith('refs/remotes/origin/')) {
    return sym.stdout.slice('refs/remotes/origin/'.length);
  }
  const head = await runGit(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.ok && head.stdout && head.stdout !== 'HEAD') {
    return head.stdout;
  }
  return 'main';
}

/**
 * Creates a non-destructive Git checkpoint using a temporary GIT_INDEX_FILE,
 * leaving the user's real staging area and branch history completely untouched.
 */
export async function createGitCheckpoint(
  store: GatewayStore,
  workspaceSlug: string,
  workspaceRoot: string,
  reason: string,
): Promise<CheckpointRecord | null> {
  if (!(await isGitRepository(workspaceRoot))) {
    return null;
  }

  const checkpointId = generateId('cp', 8);
  const gitRef = `refs/mcp-checkpoints/${checkpointId}`;
  const tmpIndex = path.join(os.tmpdir(), `gemini-mcp-idx-${checkpointId}`);

  try {
    const gitDirRes = await runGit(workspaceRoot, ['rev-parse', '--git-dir']);
    if (!gitDirRes.ok) return null;
    const gitDir = path.resolve(workspaceRoot, gitDirRes.stdout);
    const realIndex = path.join(gitDir, 'index');
    if (fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, tmpIndex);
    }

    const idxEnv = { GIT_INDEX_FILE: tmpIndex };
    // Scope to the workspace: it may sit inside a larger repository (a monorepo, or a stray repo in a parent folder).
    const addRes = await runGit(workspaceRoot, ['add', '-A', '--', '.'], idxEnv);
    if (!addRes.ok) {
      throw new Error(`git add failed: ${addRes.stderr}`);
    }

    const treeRes = await runGit(workspaceRoot, ['write-tree'], idxEnv);
    if (!treeRes.ok || !treeRes.stdout) {
      throw new Error(`git write-tree failed: ${treeRes.stderr}`);
    }

    const parentRes = await runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD']);
    const commitArgs = ['commit-tree', treeRes.stdout, '-m', `mcp-checkpoint: ${reason}`];
    if (parentRes.ok && parentRes.stdout) {
      commitArgs.splice(2, 0, '-p', parentRes.stdout);
    }

    const commitRes = await runGit(workspaceRoot, commitArgs, {
      ...idxEnv,
      GIT_AUTHOR_NAME: 'Gemini Coworker',
      GIT_AUTHOR_EMAIL: 'mcp@localhost',
      GIT_COMMITTER_NAME: 'Gemini Coworker',
      GIT_COMMITTER_EMAIL: 'mcp@localhost',
    });
    if (!commitRes.ok || !commitRes.stdout) {
      throw new Error(`git commit-tree failed: ${commitRes.stderr}`);
    }

    const updateRes = await runGit(workspaceRoot, ['update-ref', gitRef, commitRes.stdout]);
    if (!updateRes.ok) {
      throw new Error(`git update-ref failed: ${updateRes.stderr}`);
    }

    const record: CheckpointRecord = {
      checkpoint_id: checkpointId,
      workspace_slug: workspaceSlug,
      git_commit_sha: commitRes.stdout,
      git_ref: gitRef,
      reason,
      created_at: Date.now(),
    };
    store.createCheckpointRecord(record);
    return record;
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

/**
 * Rolls back a Git workspace to a saved checkpoint after capturing a pre-rollback safety snapshot.
 */
export async function rollbackToCheckpoint(
  store: GatewayStore,
  workspaceSlug: string,
  workspaceRoot: string,
  checkpointId: string,
): Promise<{ safetyCheckpointId: string | null; restoredSha: string }> {
  const target = store.getCheckpoint(checkpointId);
  if (!target || target.workspace_slug !== workspaceSlug) {
    throw new Error(`Checkpoint "${checkpointId}" not found for workspace "${workspaceSlug}".`);
  }

  const safety = await createGitCheckpoint(
    store,
    workspaceSlug,
    workspaceRoot,
    `pre-rollback-safety:${checkpointId}`,
  );

  // Restore through a temporary index so the user's staging area stays untouched.
  // checkout-index -a and clean both act only below the cwd, which keeps files outside the workspace intact.
  const tmpIndex = path.join(os.tmpdir(), `gemini-mcp-idx-rb-${generateId('rb', 8)}`);
  const idxEnv = { GIT_INDEX_FILE: tmpIndex };
  try {
    const readTreeRes = await runGit(workspaceRoot, ['read-tree', target.git_commit_sha], idxEnv);
    if (!readTreeRes.ok) {
      throw new Error(`git read-tree rollback failed: ${readTreeRes.stderr}`);
    }
    const checkoutRes = await runGit(workspaceRoot, ['checkout-index', '-a', '-f'], idxEnv);
    if (!checkoutRes.ok) {
      throw new Error(`git checkout-index rollback failed: ${checkoutRes.stderr}`);
    }
    await runGit(workspaceRoot, ['clean', '-fd'], idxEnv);
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
  return {
    safetyCheckpointId: safety?.checkpoint_id ?? null,
    restoredSha: target.git_commit_sha,
  };
}
