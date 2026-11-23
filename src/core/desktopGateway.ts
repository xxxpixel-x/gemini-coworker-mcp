import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand } from '../utils/exec.js';
import type { GatewayStore } from '../db/sqlite.js';
import type { ScrubberLike } from '../types.js';

export interface DesktopStatus {
  desktop_mode?: 'interactive' | 'isolated';
  installed: boolean | null;
  running: boolean;
  version: string | null;
  login: 'unknown' | 'required';
  background: 'verified' | 'unverified' | 'unavailable';
  detected_sessions?: string[];
  sessions: string[];
  reason: string;
}

export interface DesktopAdapter {
  inspect(): Promise<DesktopStatus>;
  exchange(session: string, prompt: string, signal: AbortSignal): Promise<string>;
}

/** The native helper can prove that the send button was never invoked. */
export class NotSent extends Error {}

export class WindowsGeminiDesktop implements DesktopAdapter {
  constructor(private store: GatewayStore, private mode: 'interactive' | 'isolated') {}

  async startIsolated() {
    if (this.mode !== 'isolated') throw new Error('Set GEMINI_DESKTOP_MODE=isolated to start on the private desktop.');
    return this.invoke({ action: 'start-isolated' });
  }

  async windows() { return this.invoke({ action: 'windows' }); }

  async bind(session: string, handle: number): Promise<void> {
    const db = this.store.db;
    if (db.prepare('SELECT 1 FROM desktop_routes WHERE session_id=?').get(session)) {
      throw new Error('This session is already bound. Open its original conversation.');
    }
    const failures = db.prepare('SELECT DISTINCT version FROM desktop_checks WHERE passed=0').all();
    const result = await this.invoke({ action: 'bind', handle, receipt: randomUUID(),
      blocked_versions: failures.map(row => row.version) }, AbortSignal.timeout(150_000));
    if (typeof result.route !== 'string' || !/^[a-f0-9]{64}$/.test(result.route)) throw new Error('No stable Gemini conversation address.');
    db.prepare('INSERT INTO desktop_routes(session_id,route) VALUES(?,?)').run(session,result.route);
  }

  private async invoke(payload: { action: string; [key: string]: unknown }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const script = fileURLToPath(new URL('../../native/gemini-uia.ps1', import.meta.url));
    const flags = this.mode === 'isolated' ? [payload.action === 'start-isolated' ? '-InitializeIsolated' : '-Isolated'] : [];
    if (this.mode === 'isolated' && payload.action === 'check') flags.push('-CheckForeground');
    const res = await runCommand({
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, ...flags],
      stdin: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      timeoutMs: signal ? 150_000 : 20_000,
      signal,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (res.aborted || res.timedOut || res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || 'Desktop helper stopped before it could confirm the outcome.');
    }
    const value = JSON.parse(res.stdout.trim());
    if (value.error && value.not_sent) throw new NotSent(value.error);
    if (value.error) throw new Error(value.error);
    return value;
  }

  async inspect(): Promise<DesktopStatus> {
    if (process.platform !== 'win32') {
      return { installed: false, running: false, version: null, login: 'unknown',
        background: 'unavailable', sessions: [], reason: 'Windows is required.' };
    }
    const bindings = this.store.db.prepare('SELECT session_id,route FROM desktop_routes').all();
    let status: DesktopStatus;
    try {
      status = await this.invoke({ action: 'inspect', bindings }) as unknown as DesktopStatus;
    } catch (err) {
      if (this.mode !== 'isolated' || !(err instanceof NotSent)) throw err;
      return { installed: null, running: false, version: null, login: 'unknown', background: 'unavailable',
        sessions: [], reason: 'Isolated desktop unavailable: ' + err.message };
    }
    status.desktop_mode = this.mode;
    const checks = this.store.db.prepare('SELECT session_id,scenario,passed,detail FROM desktop_checks WHERE version=?').all(status.version ?? '');
    const required = this.mode === 'isolated' ? ['isolated'] : ['other-app', 'personal-gemini'];
    const failure = checks.find(row => required.includes(String(row.scenario)) && !row.passed);
    const verified = status.sessions.filter(id => required.every(scenario =>
      checks.some(row => row.session_id === id && row.scenario === scenario && row.passed === 1)));
    if (verified.length) {
      return { ...status, detected_sessions: status.sessions, sessions: verified, background: 'verified',
        reason: 'Dedicated background checks passed.' };
    }
    return { ...status, detected_sessions: status.sessions, sessions: [],
      background: failure ? 'unavailable' : status.background,
      reason: failure ? String(failure.detail) : status.reason };
  }

