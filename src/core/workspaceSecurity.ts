import fs from 'node:fs';
import path from 'node:path';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.dev.vars',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '.npmrc',
  '.pypirc',
]);

export function assertValidSlug(slug: string): string {
  const cleaned = slug.trim();
  if (!SLUG_PATTERN.test(cleaned)) {
    throw new Error(
      `Invalid workspace slug "${slug}". Use 1-64 lowercase letters, digits, "-" or "_" starting with alphanumeric.`,
    );
  }
  return cleaned;
}

function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function resolveRealPathOrAncestor(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (fs.existsSync(resolved)) {
    return fs.realpathSync(resolved);
  }
  let current = path.dirname(resolved);
  while (true) {
    if (fs.existsSync(current)) {
      const realAncestor = fs.realpathSync(current);
      const rel = path.relative(current, resolved);
      return rel ? path.join(realAncestor, rel) : realAncestor;
    }
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    current = parent;
  }
}

export function isInsideRoot(targetPath: string, rootPath: string): boolean {
  const normTarget = normalizePathForCompare(targetPath);
  const normRoot = normalizePathForCompare(rootPath);
  return normTarget === normRoot || normTarget.startsWith(normRoot + path.sep);
}

/**
 * Verifies a directory being registered as a workspace is inside ALLOWED_WORKSPACE_ROOTS
 * and does not overlap DATA_DIR.
 */
