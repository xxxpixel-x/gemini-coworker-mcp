import fs from 'node:fs';
import path from 'node:path';
import type { GatewayStore } from '../db/sqlite.js';
import type { ScrubberLike } from '../types.js';
import { buildSandboxedEnv, runCommand } from '../utils/exec.js';
import type { SecretScrubber } from '../utils/secretScrubber.js';
import { createGitCheckpoint, isGitRepository, rollbackToCheckpoint } from './gitSnapshot.js';
import {
  isSensitiveRelativePath,
  resolveSafeWorkspacePath,
} from './workspaceSecurity.js';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.venv',
  '__pycache__',
  'target',
  '.data',
]);

export function listWorkspaceTree(
  workspaceRoot: string,
  subPath = '.',
  maxDepth = 3,
  maxEntries = 300,
): string {
  const base =
    subPath === '.' || subPath === ''
      ? { absolutePath: fs.realpathSync(workspaceRoot), relativePath: '' }
      : resolveSafeWorkspacePath(workspaceRoot, subPath, { mustExist: true });

  const lines: string[] = [];
  let truncated = false;

  const walk = (dir: string, relPrefix: string, depth: number) => {
    if (depth > maxDepth || lines.length >= maxEntries) {
      if (lines.length >= maxEntries) truncated = true;
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (lines.length >= maxEntries) {
        truncated = true;
        return;
      }
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;

      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (isSensitiveRelativePath(rel)) continue;

      lines.push(`${'  '.repeat(depth)}${entry.isDirectory() ? entry.name + '/' : entry.name}`);
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel, depth + 1);
      }
    }
  };

  walk(base.absolutePath, base.relativePath, 0);
  if (truncated) {
    lines.push(`... (truncated at ${maxEntries} entries)`);
  }
  return lines.join('\n') || '(empty directory)';
}

export async function searchWorkspaceCode(
  workspaceRoot: string,
  query: string,
  options: { subPath?: string; regex?: boolean; maxResults?: number } = {},
): Promise<string> {
  const maxResults = Math.min(Math.max(options.maxResults ?? 80, 1), 300);
  const searchRoot =
    options.subPath && options.subPath !== '.'
      ? resolveSafeWorkspacePath(workspaceRoot, options.subPath, { mustExist: true }).absolutePath
      : fs.realpathSync(workspaceRoot);

  // Try ripgrep first if installed
  const rgArgs = [
    '--line-number',
    '--no-heading',
    '--color=never',
    '--max-count=20',
    '--glob=!.git/**',
    '--glob=!node_modules/**',
    '--glob=!.env*',
    '--glob=!*.pem',
    '--glob=!*.key',
  ];
  if (!options.regex) rgArgs.push('--fixed-strings');
  rgArgs.push(query, searchRoot);

  const rg = await runCommand({
    command: 'rg',
    args: rgArgs,
    cwd: workspaceRoot,
    env: buildSandboxedEnv(),
    timeoutMs: 10_000,
  });

  if (rg.exitCode === 0 || rg.exitCode === 1) {
    const rawLines = rg.stdout.split(/\r?\n/).filter(Boolean);
    const realRoot = fs.realpathSync(workspaceRoot);
    const filtered: string[] = [];
    for (const line of rawLines) {
      const normalized = line.replace(realRoot, '').replace(/^[\\/]/, '').replace(/\\/g, '/');
      const filePart = normalized.split(':')[0] ?? '';
      if (isSensitiveRelativePath(filePart)) continue;
      filtered.push(normalized);
      if (filtered.length >= maxResults) break;
    }
    return filtered.length > 0 ? filtered.join('\n') : 'No matches found.';
  }

  // Fallback: pure Node.js recursive search
  const matcher = options.regex ? new RegExp(query, 'i') : null;
  const lowerQuery = query.toLowerCase();
  const matches: string[] = [];
  const realRoot = fs.realpathSync(workspaceRoot);

  const walk = (dir: string) => {
    if (matches.length >= maxResults) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= maxResults) return;
      const full = path.join(dir, entry.name);
      const rel = path.relative(realRoot, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (isSensitiveRelativePath(rel)) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.size > 1024 * 1024) continue; // skip >1MB files
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes('\0')) continue; // skip binary
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hit = matcher ? matcher.test(line) : line.toLowerCase().includes(lowerQuery);
          if (hit) {
            matches.push(`${rel}:${i + 1}:${line.slice(0, 300)}`);
            if (matches.length >= maxResults) return;
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  };

  walk(searchRoot);
  return matches.length > 0 ? matches.join('\n') : 'No matches found.';
}

