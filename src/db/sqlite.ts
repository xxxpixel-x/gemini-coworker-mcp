import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CheckpointRecord,
  GeminiMessageRecord,
  GeminiSessionRecord,
  GeminiUsageSummary,
  JobEvent,
  JobRecord,
  JobStatus,
  MemoryCategory,
  OAuthAuthRequestRecord,
  OAuthClientRecord,
  OAuthCodeRecord,
  OAuthTokenRecord,
  WorkspaceMemoryRecord,
  WorkspaceRecord,
} from '../types.js';

export class GatewayStore {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret_hash TEXT,
        client_name TEXT NOT NULL,
        redirect_uris_json TEXT NOT NULL,
        is_static INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_auth_requests (
        auth_req_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        state TEXT,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS oauth_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        token_family_id TEXT
      );

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        token_type TEXT NOT NULL,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        token_family_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        grace_expires_at INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens(token_family_id);

      CREATE TABLE IF NOT EXISTS workspaces (
        slug TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        default_branch TEXT NOT NULL DEFAULT 'main',
        description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_memories (
        memory_id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(workspace_slug, category, key)
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        git_commit_sha TEXT NOT NULL,
        git_ref TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_ws ON checkpoints(workspace_slug, created_at DESC);

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        runner_type TEXT NOT NULL,
        status TEXT NOT NULL,
        command_or_objective TEXT NOT NULL,
        checkpoint_id TEXT,
        events_json TEXT NOT NULL DEFAULT '[]',
        final_output TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_ws ON jobs(workspace_slug, created_at DESC);

      CREATE TABLE IF NOT EXISTS job_owners (
        job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
        pid INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gemini_sessions (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        system_instruction TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gemini_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES gemini_sessions(session_id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        text_content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gemini_messages_session ON gemini_messages(session_id, id ASC);

      CREATE TABLE IF NOT EXISTS desktop_checks (
        version TEXT NOT NULL,
        session_id TEXT NOT NULL,
        scenario TEXT NOT NULL,
        passed INTEGER NOT NULL,
        detail TEXT NOT NULL,
        PRIMARY KEY(version,session_id,scenario)
      );
      CREATE TABLE IF NOT EXISTS desktop_routes (
        session_id TEXT PRIMARY KEY,
        route TEXT UNIQUE NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_bindings (
        session_id TEXT PRIMARY KEY REFERENCES gemini_sessions(session_id) ON DELETE CASCADE,
        caller TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_requests (
        request_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        caller TEXT NOT NULL,
        session_id TEXT,
        state TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        reply TEXT,
        detail TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS desktop_single_sender ON desktop_requests(state) WHERE state = 'running';

      CREATE TABLE IF NOT EXISTS gemini_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        backend TEXT NOT NULL,
        model TEXT NOT NULL,
        session_id TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
  }

  ping(): boolean {
    const row = this.db.prepare('SELECT 1 AS ok').get() as { ok?: number } | undefined;
    return row?.ok === 1;
  }

  close(): void {
    this.db.close();
  }

  // --- OAuth Clients ---
  listOAuthClients(): OAuthClientRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM oauth_clients ORDER BY created_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      client_id: String(r.client_id),
      client_secret_hash: r.client_secret_hash ? String(r.client_secret_hash) : null,
      client_name: String(r.client_name),
      redirect_uris: JSON.parse(String(r.redirect_uris_json)) as string[],
      is_static: Number(r.is_static) === 1,
      created_at: Number(r.created_at),
    }));
  }

  getOAuthClient(clientId: string): OAuthClientRecord | null {
    const r = this.db
      .prepare('SELECT * FROM oauth_clients WHERE client_id = ?')
      .get(clientId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      client_id: String(r.client_id),
      client_secret_hash: r.client_secret_hash ? String(r.client_secret_hash) : null,
      client_name: String(r.client_name),
      redirect_uris: JSON.parse(String(r.redirect_uris_json)) as string[],
      is_static: Number(r.is_static) === 1,
      created_at: Number(r.created_at),
    };
  }

  createOAuthClient(record: OAuthClientRecord): void {
    this.db
      .prepare(
        `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris_json, is_static, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.client_id,
        record.client_secret_hash,
        record.client_name,
        JSON.stringify(record.redirect_uris),
        record.is_static ? 1 : 0,
        record.created_at,
      );
  }

  upsertStaticClient(params: {
    client_id: string;
    client_secret_hash: string | null;
    client_name: string;
    redirect_uris: string[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris_json, is_static, created_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(client_id) DO UPDATE SET
           client_secret_hash = excluded.client_secret_hash,
           client_name = excluded.client_name,
           redirect_uris_json = excluded.redirect_uris_json,
           is_static = 1`,
      )
      .run(
        params.client_id,
        params.client_secret_hash,
        params.client_name,
        JSON.stringify(params.redirect_uris),
        Date.now(),
      );
  }

  retireStaleStaticClients(activeClientId?: string): void {
    if (!activeClientId) {
      this.db.prepare('DELETE FROM oauth_clients WHERE is_static = 1').run();
      return;
    }
    this.db
      .prepare('DELETE FROM oauth_clients WHERE is_static = 1 AND client_id != ?')
      .run(activeClientId);
  }

  // --- OAuth Auth Requests ---
  createAuthRequest(req: OAuthAuthRequestRecord): void {
    this.db
      .prepare(
        `INSERT INTO oauth_auth_requests
         (auth_req_id, client_id, redirect_uri, state, code_challenge, code_challenge_method, scope, resource, csrf_token, expires_at, used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.auth_req_id,
        req.client_id,
        req.redirect_uri,
        req.state,
        req.code_challenge,
        req.code_challenge_method,
        req.scope,
        req.resource,
        req.csrf_token,
        req.expires_at,
        req.used ? 1 : 0,
      );
  }

  getAuthRequest(authReqId: string): OAuthAuthRequestRecord | null {
    const r = this.db
      .prepare('SELECT * FROM oauth_auth_requests WHERE auth_req_id = ?')
      .get(authReqId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      auth_req_id: String(r.auth_req_id),
      client_id: String(r.client_id),
      redirect_uri: String(r.redirect_uri),
      state: r.state !== null && r.state !== undefined ? String(r.state) : null,
      code_challenge: String(r.code_challenge),
      code_challenge_method: String(r.code_challenge_method),
      scope: String(r.scope),
      resource: String(r.resource),
      csrf_token: String(r.csrf_token),
      expires_at: Number(r.expires_at),
      used: Number(r.used) === 1,
    };
  }

  rotateAuthRequestCsrf(authReqId: string, csrfToken: string): void {
    this.db
      .prepare('UPDATE oauth_auth_requests SET csrf_token = ? WHERE auth_req_id = ?')
      .run(csrfToken, authReqId);
  }

  markAuthRequestUsed(authReqId: string): boolean {
    const res = this.db
      .prepare('UPDATE oauth_auth_requests SET used = 1 WHERE auth_req_id = ? AND used = 0')
      .run(authReqId);
    return Number(res.changes) > 0;
  }

  // --- OAuth Codes ---
  createAuthCode(code: OAuthCodeRecord): void {
    this.db
      .prepare(
        `INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, scope, resource, expires_at, used, token_family_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        code.code,
        code.client_id,
        code.redirect_uri,
        code.code_challenge,
        code.scope,
        code.resource,
        code.expires_at,
        code.used ? 1 : 0,
        code.token_family_id,
      );
  }

  getAuthCode(code: string): OAuthCodeRecord | null {
    const r = this.db
      .prepare('SELECT * FROM oauth_codes WHERE code = ?')
      .get(code) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      code: String(r.code),
      client_id: String(r.client_id),
      redirect_uri: String(r.redirect_uri),
      code_challenge: String(r.code_challenge),
      scope: String(r.scope),
      resource: String(r.resource),
      expires_at: Number(r.expires_at),
      used: Number(r.used) === 1,
      token_family_id: r.token_family_id ? String(r.token_family_id) : null,
    };
  }

  consumeAuthCode(code: string, tokenFamilyId: string): boolean {
    const res = this.db
      .prepare('UPDATE oauth_codes SET used = 1, token_family_id = ? WHERE code = ? AND used = 0')
      .run(tokenFamilyId, code);
    return Number(res.changes) > 0;
  }

  // --- OAuth Tokens ---
  createToken(token: Omit<OAuthTokenRecord, 'revoked' | 'created_at'> & { revoked?: boolean; created_at?: number }): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens
         (token_hash, token_type, client_id, scope, resource, token_family_id, expires_at, grace_expires_at, revoked, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token.token_hash,
        token.token_type,
        token.client_id,
        token.scope,
        token.resource,
        token.token_family_id,
        token.expires_at,
        token.grace_expires_at,
        token.revoked ? 1 : 0,
        token.created_at ?? Date.now(),
      );
  }

  getTokenByHash(tokenHash: string): OAuthTokenRecord | null {
    const r = this.db
      .prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?')
      .get(tokenHash) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      token_hash: String(r.token_hash),
      token_type: String(r.token_type) as 'access' | 'refresh',
      client_id: String(r.client_id),
      scope: String(r.scope),
      resource: String(r.resource),
      token_family_id: String(r.token_family_id),
      expires_at: Number(r.expires_at),
      grace_expires_at:
        r.grace_expires_at !== null && r.grace_expires_at !== undefined
          ? Number(r.grace_expires_at)
          : null,
      revoked: Number(r.revoked) === 1,
      created_at: Number(r.created_at),
    };
  }