export function assertAllowedWorkspaceRoot(
  candidateDir: string,
  allowedRoots: string[],
  dataDir: string,
): string {
  const resolved = path.resolve(candidateDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Workspace path does not exist or is not a directory: ${resolved}`);
  }
  const realCandidate = fs.realpathSync(resolved);
  const realDataDir = resolveRealPathOrAncestor(dataDir);

  if (isInsideRoot(realCandidate, realDataDir)) {
    throw new Error(`Refusing to register a workspace inside DATA_DIR (${realDataDir}).`);
  }

  const permitted = allowedRoots.some((root) => {
    const realRoot = resolveRealPathOrAncestor(root);
    return isInsideRoot(realCandidate, realRoot);
  });

  if (!permitted) {
    throw new Error(
      `Workspace path "${realCandidate}" is outside ALLOWED_WORKSPACE_ROOTS (${allowedRoots.join(', ')}).`,
    );
  }

  return realCandidate;
}

/**
 * Checks whether a relative path targets a sensitive secret or git credential/hook file.
 * Handles Windows trailing dots/spaces normalization.
 */
export function isSensitiveRelativePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return false;

  const cleanedSegments = segments.map((s) => s.replace(/[. ]+$/g, '').toLowerCase());
  const joined = cleanedSegments.join('/');

  if (joined === '.git/config' || joined.startsWith('.git/hooks/') || joined === '.git/hooks') {
    return true;
  }

  const base = cleanedSegments[cleanedSegments.length - 1];
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (base.startsWith('.env.') && base !== '.env.example' && base !== '.env.sample') return true;
  if (base.startsWith('.dev.vars.')) return true;
  if (base.endsWith('.pem') || base.endsWith('.key') || base.endsWith('.pfx') || base.endsWith('.p12')) {
    return true;
  }
  if (base.startsWith('id_rsa') || base.startsWith('id_ed25519')) return true;

  return false;
}

/**
 * Resolves a workspace-relative path safely (preventing path traversal, symlink escape, and sensitive file access).
 */
export function resolveSafeWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
  options: { allowSensitive?: boolean; mustExist?: boolean } = {},
): { absolutePath: string; relativePath: string } {
  const realRoot = fs.realpathSync(workspaceRoot);
  const cleanedRel = relativePath.replace(/\\/g, '/').trim();
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
    throw new Error(`Path must be relative to the workspace root: "${relativePath}"`);
  }

  const candidate = path.resolve(realRoot, relativePath);
  if (!isInsideRoot(candidate, realRoot)) {
    throw new Error(`Path traversal blocked: "${relativePath}" escapes workspace root.`);
  }

  const relFromRoot = path.relative(realRoot, candidate).replace(/\\/g, '/');
  if (!options.allowSensitive && isSensitiveRelativePath(relFromRoot)) {
    throw new Error(`Access blocked for sensitive file: "${relFromRoot}"`);
  }

  if (fs.existsSync(candidate)) {
    const realTarget = fs.realpathSync(candidate);
    if (!isInsideRoot(realTarget, realRoot)) {
      throw new Error(`Symlink escape blocked for "${cleanedRel}"`);
    }
    const canonicalRel = path.relative(realRoot, realTarget).split(path.sep).join('/');
    if (!options.allowSensitive && isSensitiveRelativePath(canonicalRel)) {
      throw new Error('Access blocked for sensitive link target.');
    }
    return { absolutePath: realTarget, relativePath: relFromRoot };
  }

  if (options.mustExist) {
    throw new Error(`Path not found: "${relFromRoot}"`);
  }

  const realWithAncestor = resolveRealPathOrAncestor(candidate);
  if (!isInsideRoot(realWithAncestor, realRoot)) {
    throw new Error(`Symlink ancestor escape blocked for "${cleanedRel}"`);
  }

  return { absolutePath: realWithAncestor, relativePath: relFromRoot };
}

/**
 * Resolves either a workspace-relative path (when `workspaceRoot` is given) OR an absolute path
 * located inside `allowedRoots` (or `extraAllowedRoots`), enforcing symlink confinement and
 * blocking sensitive secret/credential files.
 */
export function resolveAllowedFilePath(params: {
  filePath: string;
  workspaceRoot?: string;
  allowedRoots: string[];
  extraAllowedRoots?: string[];
  mustExist?: boolean;
}): { absolutePath: string; displayPath: string } {
  const raw = params.filePath.trim();
  const isAbs = path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw);

  if (!isAbs) {
    if (!params.workspaceRoot) {
      throw new Error(
        `Relative path "${raw}" requires workspace_slug (or pass an absolute path inside ALLOWED_WORKSPACE_ROOTS).`,
      );
    }
    const res = resolveSafeWorkspacePath(params.workspaceRoot, raw, {
      mustExist: params.mustExist,
    });
    return { absolutePath: res.absolutePath, displayPath: res.relativePath };
  }

  const candidate = path.resolve(raw);
  const allRoots = [
    ...(params.workspaceRoot ? [params.workspaceRoot] : []),
    ...params.allowedRoots,
    ...(params.extraAllowedRoots ?? []),
  ].map((r) => resolveRealPathOrAncestor(r));

  if (params.mustExist && !fs.existsSync(candidate)) {
    throw new Error(`File not found: "${candidate}"`);
  }

  const resolvedReal = fs.existsSync(candidate)
    ? fs.realpathSync(candidate)
    : resolveRealPathOrAncestor(candidate);

  const matchedRoot = allRoots.find((root) => isInsideRoot(resolvedReal, root));
  if (!matchedRoot) {
    throw new Error(
      `Path "${resolvedReal}" is outside ALLOWED_WORKSPACE_ROOTS (${params.allowedRoots.join(', ')}).`,
    );
  }

  const relFromRoot = path.relative(matchedRoot, resolvedReal).replace(/\\/g, '/');
  if (isSensitiveRelativePath(relFromRoot)) {
    throw new Error(`Access blocked for sensitive file: "${relFromRoot}"`);
  }

  return {
    absolutePath: resolvedReal,
    displayPath: relFromRoot || path.basename(resolvedReal),
  };
}

/**
 * Simple per-workspace async mutex queue to serialize mutating operations safely.
 */
export class WorkspaceLockManager {
  private readonly chains = new Map<string, Promise<void>>();

  async runExclusive<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(slug) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = prev.then(() => current);
    this.chains.set(slug, next);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(slug) === next) {
        this.chains.delete(slug);
      }
    }
  }
}