export function readWorkspaceFileLines(
  workspaceRoot: string,
  relativePath: string,
  startLine = 1,
  endLine = 200,
): string {
  const { absolutePath, relativePath: rel } = resolveSafeWorkspacePath(workspaceRoot, relativePath, {
    mustExist: true,
  });
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: "${rel}"`);
  }
  if (stat.size > 5 * 1024 * 1024) {
    throw new Error(`File exceeds 5MB read cap (${stat.size} bytes): "${rel}"`);
  }

  const text = fs.readFileSync(absolutePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const s = Math.max(1, startLine);
  const e = Math.min(lines.length, Math.max(s, endLine));
  const slice = lines.slice(s - 1, e).map((line, idx) => `${s + idx}: ${line}`);
  return `File: ${rel} (lines ${s}-${e} of ${lines.length})\n${slice.join('\n')}`;
}

export function readOffloadedArtifact(
  artifactsDir: string,
  artifactId: string,
  offset = 0,
  limit = 20000,
): string {
  if (!/^[a-z0-9_-]+$/i.test(artifactId)) {
    throw new Error(`Invalid artifact_id: "${artifactId}"`);
  }
  const artifactPath = path.join(path.resolve(artifactsDir), `${artifactId}.log`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found: "${artifactId}"`);
  }
  const buf = fs.readFileSync(artifactPath);
  const safeOffset = Math.max(0, Math.min(offset, buf.length));
  const safeLimit = Math.max(1, Math.min(limit, 50_000));
  const slice = buf.subarray(safeOffset, safeOffset + safeLimit).toString('utf8');
  return `Artifact "${artifactId}" bytes ${safeOffset}-${safeOffset + Buffer.byteLength(slice, 'utf8')} / ${buf.length}:\n${slice}`;
}

export async function getGitStatusOrDiff(
  workspaceRoot: string,
  mode: 'git_status' | 'git_diff',
  options: { staged?: boolean; baseRef?: string } = {},
): Promise<string> {
  if (!(await isGitRepository(workspaceRoot))) {
    return 'Not a Git repository.';
  }
  const args =
    mode === 'git_status'
      ? ['status', '-sb']
      : options.staged
        ? ['diff', '--cached']
        : options.baseRef
          ? ['diff', options.baseRef]
          : ['diff'];

  const res = await runCommand({
    command: 'git',
    args: ['-c', 'core.hooksPath=/dev/null', ...args],
    cwd: workspaceRoot,
    env: buildSandboxedEnv(),
    timeoutMs: 15_000,
  });
  return res.stdout.trim() || res.stderr.trim() || '(clean / no diff)';
}

export interface PatchHunk {
  search: string;
  replace: string;
  line_hint?: number;
}

export interface FilePatchInput {
  path: string;
  hunks: PatchHunk[];
}

function applyHunk(content: string, hunk: PatchHunk, filePath: string): string {
  if (!hunk.search) {
    throw new Error(`Empty search string in hunk for "${filePath}"`);
  }

  const indices: number[] = [];
  let from = 0;
  while (true) {
    const idx = content.indexOf(hunk.search, from);
    if (idx === -1) break;
    indices.push(idx);
    from = idx + 1;
  }

  if (indices.length === 0) {
    throw new Error(`Search block not found in "${filePath}".`);
  }

  let chosenIdx = indices[0];
  if (indices.length > 1) {
    if (hunk.line_hint === undefined) {
      throw new Error(
        `Ambiguous search block in "${filePath}" (${indices.length} matches). Provide line_hint.`,
      );
    }
    let bestDist = Infinity;
    let tied = false;
    for (const idx of indices) {
      const lineNum = content.slice(0, idx).split('\n').length;
      const dist = Math.abs(lineNum - hunk.line_hint);
      if (dist < bestDist) {
        bestDist = dist;
        chosenIdx = idx;
        tied = false;
      } else if (dist === bestDist) {
        tied = true;
      }
    }
    if (tied || bestDist > 30) {
      throw new Error(
        `Ambiguous search block in "${filePath}" near line_hint=${hunk.line_hint} (closest distance=${bestDist} lines).`,
      );
    }
  }

  return (
    content.slice(0, chosenIdx) + hunk.replace + content.slice(chosenIdx + hunk.search.length)
  );
}