  async check(session: string, scenario: 'other-app' | 'personal-gemini' | 'isolated'): Promise<void> {
    if ((scenario === 'isolated') !== (this.mode === 'isolated')) throw new Error('Check scenario and configured desktop mode do not match.');
    const status = await this.inspect();
    const slot = this.store.db.prepare('SELECT route FROM desktop_routes WHERE session_id=?').get(session);
    if (!slot || !status.version || !status.detected_sessions?.includes(session)) throw new Error('Open the bound dedicated chat before checking.');
    const receipt = randomUUID();
    const expected = 'GEMINI-MCP\n    sample();';
    const probe = 'Use exactly this value for the JSON reply field (one newline and four spaces): ' + JSON.stringify(expected);
    let passed = false;
    let detail = 'Check failed.';
    try {
      const res = await this.invoke({ action: 'check', route: slot.route, prompt: probe, receipt, scenario }, AbortSignal.timeout(150_000));
      passed = res.receipt === receipt && this.decodeReply(res).replace(/\r\n/g,'\n') === expected;
      detail = passed ? 'Focus, clipboard and formatted reply checked.' : 'Receipt or formatted test payload did not match.';
    } catch (err) { detail = err instanceof Error ? err.message : String(err); }
    this.store.db.prepare('INSERT OR REPLACE INTO desktop_checks VALUES (?,?,?,?,?)').run(status.version, session, scenario, Number(passed), detail);
    if (!passed) throw new Error(detail);
  }

  private decodeReply(result: Record<string, unknown>): string {
    if (typeof result.reply_base64 !== 'string') throw new Error('No complete desktop reply.');
    return Buffer.from(result.reply_base64, 'base64').toString('utf8');
  }

  async exchange(session: string, prompt: string, signal: AbortSignal): Promise<string> {
    const receipt = randomUUID();
    const slot = this.store.db.prepare('SELECT route FROM desktop_routes WHERE session_id=?').get(session);
    if (!slot) throw new NotSent('Desktop chat is not bound.');
    const passes = this.mode === 'isolated'
      ? this.store.db.prepare("SELECT version FROM desktop_checks WHERE session_id=? AND passed=1 AND scenario='isolated'").all(session)
      : this.store.db.prepare(`SELECT version FROM desktop_checks WHERE session_id=? AND passed=1
          AND scenario IN ('other-app','personal-gemini') GROUP BY version HAVING COUNT(*)=2`).all(session);
    const result = await this.invoke({ action: 'turn', route: slot.route, receipt, prompt,
      versions: passes.map(row => row.version) }, signal);
    const reply = this.decodeReply(result);
    if (result.receipt !== receipt || !reply.trim()) {
      throw new Error('Unable to correlate a complete desktop reply with this request.');
    }
    return reply;
  }
}

type State = 'queued' | 'running' | 'completed' | 'not_sent' | 'cancelled' | 'needs_confirmation';
interface RequestRow {
  request_id: string;
  fingerprint: string;
  session_id: string | null;
  state: State;
  owner_pid: number;
  reply: string | null;
  detail: string | null;
  caller: string;
}
export interface DesktopRequest {
  requestId: string;
  session?: string;
  title: string;
  tool: string;
  args: object;
  caller: string;
  signal?: AbortSignal;
}
type Work = (send: (prompt: string) => Promise<string>, signal: AbortSignal) => Promise<string>;

