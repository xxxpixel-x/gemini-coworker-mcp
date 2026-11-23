import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGatewayRuntime, type GatewayRuntime } from '../src/app.js';
import { computeS256Challenge, hashPasswordScrypt } from '../src/auth/crypto.js';
import { loadConfig } from '../src/config.js';
import { runCommand } from '../src/utils/exec.js';

function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = computeS256Challenge(verifier);
  return { verifier, challenge };
}

function extractHidden(html: string, name: string): string {
  const match = new RegExp(`name="${name}"\\s+value="([^"]+)"`, 'i').exec(html);
  if (!match?.[1]) throw new Error(`Missing hidden input "${name}"`);
  return match[1];
}

async function callMcp(
  runtime: GatewayRuntime,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const res = await runtime.app.request('http://127.0.0.1:8787/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
}

describe('Gemini Coworker: Streamable HTTP, Workspace Tools & OAuth 2.1 Gemini Compat', () => {
  let tmpRoot: string;
  let workspaceDir: string;
  let dataDir: string;
  let runtime: GatewayRuntime | null = null;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-coworker-mcp-test-'));
    workspaceDir = path.join(tmpRoot, 'sample-repo');
    dataDir = path.join(tmpRoot, 'data');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'line1\nhello world\nline3\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, '.env'), 'SECRET_KEY=super-secret-value\n', 'utf8');

    // Initialize git repo for checkpoint/rollback tests
    await runCommand({ command: 'git', args: ['init'], cwd: workspaceDir });
    await runCommand({
      command: 'git',
      args: ['config', 'user.email', 'test@example.com'],
      cwd: workspaceDir,
    });
    await runCommand({
      command: 'git',
      args: ['config', 'user.name', 'Test User'],
      cwd: workspaceDir,
    });
    await runCommand({ command: 'git', args: ['add', 'hello.txt'], cwd: workspaceDir });
    await runCommand({ command: 'git', args: ['commit', '-m', 'init'], cwd: workspaceDir });
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.shutdown();
      runtime = null;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('lists all 14 tools in full profile, enforces trustSandboxHints, and keeps publish_changes destructive', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'none',
      DATA_DIR: dataDir,
      DATABASE_PATH: ':memory:',
      ALLOWED_WORKSPACE_ROOTS: tmpRoot,
      MCP_TRUST_SANDBOX_HINTS: 'true',
    });
    runtime = createGatewayRuntime(config);

    const listRes = await callMcp(runtime, 'tools/list');
    expect(listRes.status).toBe(200);
    const result = listRes.body.result as { tools: Array<{ name: string; annotations?: Record<string, boolean> }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual([
      'workspace_manage',
      'code_explore',
      'code_patch',
      'workspace_exec',
      'dispatch_agent',
      'job_status',
      'desktop_control',
      'github_inspect',
      'publish_changes',
      'gemini_review',
      'gemini_desktop_status',
      'gemini_chat',
      'gemini_run_task',
      'gemini_sessions',
    ]);

    const patchTool = result.tools.find((t) => t.name === 'code_patch')!;
    expect(patchTool.annotations?.readOnlyHint).toBe(true);
    expect(patchTool.annotations?.destructiveHint).toBe(false);

    const publishTool = result.tools.find((t) => t.name === 'publish_changes')!;
    expect(publishTool.annotations?.readOnlyHint).toBe(false);
    expect(publishTool.annotations?.destructiveHint).toBe(true);
  });

  it('registers workspace, blocks .env reads, patches with Git checkpoint, and rolls back cleanly', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'none',
      DATA_DIR: dataDir,
      DATABASE_PATH: ':memory:',
      ALLOWED_WORKSPACE_ROOTS: tmpRoot,
    });
    runtime = createGatewayRuntime(config);

    // 1. Register workspace
    const reg = await callMcp(runtime, 'tools/call', {
      name: 'workspace_manage',
      arguments: { action: 'register', slug: 'demo', path: workspaceDir },
    });
    expect(reg.status).toBe(200);
    expect((reg.body.result as { isError?: boolean }).isError).not.toBe(true);

    // 2. Block reading .env
    const envRead = await callMcp(runtime, 'tools/call', {
      name: 'code_explore',
      arguments: { mode: 'read_lines', workspace_slug: 'demo', path: '.env' },
    });
    expect((envRead.body.result as { isError?: boolean }).isError).toBe(true);

    // 3. Patch hello.txt
    const patchRes = await callMcp(runtime, 'tools/call', {
      name: 'code_patch',
      arguments: {
        workspace_slug: 'demo',
        action: 'patch',
        edits: [
          {
            path: 'hello.txt',
            hunks: [{ search: 'hello world', replace: 'hello gemini' }],
          },
        ],
      },
    });
    const patchPayload = JSON.parse(
      ((patchRes.body.result as { content: Array<{ text: string }> }).content[0]!).text,
    ) as { checkpointId: string; changedFiles: string[] };
    expect(patchPayload.changedFiles).toEqual(['hello.txt']);
    expect(patchPayload.checkpointId).toMatch(/^cp_/);
    expect(fs.readFileSync(path.join(workspaceDir, 'hello.txt'), 'utf8')).toContain('hello gemini');

    // 4. Rollback to pre-patch checkpoint
    const rbRes = await callMcp(runtime, 'tools/call', {
      name: 'workspace_manage',
      arguments: {
        action: 'rollback',
        slug: 'demo',
        checkpoint_id: patchPayload.checkpointId,
      },
    });
    expect((rbRes.body.result as { isError?: boolean }).isError).not.toBe(true);
    expect(fs.readFileSync(path.join(workspaceDir, 'hello.txt'), 'utf8')).toContain('hello world');

    // 5. Save and recall workspace memory
    await callMcp(runtime, 'tools/call', {
      name: 'workspace_manage',
      arguments: {
        action: 'memory_upsert',
        slug: 'demo',
        memory_category: 'decision',
        memory_key: 'runtime',
        memory_content: 'Use Node 24 built-in sqlite',
        pinned: true,
      },
    });
    const memList = await callMcp(runtime, 'tools/call', {
      name: 'workspace_manage',
      arguments: { action: 'memory_list', slug: 'demo' },
    });
    expect(
      ((memList.body.result as { content: Array<{ text: string }> }).content[0]!).text,
    ).toContain('Use Node 24 built-in sqlite');
  });

  it('completes Gemini-compatible OAuth 2.1 + PKCE S256 + DCR + 3KB state + refresh grace flow', async () => {
    const pwHash = hashPasswordScrypt('operator-secret-pw');
    const config = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_DOMAIN: 'https://mcp.example.com',
      AUTH_MODE: 'oauth',
      OAUTH_SIGNING_SECRET: '0123456789abcdef0123456789abcdef',
      ADMIN_PASSWORD_HASH: pwHash,
      DATA_DIR: dataDir,
      DATABASE_PATH: ':memory:',
      ALLOWED_WORKSPACE_ROOTS: tmpRoot,
    });
    runtime = createGatewayRuntime(config);

    // 1. Unauthenticated /mcp -> 401 with RFC 9728 WWW-Authenticate
    const unauth = await runtime.app.request('https://mcp.example.com/mcp', { method: 'POST' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
    );

    // 2. Discovery endpoints
    const pr = await runtime.app.request(
      'https://mcp.example.com/.well-known/oauth-protected-resource',
    );
    expect(pr.status).toBe(200);
    expect((await pr.json()) as Record<string, unknown>).toMatchObject({
      resource: 'https://mcp.example.com/mcp',
      authorization_servers: ['https://mcp.example.com'],
    });

    // 3. DCR with Google redirect URIs
    const redirectUri = 'https://oauth-redirect.googleusercontent.com/r/gemini-desktop-test';
    const dcr = await runtime.app.request('https://mcp.example.com/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Gemini Connected App',
        redirect_uris: [
          redirectUri,
          'https://vertexaisearch.cloud.google.com/oauth-redirect',
          'http://127.0.0.1:43210/cb',
        ],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(dcr.status).toBe(201);
    const { client_id: clientId } = (await dcr.json()) as { client_id: string };

    // 4. Authorize with 3000-char Gemini state
    const { verifier, challenge } = createPkcePair();
    const longState = 'gem_' + 'AbC0123_-'.repeat(340);
    const authUrl = new URL('https://mcp.example.com/oauth/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('resource', 'https://mcp.example.com/mcp');
    authUrl.searchParams.set('state', longState);

    const getAuth = await runtime.app.request(authUrl.toString());
    expect(getAuth.status).toBe(200);
    const html = await getAuth.text();
    const postAuth = await runtime.app.request('https://mcp.example.com/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        auth_req_id: extractHidden(html, 'auth_req_id'),
        csrf_token: extractHidden(html, 'csrf_token'),
        password: 'operator-secret-pw',
        decision: 'approve',
      }).toString(),
    });
    expect(postAuth.status).toBe(302);
    const cb = new URL(postAuth.headers.get('location')!);
    expect(cb.searchParams.get('state')).toBe(longState);
    const code = cb.searchParams.get('code')!;

    // 5. Exchange code for Bearer token
    const tokRes = await runtime.app.request('https://mcp.example.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: 'https://mcp.example.com/mcp',
      }).toString(),
    });
    expect(tokRes.status).toBe(200);
    const tok = (await tokRes.json()) as { access_token: string; refresh_token: string };

    // 6. Access /mcp with issued access_token
    const authedMcp = await callMcp(
      runtime,
      'tools/list',
      {},
      { Authorization: `Bearer ${tok.access_token}` },
    );
    expect(authedMcp.status).toBe(200);
  });

  it('executes workspace commands, checks desktop system_info, and blocks direct push to main', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'none',
      DATA_DIR: dataDir,
      DATABASE_PATH: ':memory:',
      ALLOWED_WORKSPACE_ROOTS: tmpRoot,
    });
    runtime = createGatewayRuntime(config);

    await callMcp(runtime, 'tools/call', {
      name: 'workspace_manage',
      arguments: { action: 'register', slug: 'demo', path: workspaceDir },
    });

    // workspace_exec sync run
    const execRes = await callMcp(runtime, 'tools/call', {
      name: 'workspace_exec',
      arguments: {
        workspace_slug: 'demo',
        command: 'node',
        args: ['-e', 'console.log("hello-from-exec")'],
      },
    });
    const execText = ((execRes.body.result as { content: Array<{ text: string }> }).content[0]!).text;
    expect(execText).toContain('hello-from-exec');

    // desktop_control(system_info)
    const sysRes = await callMcp(runtime, 'tools/call', {
      name: 'desktop_control',
      arguments: { action: 'system_info' },
    });
    expect((sysRes.body.result as { isError?: boolean }).isError).not.toBe(true);
    const sysText = ((sysRes.body.result as { content: Array<{ text: string }> }).content[0]!).text;
    expect(sysText).toContain('"platform"');

    // publish_changes blocks direct push to main
    const pushMain = await callMcp(runtime, 'tools/call', {
      name: 'publish_changes',
      arguments: {
        action: 'git_commit_push',
        workspace_slug: 'demo',
        branch: 'main',
        commit_message: 'should be blocked',
      },
    });
    expect((pushMain.body.result as { isError?: boolean }).isError).toBe(true);
    const pushErr = ((pushMain.body.result as { content: Array<{ text: string }> }).content[0]!).text;
    expect(pushErr).toContain('protected/default branch');
  });

  it('runs cleanly in --stdio transport mode and responds to initialize + tools/list', async () => {
    const distEntry = path.resolve(process.cwd(), 'dist', 'index.js');
    const requests = [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'vitest-stdio-client', version: '1.0.0' },
        },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    ].join('\n') + '\n';

    const res = await runCommand({
      command: process.execPath,
      args: [distEntry, '--stdio'],
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        DATABASE_PATH: ':memory:',
        ALLOWED_WORKSPACE_ROOTS: tmpRoot,
      },
      stdin: requests,
      timeoutMs: 8000,
    });

    const lines = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const initResp = lines.find((m) => m.id === 1);
    const listResp = lines.find((m) => m.id === 2);
    expect(initResp?.result).toBeTruthy();
    const tools = ((listResp?.result as { tools?: Array<{ name: string }> })?.tools ?? []).map(
      (t) => t.name,
    );
    expect(tools).toContain('workspace_manage');
    expect(tools).toContain('desktop_control');
    expect(tools).toContain('publish_changes');
    expect(tools).toContain('gemini_review');
  });

});
