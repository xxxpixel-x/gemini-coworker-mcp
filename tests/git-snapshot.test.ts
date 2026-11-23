import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitCheckpoint, rollbackToCheckpoint } from '../src/core/gitSnapshot.js';
import { GatewayStore } from '../src/db/sqlite.js';

describe('git checkpoints for a workspace nested inside a larger repository', () => {
  let outer: string;
  let ws: string;
  let store: GatewayStore;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: outer, encoding: 'utf8' }).trim();
  const read = (p: string) => fs.readFileSync(p, 'utf8');

  beforeEach(() => {
    outer = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-coworker-nested-'));
    ws = path.join(outer, 'ws');
    fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test User');
    git('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(outer, 'outer.txt'), 'o1');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'w1');
    fs.writeFileSync(path.join(ws, 'sub', 'b.txt'), 's1');
    git('add', 'outer.txt', 'ws/a.txt');
    git('commit', '-qm', 'init');
    store = new GatewayStore(':memory:');
  });

  afterEach(() => {
    store.close();
    fs.rmSync(outer, { recursive: true, force: true });
  });

  it('restores only the workspace and leaves the real index and outside files alone', async () => {
    fs.writeFileSync(path.join(outer, 'outer.txt'), 'staged');
    git('add', 'outer.txt');
    const stagedBefore = git('diff', '--cached', '--name-only');

    const cp = await createGitCheckpoint(store, 'nested', ws, 'test');
    expect(cp).not.toBeNull();

    fs.writeFileSync(path.join(ws, 'a.txt'), 'w2');
    fs.rmSync(path.join(ws, 'sub', 'b.txt'));
    fs.writeFileSync(path.join(ws, 'new.txt'), 'created after checkpoint');
    fs.writeFileSync(path.join(outer, 'outer.txt'), 'edited outside after checkpoint');
    fs.writeFileSync(path.join(outer, 'late.txt'), 'outside, untracked');

    await rollbackToCheckpoint(store, 'nested', ws, cp!.checkpoint_id);

    expect(read(path.join(ws, 'a.txt'))).toBe('w1');
    expect(read(path.join(ws, 'sub', 'b.txt'))).toBe('s1');
    expect(fs.existsSync(path.join(ws, 'new.txt'))).toBe(false);
    expect(read(path.join(outer, 'outer.txt'))).toBe('edited outside after checkpoint');
    expect(fs.existsSync(path.join(outer, 'late.txt'))).toBe(true);
    expect(git('diff', '--cached', '--name-only')).toBe(stagedBefore);
  });
});
