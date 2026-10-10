import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFixtureClaudeDir, FIXTURE_CLAUDE_DIR, SESSION_ALPHA } from '../../../test/fixtures.ts';
import type { Drift } from './compat/types.ts';
import { goneOn, readRegistry, RegistryWatcher } from './registry.ts';

/** 見本の登録の pid は実在しない。Windows の既定は動いていない pid の項目を読まないので、試験では全部読ませる。 */
const ALL_ALIVE = (): boolean => false;

describe('readRegistry', () => {
  it('json だけを読み、3 値の status と名前を返す', () => {
    expect(readRegistry(FIXTURE_CLAUDE_DIR)).toEqual([
      { sessionId: SESSION_ALPHA, status: 'busy', name: 'channels-cleanup', nameSource: 'user', cwd: '/Users/me/workspace/alpha', pid: 12345, entrypoint: 'cli', statusAt: 1788256800000 },
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
  it('本体が休みで裏の Bash だけが動いている（shell）は、作業中のまま裏だけの印を付ける', () => {
    const dir = copyFixtureClaudeDir();
    try {
      const sessions = path.join(dir, 'sessions');
      fs.rmSync(path.join(sessions, '12345.json'));
      fs.writeFileSync(path.join(sessions, '7.json'), JSON.stringify({ pid: 7, sessionId: 'u-shell', cwd: '/x', status: 'shell' }));
      fs.writeFileSync(path.join(sessions, '8.json'), JSON.stringify({ pid: 8, sessionId: 'u-busy', cwd: '/y', status: 'busy' }));
      expect(readRegistry(dir, ALL_ALIVE)).toEqual([
        { sessionId: 'u-busy', status: 'busy', name: null, nameSource: null, cwd: '/y', pid: 8 },
        { sessionId: 'u-shell', status: 'busy', name: null, nameSource: null, cwd: '/x', pid: 7, aside: { shell: true, agents: 0 } },
      ]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('動きが変わった時刻（statusUpdatedAt）があれば statusAt に写す', () => {
    const dir = copyFixtureClaudeDir();
    try {
      const sessions = path.join(dir, 'sessions');
      fs.rmSync(path.join(sessions, '12345.json'));
      fs.writeFileSync(path.join(sessions, '7.json'), JSON.stringify({ pid: 7, sessionId: 'u-at', cwd: '/x', status: 'busy', statusUpdatedAt: 1791350329516 }));
      fs.writeFileSync(path.join(sessions, '8.json'), JSON.stringify({ pid: 8, sessionId: 'u-bad', cwd: '/y', status: 'busy', statusUpdatedAt: 'x' }));
      expect(readRegistry(dir, ALL_ALIVE)).toEqual([
        { sessionId: 'u-at', status: 'busy', name: null, nameSource: null, cwd: '/x', pid: 7, statusAt: 1791350329516 },
        { sessionId: 'u-bad', status: 'busy', name: null, nameSource: null, cwd: '/y', pid: 8 },
      ]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('読み直しのたびに、裏だけの印を足す関数を通す', () => {
    const dir = copyFixtureClaudeDir();
    try {
      const w = new RegistryWatcher(dir, 1_000_000, ALL_ALIVE, (live) => live.map((l) => ({ ...l, aside: { shell: false, agents: 2 } })));
      w.start();
      expect(w.current()[0]!.aside).toEqual({ shell: false, agents: 2 });
      w.stop();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('ディレクトリが無ければ空', () => {
    expect(readRegistry('/nonexistent')).toEqual([]);
  });
  it('配列や null の登録は読まずにずれとして知らせ、ほかの登録は読み続ける', () => {
    const dir = copyFixtureClaudeDir();
    try {
      const sessions = path.join(dir, 'sessions');
      fs.writeFileSync(path.join(sessions, '7.json'), '[]');
      fs.writeFileSync(path.join(sessions, '8.json'), 'null');
      const seen: Drift[] = [];
      expect(readRegistry(dir, ALL_ALIVE, (d) => seen.push(d)).map((l) => l.sessionId)).toEqual([SESSION_ALPHA]);
      expect(seen).toEqual([
        { contract: 'registry', value: 'entry=(not-object)', version: null },
        { contract: 'registry', value: 'entry=(not-object)', version: null },
      ]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('知らない status は作業中として読み、登録の版を添えてずれとして知らせる', () => {
    const dir = copyFixtureClaudeDir();
    try {
      const sessions = path.join(dir, 'sessions');
      fs.rmSync(path.join(sessions, '12345.json'));
      fs.writeFileSync(path.join(sessions, '7.json'), JSON.stringify({ pid: 7, sessionId: 'u-new', cwd: '/x', status: 'thinking', version: '2.1.300' }));
      const seen: Drift[] = [];
      expect(readRegistry(dir, ALL_ALIVE, (d) => seen.push(d))).toEqual([{ sessionId: 'u-new', status: 'busy', name: null, nameSource: null, cwd: '/x', pid: 7 }]);
      expect(seen).toEqual([{ contract: 'registry', value: 'status=thinking', version: '2.1.300' }]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE);
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
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE);
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

  // Claude Code は、一時のファイルからの改名に失敗すると、登録をその場で書き直す（切り詰めてから書く）。
  // その間に読むと、中身が空か途中までになる。消えたと読むと、終わったセッションとして待っている問いまで消える。
  it('書きかけで読めない登録は、前に読めた中身のまま続け、知らせない', () => {
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE);
    const seen: unknown[] = [];
    w.onChange((l) => seen.push(l));
    w.start();
    const before = w.current();
    expect(before).toHaveLength(1);
    const file = path.join(dir, 'sessions/12345.json');
    const text = fs.readFileSync(file, 'utf8');
    for (const partial of ['', text.slice(0, 20)]) {
      fs.writeFileSync(file, partial);
      vi.advanceTimersByTime(500);
      expect(w.current()).toEqual(before);
      fs.writeFileSync(file, text);
      vi.advanceTimersByTime(500);
    }
    expect(seen).toEqual([]);
    w.stop();
  });

  it('読めないままが続けば、その登録は読まない', () => {
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE);
    const seen: unknown[] = [];
    w.onChange((l) => seen.push(l));
    w.start();
    fs.writeFileSync(path.join(dir, 'sessions/12345.json'), '{"pid":');
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([[]]);
    expect(w.current()).toEqual([]);
    w.stop();
  });

  it('はじめから読めない登録は読まない。消えた登録は次の読み直しで外す', () => {
    const sessions = path.join(dir, 'sessions');
    fs.writeFileSync(path.join(sessions, '99.json'), '{"pid":');
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE);
    w.start();
    expect(w.current().map((l) => l.pid)).toEqual([12345]);
    fs.rmSync(path.join(sessions, '12345.json'));
    vi.advanceTimersByTime(500);
    expect(w.current()).toEqual([]);
    w.stop();
  });

  it('ずれは登録が変わったときだけ数え、同じ登録の読み直しでは数えない', () => {
    const file = path.join(dir, 'sessions/12345.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...rec, status: 'thinking' }));
    const seen: Drift[] = [];
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE, undefined, { note: (d) => seen.push(d) });
    w.start();
    vi.advanceTimersByTime(1500);
    expect(seen.map((d) => d.value)).toEqual(['status=thinking']);
    fs.writeFileSync(file, JSON.stringify({ ...rec, status: 'thinking', statusUpdatedAt: rec.statusUpdatedAt + 1 }));
    vi.advanceTimersByTime(500);
    expect(seen.map((d) => d.value)).toEqual(['status=thinking', 'status=thinking']);
    w.stop();
  });

  // Claude Code は、登録を status の無い形で書き始め、すぐ後に status を足す（2.1.295 で確かめた）。
  // その間に読んだ 1 回の欠けは形のずれではないので、同じ登録で続けて欠けていたときだけ数える。
  it('status の欠けは、同じ登録で続けて 2 回読んだときに 1 件だけ数える', () => {
    const file = path.join(dir, 'sessions/12345.json');
    const { status: _s, ...rec } = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify(rec));
    const seen: Drift[] = [];
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE, undefined, { note: (d) => seen.push(d) });
    w.start();
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(seen.map((d) => d.value)).toEqual(['status=(missing)']);
    // 欠けたままの読み直しでは数えない。
    vi.advanceTimersByTime(2000);
    expect(seen).toHaveLength(1);
    w.stop();
  });

  it('1 回だけの status の欠けは数えない', () => {
    const file = path.join(dir, 'sessions/12345.json');
    const full = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const { status: _s, ...rec } = full;
    fs.writeFileSync(file, JSON.stringify(rec));
    const seen: Drift[] = [];
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE, undefined, { note: (d) => seen.push(d) });
    w.start();
    fs.writeFileSync(file, JSON.stringify(full));
    vi.advanceTimersByTime(2000);
    // 間に 1 回見えたら数え直す。欠けがまた 1 回だけなら、やはり数えない。
    fs.writeFileSync(file, JSON.stringify(rec));
    vi.advanceTimersByTime(500);
    fs.writeFileSync(file, JSON.stringify(full));
    vi.advanceTimersByTime(2000);
    expect(seen).toEqual([]);
    w.stop();
  });

  it('status の欠けは登録（sessionId と pid）ごとに数え、会話が変われば数え直す', () => {
    const file = path.join(dir, 'sessions/12345.json');
    const { status: _s, ...rec } = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...rec, sessionId: 'u-a' }));
    const seen: Drift[] = [];
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE, undefined, { note: (d) => seen.push(d) });
    w.start();
    // 同じ pid のファイルで、別の会話の登録が 1 回欠けた。続けての欠けではない。
    fs.writeFileSync(file, JSON.stringify({ ...rec, sessionId: 'u-b' }));
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(seen.map((d) => d.value)).toEqual(['status=(missing)']);
    w.stop();
  });

  it('status の欠けが続いている登録は、renoteDrifts() の後に 1 回だけ数え直す', () => {
    const file = path.join(dir, 'sessions/12345.json');
    const { status: _s, ...rec } = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify(rec));
    const seen: Drift[] = [];
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE, undefined, { note: (d) => seen.push(d) });
    w.start();
    vi.advanceTimersByTime(1000);
    expect(seen).toHaveLength(1);
    w.renoteDrifts();
    vi.advanceTimersByTime(1500);
    expect(seen.map((d) => d.value)).toEqual(['status=(missing)', 'status=(missing)']);
    w.stop();
  });

  it('ほかのずれは、1 回の読み取りでも数える', () => {
    // 一瞬だけ欠けうるのは status だけで、知らない status、無い sessionId と pid は待たない。
    const file = path.join(dir, 'sessions/12345.json');
    const { pid: _p, ...rec } = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...rec, status: 'thinking' }));
    const seen: Drift[] = [];
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE, undefined, { note: (d) => seen.push(d) });
    w.start();
    expect(seen.map((d) => d.value)).toEqual(['pid=(missing)', 'status=thinking']);
    w.stop();
  });

  it('renoteDrifts() の後は、登録が同じでも次の読み直しで 1 回だけ数え直す', () => {
    // ずれの記録が手元の版の変化で空になったとき、残っている登録のずれを数え直すために使う。
    const file = path.join(dir, 'sessions/12345.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...rec, status: 'thinking' }));
    const seen: Drift[] = [];
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE, undefined, { note: (d) => seen.push(d) });
    const changes: unknown[] = [];
    w.onChange((l) => changes.push(l));
    w.start();
    vi.advanceTimersByTime(1000);
    expect(seen.map((d) => d.value)).toEqual(['status=thinking']);
    w.renoteDrifts();
    vi.advanceTimersByTime(1500);
    expect(seen.map((d) => d.value)).toEqual(['status=thinking', 'status=thinking']);
    // 登録は変わっていないので、live の知らせは出さない。
    expect(changes).toEqual([]);
    w.stop();
  });

  it('読み飛ばす登録が動いているセッションの隣に増えたら、live が変わらなくても 1 回だけ数える', () => {
    const seen: Drift[] = [];
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE, undefined, { note: (d) => seen.push(d) });
    w.start();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);
    fs.writeFileSync(path.join(dir, 'sessions/7.json'), '[]');
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([{ contract: 'registry', value: 'entry=(not-object)', version: null }]);
    vi.advanceTimersByTime(1500);
    expect(seen).toHaveLength(1);
    w.stop();
  });

  it('ずれの受け口が投げても、登録の読み取りと通知は続ける', () => {
    const file = path.join(dir, 'sessions/12345.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...rec, status: 'thinking' }));
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE, undefined, { note: () => { throw new Error('sink'); } });
    const changes: unknown[] = [];
    w.onChange((l) => changes.push(l));
    try {
      expect(() => w.start()).not.toThrow();
      // 知らない status は作業中と読む。
      expect(w.current().map((l) => l.status)).toEqual(['busy']);
      // 登録が変わり、読み飛ばす登録のずれも出る。受け口はまた投げる。
      fs.writeFileSync(file, JSON.stringify({ ...rec, status: 'idle' }));
      fs.writeFileSync(path.join(dir, 'sessions/7.json'), '[]');
      expect(() => vi.advanceTimersByTime(500)).not.toThrow();
      expect(w.current().map((l) => l.status)).toEqual(['idle']);
      expect(changes).toHaveLength(1);
    } finally {
      w.stop();
    }
  });

  it('登録が同じなら、裏だけの印などの付け足しが変わってもずれを数え直さない', () => {
    const file = path.join(dir, 'sessions/12345.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...rec, status: 'thinking' }));
    const seen: Drift[] = [];
    let n = 0;
    // 読み直しのたびに出力が変わる（本文の索引が進むと印が変わるのと同じ）。登録のファイルは変わらない。
    const enrich = (live: ReturnType<typeof readRegistry>) => live.map((l) => ({ ...l, aside: { shell: false, agents: ++n } }));
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE, enrich, { note: (d) => seen.push(d) });
    const changes: unknown[] = [];
    w.onChange((l) => changes.push(l));
    w.start();
    vi.advanceTimersByTime(2000);
    expect(changes.length).toBeGreaterThan(1);
    expect(seen.map((d) => d.value)).toEqual(['status=thinking']);
    w.stop();
  });
});

// Windows では claude を穏やかに止める手段が無く、止めた claude は自分の登録を消せない。
// 残った登録を「動いている」と読むと、引き取りも再開も「hangar の外で動いている」と断ってしまう。
describe('readRegistry（消えたプロセスの登録）', () => {
  it('isGone が真を返す pid の項目は読まない。既定では全部読む', () => {
    const dir = copyFixtureClaudeDir();
    try {
      const sessions = path.join(dir, 'sessions');
      fs.rmSync(path.join(sessions, '12345.json'));
      fs.writeFileSync(path.join(sessions, '7.json'), JSON.stringify({ pid: 7, sessionId: 'u-dead', cwd: '/x', status: 'idle' }));
      fs.writeFileSync(path.join(sessions, '8.json'), JSON.stringify({ pid: 8, sessionId: 'u-alive', cwd: '/y', status: 'idle' }));
      expect(readRegistry(dir).map((l) => l.sessionId)).toEqual(['u-alive', 'u-dead']);
      expect(readRegistry(dir, (pid) => pid === 7).map((l) => l.sessionId)).toEqual(['u-alive']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('Windows では、動いていない pid を消えたと見る。ほかの OS では見ない', () => {
    // 動いている pid（この試験のプロセス）と、動いていない pid。
    expect(goneOn('win32')(process.pid)).toBe(false);
    expect(goneOn('win32')(2 ** 30)).toBe(true);
    expect(goneOn('darwin')(2 ** 30)).toBe(false);
    expect(goneOn('linux')(2 ** 30)).toBe(false);
    // pid が読めなかった項目（0）は、消えたとは決めない。
    expect(goneOn('win32')(0)).toBe(false);
  });
});