function writeFileAtomic(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.mcp-tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

function validateFileSyntax(relPath: string, content: string): string | null {
  if (relPath.toLowerCase().endsWith('.json')) {
    try {
      JSON.parse(content);
    } catch (err) {
      return `Invalid JSON in "${relPath}": ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return null;
}

export async function applyWorkspacePatch(params: {
  store: GatewayStore;
  scrubber: SecretScrubber & ScrubberLike;
  workspaceSlug: string;
  workspaceRoot: string;
  action: 'patch' | 'create_or_overwrite' | 'delete_file';
  edits?: FilePatchInput[];
  filePath?: string;
  content?: string;
  rollbackOnFailure?: boolean;
}): Promise<{
  checkpointId: string | null;
  changedFiles: string[];
  validationWarnings: string[];
}> {
  const { store, scrubber, workspaceSlug, workspaceRoot, action } = params;
  const rollbackOnFailure = params.rollbackOnFailure !== false;

  const stagedWrites: Array<{ absolutePath: string; relativePath: string; content: string }> = [];
  let deleteTarget: { absolutePath: string; relativePath: string } | null = null;

  if (action === 'patch') {
    if (!params.edits || params.edits.length === 0) {
      throw new Error('edits array is required for action="patch".');
    }
    for (const edit of params.edits) {
      const resolved = resolveSafeWorkspacePath(workspaceRoot, edit.path, { mustExist: true });
      let nextContent = fs.readFileSync(resolved.absolutePath, 'utf8');
      for (const hunk of edit.hunks) {
        if (scrubber.containsLikelySecret(hunk.replace)) {
          throw new Error(`Refusing to write likely secret into "${resolved.relativePath}".`);
        }
        nextContent = applyHunk(nextContent, hunk, resolved.relativePath);
      }
      stagedWrites.push({ ...resolved, content: nextContent });
    }
  } else if (action === 'create_or_overwrite') {
    if (!params.filePath || params.content === undefined) {
      throw new Error('path and content are required for action="create_or_overwrite".');
    }
    const resolved = resolveSafeWorkspacePath(workspaceRoot, params.filePath);
    if (scrubber.containsLikelySecret(params.content)) {
      throw new Error(`Refusing to write likely secret into "${resolved.relativePath}".`);
    }
    stagedWrites.push({ ...resolved, content: params.content });
  } else if (action === 'delete_file') {
    if (!params.filePath) {
      throw new Error('path is required for action="delete_file".');
    }
    deleteTarget = resolveSafeWorkspacePath(workspaceRoot, params.filePath, { mustExist: true });
  }

  const checkpoint = await createGitCheckpoint(
    store,
    workspaceSlug,
    workspaceRoot,
    `code_patch:${action}`,
  );

  const changedFiles: string[] = [];
  const validationErrors: string[] = [];

  try {
    if (deleteTarget) {
      fs.unlinkSync(deleteTarget.absolutePath);
      changedFiles.push(deleteTarget.relativePath);
    } else {
      for (const item of stagedWrites) {
        const syntaxErr = validateFileSyntax(item.relativePath, item.content);
        if (syntaxErr) {
          validationErrors.push(syntaxErr);
        }
        writeFileAtomic(item.absolutePath, item.content);
        changedFiles.push(item.relativePath);
      }
    }

    if (validationErrors.length > 0) {
      throw new Error(`Post-write validation failed:\n${validationErrors.join('\n')}`);
    }

    return {
      checkpointId: checkpoint?.checkpoint_id ?? null,
      changedFiles,
      validationWarnings: [],
    };
  } catch (err) {
    if (rollbackOnFailure && checkpoint) {
      await rollbackToCheckpoint(store, workspaceSlug, workspaceRoot, checkpoint.checkpoint_id);
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n(Automatically rolled back to checkpoint ${checkpoint.checkpoint_id})`,
      );
    }
    throw err;
  }
}