export class DesktopGateway {
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<unknown>>();

  constructor(private store: GatewayStore, private adapter: DesktopAdapter,
    private scrubber: ScrubberLike, private enabled: boolean) {}

  inspect(): Promise<DesktopStatus> {
    if (!this.enabled) return Promise.resolve({ installed: null, running: false, version: null,
      login: 'unknown', background: 'unavailable', sessions: [], reason: 'Desktop control disabled.' });
    return this.adapter.inspect();
  }

  ownsSession(id: string, caller: string): boolean {
    const binding = this.store.db.prepare('SELECT caller FROM desktop_bindings WHERE session_id=?').get(id);
    return !binding || binding.caller === caller;
  }

  forgetSession(id: string, caller: string): boolean {
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.ownsSession(id, caller)) throw new Error('Unknown session.');
      if (db.prepare("SELECT 1 FROM desktop_requests WHERE session_id=? AND state IN ('queued','running')").get(id)) {
        throw new Error('Session has an active task.');
      }
      db.prepare("UPDATE desktop_requests SET reply=NULL, detail='Local session history deleted.' WHERE session_id=?").run(id);
      db.prepare('DELETE FROM desktop_checks WHERE session_id=?').run(id);
      db.prepare('DELETE FROM desktop_routes WHERE session_id=?').run(id);
      const deleted = this.store.deleteGeminiSession(id);
      db.exec('COMMIT');
      return deleted;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  private row(id: string): RequestRow | undefined {
    return this.store.db.prepare('SELECT * FROM desktop_requests WHERE request_id=?').get(id) as unknown as RequestRow | undefined;
  }

  private recoverDeadOwners(): void {
    const owners = this.store.db.prepare("SELECT DISTINCT owner_pid FROM desktop_requests WHERE state IN ('queued','running')").all();
    for (const { owner_pid } of owners) {
      try { process.kill(Number(owner_pid), 0); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') continue;
        this.store.db.prepare(`UPDATE desktop_requests SET state=CASE state WHEN 'queued' THEN 'not_sent' ELSE 'needs_confirmation' END,
          detail='Previous gateway process exited.' WHERE owner_pid=? AND state IN ('queued','running')`).run(owner_pid);
      }
    }
  }

  result(id: string, caller: string, offset = 0, budget = 24_000): string {
    this.recoverDeadOwners();
    const row = this.row(id);
    if (!row || row.caller !== caller) throw new Error('Unknown desktop request.');
    const reply = row.reply || '';
    // Cursor is a UTF-16 offset. Bound pages by encoded byte size, keeping surrogate pairs intact.
    if (offset > reply.length || (offset > 0 && /[\uDC00-\uDFFF]/u.test(reply.charAt(offset)))) throw new Error('Invalid reply offset.');
    const chunk = Buffer.from(reply.slice(offset), 'utf8');
    let end = Math.min(chunk.length, Math.max(512, budget - 1024));
    while (end < chunk.length && (chunk[end] & 0xc0) === 0x80) end--;
    const page = chunk.subarray(0, end).toString('utf8');
    const fields = [`request_id=${id}`, `status=${row.state}`, `session_id=${row.session_id ?? ''}`];
    if (offset + page.length < reply.length) fields.push(`next_offset=${offset + page.length} (gemini_desktop_status)`);
    return [fields.join(' | '), row.detail, page].filter(Boolean).join('\n\n');
  }

  cancel(id: string, caller: string): void {
    this.store.db.prepare("UPDATE desktop_requests SET state='cancelled',detail='Cancelled before dispatch.' WHERE request_id=? AND caller=? AND state='queued'").run(id, caller);
  }

