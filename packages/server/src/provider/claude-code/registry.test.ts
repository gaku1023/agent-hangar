import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFixtureClaudeDir, FIXTURE_CLAUDE_DIR, SESSION_ALPHA } from '../../../test/fixtures.ts';
import { readRegistry, RegistryWatcher } from './registry.ts';

describe('readRegistry', () => {
  it('json だけを読み、3 値の status と名前を返す', () => {
    expect(readRegistry(FIXTURE_CLAUDE_DIR)).toEqual([
      { sessionId: SESSION_ALPHA, status: 'busy', name: 'channels-cleanup', nameSource: 'user', cwd: '/Users/me/workspace/alpha', pid: 12345, entrypoint: 'cli' },
    ]);
  });
  it('バックグラウンドのセッションには jobId を、起動時刻があれば procStart を付ける', () => {
    const dir = copyFixtureClaudeDir();
    try {
      const sessions = path.join(dir, 'sessions');
      fs.rmSync(path.join(sessions, '12345.json'));
      fs.writeFileSync(path.join(sessions, '7.json'), JSON.stringify({ pid: 7, sessionId: 'u-bg', cwd: '/x', status: 'idle', kind: 'bg', jobId: 'abcd1234', procStart: 'Wed Sep 30 07:07:49 2026' }));
      fs.writeFileSync(path.join(sessions, '8.json'), JSON.stringify({ pid: 8, sessionId: 'u-it', cwd: '/y', status: 'waiting', kind: 'interactive', procStart: 'Wed Sep 30 03:01:55 2026', entrypoint: 'cli' }));
      // bg でも jobId が無ければ attach できないので、バックグラウンドとは扱わない。
      fs.writeFileSync(path.join(sessions, '9.json'), JSON.stringify({ pid: 9, sessionId: 'u-nojob', cwd: '/z', status: 'idle', kind: 'bg' }));
      expect(readRegistry(dir)).toEqual([
        { sessionId: 'u-bg', status: 'idle', name: null, nameSource: null, cwd: '/x', pid: 7, background: { jobId: 'abcd1234' }, procStart: 'Wed Sep 30 07:07:49 2026' },
        { sessionId: 'u-it', status: 'waiting', name: null, nameSource: null, cwd: '/y', pid: 8, procStart: 'Wed Sep 30 03:01:55 2026', entrypoint: 'cli' },
        { sessionId: 'u-nojob', status: 'idle', name: null, nameSource: null, cwd: '/z', pid: 9 },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('ディレクトリが無ければ空', () => {
    expect(readRegistry('/nonexistent')).toEqual([]);
  });
});

describe('RegistryWatcher', () => {
  let dir: string;
  beforeEach(() => { dir = copyFixtureClaudeDir(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('読めないディレクトリでも落ちず、読めるようになったら通知する', () => {
    const sessions = path.join(dir, 'sessions');
    fs.rmSync(path.join(sessions, '12345.json'));
    fs.chmodSync(sessions, 0o000);
    const w = new RegistryWatcher(dir, 500);
    const seen: unknown[] = [];
    w.onChange((l) => seen.push(l));
    try {
      expect(() => w.start()).not.toThrow();
      expect(() => vi.advanceTimersByTime(1500)).not.toThrow();
      expect(seen).toHaveLength(0);
      fs.chmodSync(sessions, 0o700);
      fs.writeFileSync(path.join(sessions, '99.json'), JSON.stringify({ pid: 99, sessionId: SESSION_ALPHA, cwd: '/x', status: 'idle' }));
      vi.advanceTimersByTime(500);
      expect(seen).toHaveLength(1);
    } finally {
      fs.chmodSync(sessions, 0o700);
      w.stop();
    }
  });

  it('変化したときだけ通知する', () => {
    const w = new RegistryWatcher(dir, 500);
    const seen: unknown[] = [];
    w.onChange((l) => seen.push(l));
    w.start();
    expect(w.current()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(seen).toHaveLength(0);
    const file = path.join(dir, 'sessions/12345.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...rec, status: 'idle' }));
    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { status: string }[])[0]!.status).toBe('idle');
    fs.rmSync(file);
    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([]);
    w.stop();
  });
});
