import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Captured } from '../platform/capture.ts';
import { ghLoginResolver } from './ghLogin.ts';

const ok = (stdout: string): Captured => ({ code: 0, stdout, stderr: '' });

// findTool が見つける、中身の無い gh を置く。
// 呼ぶのは差し替えた capture で、これは実行しない。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-gh-'));
fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'gh.exe' : 'gh'), '', { mode: 0o755 });
const env: NodeJS.ProcessEnv = { ...process.env, PATH: dir, Path: dir };
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('ghLoginResolver', () => {
  it('asks gh api user once and remembers the login', async () => {
    const calls: string[][] = [];
    const resolve = ghLoginResolver({ env, capture: async (_f, args) => { calls.push(args); return ok('alice\n'); } });
    expect(await Promise.all([resolve(), resolve()])).toEqual(['alice', 'alice']);
    expect(await resolve()).toBe('alice');
    expect(calls).toEqual([['api', 'user', '--jq', '.login']]);
  });

  it('returns null and waits before asking again when gh fails', async () => {
    let n = 0;
    let t = 1000;
    const resolve = ghLoginResolver({ env, now: () => t, capture: async () => { n++; return n === 1 ? { code: 1, stdout: '', stderr: 'x' } : ok('bob'); } });
    expect(await resolve()).toBeNull();
    expect(await resolve()).toBeNull();
    expect(n).toBe(1);
    t += 6 * 60_000;
    expect(await resolve()).toBe('bob');
  });

  it('rejects output that is not a login, and a capture that throws', async () => {
    expect(await ghLoginResolver({ env, capture: async () => ok('not a login\nsecond') })()).toBeNull();
    expect(await ghLoginResolver({ env, capture: async () => { throw new Error('spawn'); } })()).toBeNull();
  });
});