  run(req: DesktopRequest, work: Work): Promise<void> {
    const db = this.store.db;
    const hash = createHash('sha256').update(JSON.stringify([req.tool, req.args, req.session])).digest('hex');
    this.recoverDeadOwners();
    const created = db.prepare(`INSERT OR IGNORE INTO desktop_requests
      (request_id,fingerprint,session_id,state,owner_pid,caller) VALUES(?,?,?,'queued',?,?)`)
      .run(req.requestId, hash, req.session ?? null, process.pid, req.caller);
    if (!created.changes) {
      const previous = this.row(req.requestId)!;
      if (previous.caller !== req.caller || previous.fingerprint !== hash) throw new Error('Request ID already used for different input.');
      return Promise.resolve();
    }
    const op = this.execute(req, work);
    this.active.add(op);
    void op.then(() => this.active.delete(op), () => this.active.delete(op));
    return op;
  }

  private async execute(req: DesktopRequest, work: Work): Promise<void> {
    const db = this.store.db;
    const signal = AbortSignal.any([this.shutdown.signal, ...(req.signal ? [req.signal] : [])]);
    let claimed = false;
    let sent = false;
    let startedExchange = false;
    try {
      for (;;) {
        signal.throwIfAborted();
        if (this.row(req.requestId)?.state !== 'queued') return;
        const first = db.prepare(`UPDATE desktop_requests SET state='running' WHERE request_id=? AND state='queued'
          AND NOT EXISTS (SELECT 1 FROM desktop_requests WHERE state='running')
          AND rowid=(SELECT MIN(rowid) FROM desktop_requests WHERE state='queued')`).run(req.requestId);
        if (first.changes) { claimed = true; break; }
        await delay(200, undefined, { signal });
        this.recoverDeadOwners();
      }
      let status: DesktopStatus;
      try { status = await this.inspect(); } catch (err) { throw new NotSent(String(err)); }
      if (status.background !== 'verified') throw new NotSent(status.reason);
      const singleIsolated = status.desktop_mode === 'isolated' && status.sessions.length === 1;
      const session = req.session ?? (singleIsolated ? status.sessions[0] : status.sessions.find(id => !this.store.getGeminiSession(id)));
      if (!session || !status.sessions.includes(session)) {
        throw new NotSent(status.reason + ' Supply the session_id of a dedicated, separately open MCP chat.');
      }
      const previous = this.store.getGeminiSession(session);
      if (previous && previous.model !== 'gemini-desktop') throw new NotSent('This history belongs to another backend.');
      const binding = db.prepare('SELECT caller FROM desktop_bindings WHERE session_id=?').get(session);
      if (binding && binding.caller !== req.caller) throw new NotSent('Desktop conversation belongs to a different client.');
      if (!previous) this.store.createGeminiSession({ session_id: session, title: this.scrubber.scrub(req.title), model: 'gemini-desktop' });
      db.prepare('INSERT OR IGNORE INTO desktop_bindings(session_id,caller) VALUES(?,?)').run(session,req.caller);
      db.prepare('UPDATE desktop_requests SET session_id=? WHERE request_id=?').run(session, req.requestId);
      const answer = await work(async prompt => {
        signal.throwIfAborted();
        const clean = this.scrubber.scrub(prompt);
        if (Buffer.byteLength(clean) > 256_000) throw new NotSent('Desktop text exceeds the 256 KB limit.');
        startedExchange = true;
        const reply = this.scrubber.scrub(await this.adapter.exchange(session, clean, signal));
        sent = true;
        this.store.appendGeminiMessage(session, 'user', clean);
        this.store.appendGeminiMessage(session, 'model', reply);
        return reply;
      }, signal);
      db.prepare("UPDATE desktop_requests SET state='completed',reply=? WHERE request_id=?").run(this.scrubber.scrub(answer), req.requestId);
    } catch (err) {
      let state: State = 'needs_confirmation';
      if (!claimed) state = 'cancelled';
      else if (!startedExchange || (!sent && err instanceof NotSent)) state = 'not_sent';
      const detail = this.scrubber.scrub(err instanceof Error ? err.message : String(err)).slice(0, 500);
      db.prepare("UPDATE desktop_requests SET state=?,detail=? WHERE request_id=? AND state IN ('queued','running')").run(state, detail, req.requestId);
    }
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled(this.active);
  }
}