  setTokenGraceExpiry(tokenHash: string, graceExpiresAt: number): void {
    this.db
      .prepare('UPDATE oauth_tokens SET grace_expires_at = ? WHERE token_hash = ? AND grace_expires_at IS NULL')
      .run(graceExpiresAt, tokenHash);
  }

  revokeToken(tokenHash: string): void {
    this.db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?').run(tokenHash);
  }

  revokeTokenFamily(familyId: string): void {
    this.db
      .prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token_family_id = ?')
      .run(familyId);
  }

  // --- Workspaces ---
  listWorkspaces(): WorkspaceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      slug: String(r.slug),
      root_path: String(r.root_path),
      default_branch: String(r.default_branch),
      description: String(r.description),
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    }));
  }

  getWorkspace(slug: string): WorkspaceRecord | null {
    const r = this.db
      .prepare('SELECT * FROM workspaces WHERE slug = ?')
      .get(slug) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      slug: String(r.slug),
      root_path: String(r.root_path),
      default_branch: String(r.default_branch),
      description: String(r.description),
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    };
  }

  upsertWorkspace(ws: Omit<WorkspaceRecord, 'created_at' | 'updated_at'>): WorkspaceRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspaces (slug, root_path, default_branch, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           root_path = excluded.root_path,
           default_branch = excluded.default_branch,
           description = excluded.description,
           updated_at = excluded.updated_at`,
      )
      .run(ws.slug, ws.root_path, ws.default_branch, ws.description, now, now);
    return this.getWorkspace(ws.slug)!;
  }

  deleteWorkspace(slug: string): boolean {
    const res = this.db.prepare('DELETE FROM workspaces WHERE slug = ?').run(slug);
    return Number(res.changes) > 0;
  }

  // --- Workspace Memories ---
  listMemories(workspaceSlug: string, category?: MemoryCategory, limit = 50): WorkspaceMemoryRecord[] {
    const rows = category
      ? (this.db
          .prepare(
            `SELECT * FROM workspace_memories WHERE workspace_slug = ? AND category = ?
             ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
          )
          .all(workspaceSlug, category, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT * FROM workspace_memories WHERE workspace_slug = ?
             ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
          )
          .all(workspaceSlug, limit) as Array<Record<string, unknown>>);

    return rows.map((r) => ({
      memory_id: String(r.memory_id),
      workspace_slug: String(r.workspace_slug),
      category: String(r.category) as MemoryCategory,
      key: String(r.key),
      content: String(r.content),
      pinned: Number(r.pinned) === 1,
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    }));
  }

  upsertMemory(params: {
    memory_id: string;
    workspace_slug: string;
    category: MemoryCategory;
    key: string;
    content: string;
    pinned: boolean;
  }): WorkspaceMemoryRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspace_memories (memory_id, workspace_slug, category, key, content, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_slug, category, key) DO UPDATE SET
           content = excluded.content,
           pinned = excluded.pinned,
           updated_at = excluded.updated_at`,
      )
      .run(
        params.memory_id,
        params.workspace_slug,
        params.category,
        params.key,
        params.content,
        params.pinned ? 1 : 0,
        now,
        now,
      );
    const r = this.db
      .prepare(
        'SELECT * FROM workspace_memories WHERE workspace_slug = ? AND category = ? AND key = ?',
      )
      .get(params.workspace_slug, params.category, params.key) as Record<string, unknown>;
    return {
      memory_id: String(r.memory_id),
      workspace_slug: String(r.workspace_slug),
      category: String(r.category) as MemoryCategory,
      key: String(r.key),
      content: String(r.content),
      pinned: Number(r.pinned) === 1,
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    };
  }

  deleteMemory(workspaceSlug: string, category: MemoryCategory, key: string): boolean {
    const res = this.db
      .prepare(
        'DELETE FROM workspace_memories WHERE workspace_slug = ? AND category = ? AND key = ?',
      )
      .run(workspaceSlug, category, key);
    return Number(res.changes) > 0;
  }

  // --- Checkpoints ---
  createCheckpointRecord(cp: CheckpointRecord): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (checkpoint_id, workspace_slug, git_commit_sha, git_ref, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cp.checkpoint_id,
        cp.workspace_slug,
        cp.git_commit_sha,
        cp.git_ref,
        cp.reason,
        cp.created_at,
      );
  }

  listCheckpoints(workspaceSlug: string, limit = 20): CheckpointRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM checkpoints WHERE workspace_slug = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(workspaceSlug, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      checkpoint_id: String(r.checkpoint_id),
      workspace_slug: String(r.workspace_slug),
      git_commit_sha: String(r.git_commit_sha),
      git_ref: String(r.git_ref),
      reason: String(r.reason),
      created_at: Number(r.created_at),
    }));
  }

  getCheckpoint(checkpointId: string): CheckpointRecord | null {
    const r = this.db
      .prepare('SELECT * FROM checkpoints WHERE checkpoint_id = ?')
      .get(checkpointId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      checkpoint_id: String(r.checkpoint_id),
      workspace_slug: String(r.workspace_slug),
      git_commit_sha: String(r.git_commit_sha),
      git_ref: String(r.git_ref),
      reason: String(r.reason),
      created_at: Number(r.created_at),
    };
  }

  // --- Jobs ---
  createJob(job: Omit<JobRecord, 'events' | 'final_output' | 'error_message'>): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO jobs
           (job_id, workspace_slug, runner_type, status, command_or_objective, checkpoint_id, events_json, final_output, error_message, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '[]', NULL, NULL, ?, ?)`,
        )
        .run(
          job.job_id,
          job.workspace_slug,
          job.runner_type,
          job.status,
          job.command_or_objective,
          job.checkpoint_id,
          job.created_at,
          job.updated_at,
        );
      this.db.prepare('INSERT INTO job_owners(job_id,pid) VALUES(?,?)').run(job.job_id, process.pid);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getJob(jobId: string): JobRecord | null {
    const r = this.db
      .prepare('SELECT * FROM jobs WHERE job_id = ?')
      .get(jobId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      job_id: String(r.job_id),
      workspace_slug: String(r.workspace_slug),
      runner_type: String(r.runner_type),
      status: String(r.status) as JobStatus,
      command_or_objective: String(r.command_or_objective),
      checkpoint_id: r.checkpoint_id ? String(r.checkpoint_id) : null,
      events: JSON.parse(String(r.events_json || '[]')) as JobEvent[],
      final_output: r.final_output !== null && r.final_output !== undefined ? String(r.final_output) : null,
      error_message:
        r.error_message !== null && r.error_message !== undefined ? String(r.error_message) : null,
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    };
  }

  listJobs(workspaceSlug?: string, limit = 20): JobRecord[] {
    const rows = workspaceSlug
      ? (this.db
          .prepare('SELECT * FROM jobs WHERE workspace_slug = ? ORDER BY created_at DESC LIMIT ?')
          .all(workspaceSlug, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
          .all(limit) as Array<Record<string, unknown>>);
    return rows.map((r) => ({
      job_id: String(r.job_id),
      workspace_slug: String(r.workspace_slug),
      runner_type: String(r.runner_type),
      status: String(r.status) as JobStatus,
      command_or_objective: String(r.command_or_objective),
      checkpoint_id: r.checkpoint_id ? String(r.checkpoint_id) : null,
      events: JSON.parse(String(r.events_json || '[]')) as JobEvent[],
      final_output: r.final_output !== null && r.final_output !== undefined ? String(r.final_output) : null,
      error_message:
        r.error_message !== null && r.error_message !== undefined ? String(r.error_message) : null,
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    }));
  }

  appendJobEvent(jobId: string, type: string, message: string): void {
    const job = this.getJob(jobId);
    if (!job) return;
    const nextSeq = job.events.length > 0 ? job.events[job.events.length - 1].seq + 1 : 1;
    const events = [...job.events, { seq: nextSeq, ts: Date.now(), type, message }].slice(-200);
    this.db
      .prepare('UPDATE jobs SET events_json = ?, updated_at = ? WHERE job_id = ?')
      .run(JSON.stringify(events), Date.now(), jobId);
  }

  updateJobStatus(
    jobId: string,
    status: JobStatus,
    patch: { final_output?: string | null; error_message?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET status = ?,
             final_output = COALESCE(?, final_output),
             error_message = COALESCE(?, error_message),
             updated_at = ?
         WHERE job_id = ?`,
      )
      .run(
        status,
        patch.final_output ?? null,
        patch.error_message ?? null,
        Date.now(),
        jobId,
      );
  }

  reconcileOrphanJobs(): number {
    const jobs = this.db.prepare(`SELECT j.job_id,o.pid FROM jobs j LEFT JOIN job_owners o USING(job_id)
      WHERE j.status IN ('queued','running')`).all();
    const fail = this.db.prepare(`UPDATE jobs SET status='failed', error_message=COALESCE(error_message,
      'Process terminated before completion (server restarted)'), updated_at=?
      WHERE job_id=? AND status IN ('queued','running')`);
    let count = 0;
    for (const job of jobs) {
      if (job.pid != null) {
        try { process.kill(Number(job.pid), 0); continue; } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') continue;
        }
      }
      count += Number(fail.run(Date.now(), job.job_id).changes);
    }
    return count;
  }

  // --- Audit ---
  recordAudit(entry: {
    actor: string;
    action: string;
    target: string;
    status: string;
    details?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_logs (actor, action, target, status, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.actor,
        entry.action,
        entry.target,
        entry.status,
        JSON.stringify(entry.details ?? {}),
        Date.now(),
      );
  }

  // --- Gemini Sessions & Usage ---
  createGeminiSession(params: {
    session_id: string;
    title: string;
    model: string;
    system_instruction?: string | null;
  }): GeminiSessionRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO gemini_sessions (session_id, title, model, system_instruction, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.session_id,
        params.title.slice(0, 160),
        params.model,
        params.system_instruction ?? null,
        now,
        now,
      );
    return this.getGeminiSession(params.session_id)!;
  }

  getGeminiSession(sessionId: string): GeminiSessionRecord | null {
    const r = this.db
      .prepare('SELECT * FROM gemini_sessions WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      session_id: String(r.session_id),
      title: String(r.title),
      model: String(r.model),
      system_instruction:
        r.system_instruction !== null && r.system_instruction !== undefined
          ? String(r.system_instruction)
          : null,
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    };
  }

  listGeminiSessions(limit = 30): Array<GeminiSessionRecord & { message_count: number }> {
    const rows = this.db
      .prepare(
        `SELECT s.*, COUNT(m.id) AS message_count
         FROM gemini_sessions s
         LEFT JOIN gemini_messages m ON m.session_id = s.session_id
         GROUP BY s.session_id
         ORDER BY s.updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      session_id: String(r.session_id),
      title: String(r.title),
      model: String(r.model),
      system_instruction:
        r.system_instruction !== null && r.system_instruction !== undefined
          ? String(r.system_instruction)
          : null,
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
      message_count: Number(r.message_count ?? 0),
    }));
  }

  touchGeminiSession(sessionId: string, model?: string): void {
    if (model) {
      this.db
        .prepare('UPDATE gemini_sessions SET model = ?, updated_at = ? WHERE session_id = ?')
        .run(model, Date.now(), sessionId);
    } else {
      this.db
        .prepare('UPDATE gemini_sessions SET updated_at = ? WHERE session_id = ?')
        .run(Date.now(), sessionId);
    }
  }

  deleteGeminiSession(sessionId: string): boolean {
    const res = this.db
      .prepare('DELETE FROM gemini_sessions WHERE session_id = ?')
      .run(sessionId);
    return Number(res.changes) > 0;
  }

  appendGeminiMessage(
    sessionId: string,
    role: 'user' | 'model',
    textContent: string,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO gemini_messages (session_id, role, text_content, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, role, textContent, now);
    this.touchGeminiSession(sessionId);
  }

  getGeminiMessages(sessionId: string, limit = 60): GeminiMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM gemini_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      session_id: String(r.session_id),
      role: String(r.role) as 'user' | 'model',
      text_content: String(r.text_content),
      created_at: Number(r.created_at),
    }));
  }

  recordGeminiUsage(entry: {
    tool_name: string;
    backend: 'api' | 'cli' | 'desktop';
    model: string;
    session_id?: string | null;
    prompt_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO gemini_usage
         (tool_name, backend, model, session_id, prompt_tokens, output_tokens, total_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.tool_name,
        entry.backend,
        entry.model,
        entry.session_id ?? null,
        entry.prompt_tokens ?? 0,
        entry.output_tokens ?? 0,
        entry.total_tokens ?? 0,
        Date.now(),
      );
  }

  getGeminiUsageSummary(): GeminiUsageSummary {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS total_calls,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM gemini_usage`,
      )
      .get() as Record<string, unknown>;

    const byToolRows = this.db
      .prepare(
        `SELECT tool_name, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM gemini_usage
         GROUP BY tool_name
         ORDER BY calls DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    return {
      total_calls: Number(totals.total_calls ?? 0),
      prompt_tokens: Number(totals.prompt_tokens ?? 0),
      output_tokens: Number(totals.output_tokens ?? 0),
      total_tokens: Number(totals.total_tokens ?? 0),
      by_tool: byToolRows.map((r) => ({
        tool_name: String(r.tool_name),
        calls: Number(r.calls ?? 0),
        total_tokens: Number(r.total_tokens ?? 0),
      })),
    };
  }
}
