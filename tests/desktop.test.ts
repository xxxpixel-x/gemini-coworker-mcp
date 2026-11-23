import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGatewayRuntime, type GatewayRuntime } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { NotSent, type DesktopAdapter, type DesktopStatus } from '../src/core/desktopGateway.js';

describe('desktop-only MCP', () => {
  let root: string;
  let data: string;
  let app: GatewayRuntime;
  let extra: GatewayRuntime | undefined;
  let seen: string[];
  let respond: (prompt: string) => Promise<string>;
  let status: DesktopStatus;
  const connect = () => {
    const adapter: DesktopAdapter = {
      inspect: async () => status,
      exchange: async (_session, prompt) => { seen.push(prompt); return respond(prompt); },
    };
    return createGatewayRuntime(loadConfig({ DATA_DIR: data, ALLOWED_WORKSPACE_ROOTS: root,
      TOOL_PROFILE: 'gemini_only', INLINE_OUTPUT_MAX_BYTES: '4096' }), { desktopAdapter: adapter });
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-desktop-task-'));
    data = path.join(root, '.data');
    status = { installed: true, running: true, version: 'fixture',
      login: 'unknown', background: 'verified', sessions: ['MCP-A','MCP-B'], reason: 'fixture' };
    seen = [];
    respond = async () => 'answer';
    app = connect();
    app.ctx.store.upsertWorkspace({ slug: 'demo', root_path: root, default_branch: 'main', description: '' });
  });
  afterEach(async () => {
    await extra?.shutdown(); extra = undefined;
    await app.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function call(name: string, args: object, gateway = app) {
    const res = await gateway.app.request('/mcp', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'tools/call', params:{ name, arguments:args } }) });
    const body = await res.json() as {result: {content: Array<{text:string}>}};
    return body.result.content[0].text;
  }
  it('exposes desktop tools and refuses to send before certification', async () => {
    expect(app.toolNames).toEqual(['gemini_review','gemini_desktop_status','gemini_chat','gemini_run_task','gemini_sessions']);
    status.background = 'unverified';
    expect(await call('gemini_chat',{ message:'hello' })).toContain('status=not_sent');
    expect(seen).toEqual([]);
  });
  it('requires a matching session, scrubs text and retains review modes and file confinement', async () => {
    fs.writeFileSync(path.join(root,'hello.txt'),'credential sk-proj-1234567890abcdefghijklmnop');
    const res = await call('gemini_review',{ workspace_slug:'demo', mode:'arch_review', files:['hello.txt'] });
    expect(res).toContain('session_id=MCP-A');
    expect(seen[0]).toContain('architect');
    expect(seen[0]).toContain('[REDACTED_SECRET]');
    expect(seen[0]).not.toContain('sk-proj-');
    fs.writeFileSync(path.join(root,'.env'),'hidden');
    expect(await call('gemini_chat',{ workspace_slug:'demo', session_id:'MCP-A', files:['.env'], message:'read' })).toContain('sensitive');
    expect(await call('gemini_chat',{ session_id:'MCP-missing',message:'test' })).toContain('not_sent');
    expect(seen).toHaveLength(1);
  });
  it('reuses request IDs after restart, rejects conflicting input and paginates Unicode replies', async () => {
    const answer = '代码🙂\n'.repeat(2100) + '    end();';
    respond = async () => answer;
    const args = { request_id:'same', session_id:'MCP-A', objective:'write' };
    const start = await call('gemini_run_task',args);
    expect(start).toContain('next_offset=');
    await app.shutdown(); app = connect();
    expect(await call('gemini_run_task',args)).toBe(start);
    let page = start;
    let full = page.split('\n\n').slice(1).join('\n\n');
    for (;;) {
      const cursor = /next_offset=(\d+)/.exec(page);
      if (!cursor) break;
      page = await call('gemini_desktop_status',{ request_id:'same', offset:Number(cursor[1]) });
      full += page.split('\n\n').slice(1).join('\n\n');
    }
    expect(full).toBe(answer);
    expect(await call('gemini_run_task',{...args,objective:'different'})).toContain('different input');
    expect(seen).toHaveLength(1);
  });
  it('serializes two hosts and cancels queued work before any send', async () => {
    let release!: (value: string) => void;
    const wait = new Promise<string>(resolve => { release = resolve; });
    let started!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    respond = async () => { started(); return wait; };
    extra = connect();
    const first = call('gemini_run_task',{request_id:'first',session_id:'MCP-A',objective:'one'});
    await sending;
    const second = call('gemini_run_task',{request_id:'second',session_id:'MCP-B',objective:'two'},extra);
    while (!extra.ctx.store.db.prepare('SELECT 1 FROM desktop_requests WHERE request_id=?').get('second')) await new Promise(r=>setTimeout(r,5));
    expect(await call('gemini_desktop_status',{request_id:'second',cancel:true},extra)).toContain('cancelled');
    release('one done');
    expect(await first).toContain('one done');
    expect(await second).toContain('cancelled');
    expect(seen).toEqual(['one']);
  });

  it('returns before a delegated answer and reuses the sole isolated chat on the next task', async () => {
    status.desktop_mode = 'isolated';
    status.sessions = ['MCP-A'];
    let finish!: (value: string) => void;
    const pending = new Promise<string>(resolve => { finish = resolve; });
    respond = () => pending;
    const task = { request_id:'background', objective:'one', return_immediately:true };
    try {
      expect(await call('gemini_run_task',task)).toContain('status=running');
      expect(await call('gemini_run_task',{...task, return_immediately:false})).toContain('status=running');
      expect(await call('gemini_run_task',{...task, objective:'other'})).toContain('different input');
      expect(seen).toEqual(['one']);
    } finally { finish('first answer'); }
    await vi.waitFor(async () => {
      expect(await call('gemini_desktop_status',{request_id:'background'})).toContain('first answer');
    });
    respond = async () => 'second answer';
    expect(await call('gemini_run_task',{request_id:'another', objective:'two'})).toContain('second answer');
    expect(seen).toEqual(['one','two']);
  });
  it('distinguishes known unsent and unconfirmed sends without replay', async () => {
    respond = async () => { throw new NotSent('existing draft'); };
    expect(await call('gemini_chat',{session_id:'MCP-A',message:'first'})).toContain('status=not_sent');
    respond = async () => { throw new Error('reply timed out'); };
    const args = {request_id:'uncertain',session_id:'MCP-A',message:'second'};
    expect(await call('gemini_chat',args)).toContain('needs_confirmation');
    expect(await call('gemini_chat',args)).toContain('needs_confirmation');
    expect(seen).toHaveLength(2);
  });
  it('executes scoped file actions and verifies the real on-disk result', async () => {
    fs.writeFileSync(path.join(root,'value.txt'),'before');
    const steps = [
      {action:'write',path:'outside.txt',content:'no'},
      {action:'read',path:'value.txt'},
      {action:'write',path:'value.txt',content:'after'},
      {action:'verify'},
      {action:'finish',answer:'corrected'},
    ];
    respond = async () => JSON.stringify(steps.shift());
    const res = await call('gemini_run_task',{request_id:'work', session_id:'MCP-A', objective:'fix fixture',
      workspace_slug:'demo', permissions:{write_files:['value.txt'], verify:{
        command:process.execPath,args:['-e',"process.exit(require('fs').readFileSync('value.txt','utf8') === 'after' ? 0 : 1)"]}}});
    expect(res).toContain('status=completed');
    expect(res).toContain('"verification": "passed"');
    expect(seen[1]).toContain('not granted');
    expect(seen[4]).toContain('"exit_code":0');
    expect(fs.readFileSync(path.join(root,'value.txt'),'utf8')).toBe('after');
    expect(fs.existsSync(path.join(root,'outside.txt'))).toBe(false);
  });

  it('preserves another gateway’s active jobs and reconciles interrupted desktop requests', async () => {
    const now = Date.now();
    app.ctx.store.createJob({ job_id:'live', workspace_slug:'demo', runner_type:'shell_task', status:'running',
      command_or_objective:'fixture', checkpoint_id:null, created_at:now, updated_at:now });
    extra = connect();
    expect(extra.ctx.store.getJob('live')?.status).toBe('running');
    const insert = app.ctx.store.db.prepare(
      'INSERT INTO desktop_requests (request_id, fingerprint, caller, state, owner_pid) VALUES (?,?,?,?,?)');
    insert.run('lost-before', 'a', 'local', 'queued', 2147483646);
    insert.run('lost-during', 'b', 'local', 'running', 2147483646);
    expect(await call('gemini_desktop_status',{request_id:'lost-before'},extra)).toContain('not_sent');
    expect(await call('gemini_desktop_status',{request_id:'lost-during'},extra)).toContain('needs_confirmation');
    expect(seen).toHaveLength(0);
  });

  it('deletes local reply history without resending a previously completed request', async () => {
    const args = {message:'example',session_id:'MCP-A',request_id:'saved'};
    await call('gemini_chat',args);
    expect(await call('gemini_sessions',{action:'get',session_id:'MCP-A'})).toContain('example');
    await call('gemini_sessions',{action:'delete',session_id:'MCP-A'});
    expect(await call('gemini_chat',args)).toContain('history deleted');
    expect(seen).toHaveLength(1);
  });
});
