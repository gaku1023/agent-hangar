import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as realSpawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceEvent } from '@agent-hangar/shared';
import { VoiceHelper, resolveVoiceBin } from './helper.ts';

const FIXTURE = path.join(import.meta.dirname, '../../test/fixtures/fakeVoiceHelper.mjs');
const fixtureSpawn = (mode: string) => ((_bin: string, args: readonly string[], opts: object) =>
  realSpawn(process.execPath, [FIXTURE], { ...opts, env: { ...process.env, FAKE_VOICE_MODE: mode } })) as unknown as typeof realSpawn;

function until(cond: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (cond() ? resolve() : Date.now() - t0 > ms ? reject(new Error('timeout')) : setTimeout(tick, 10));
    tick();
  });
}

describe('resolveVoiceBin', () => {
  it('darwin 以外は null', () => {
    expect(resolveVoiceBin({ HANGAR_VOICE_BIN: '/x' }, 'win32', () => true)).toBeNull();
    expect(resolveVoiceBin({}, 'linux', () => true)).toBeNull();
  });
  it('HANGAR_VOICE_BIN があり実在すればそれ、無ければ開発用のパス、どちらも無ければ null', () => {
    expect(resolveVoiceBin({ HANGAR_VOICE_BIN: '/x/hv' }, 'darwin', (p) => p === '/x/hv')).toBe('/x/hv');
    const dev = resolveVoiceBin({}, 'darwin', (p) => p.endsWith('apps/voice-mac/dist/hangar-voice'));
    expect(dev).toMatch(/apps\/voice-mac\/dist\/hangar-voice$/);
    expect(resolveVoiceBin({}, 'darwin', () => false)).toBeNull();
  });
});

describe('VoiceHelper（偽の補助）', () => {
  let h: VoiceHelper | null = null;
  afterEach(async () => { await h?.stop(); h = null; });

  it('bin が null なら unavailable で何も起こさない', () => {
    const spawn = vi.fn();
    h = new VoiceHelper({ bin: null, spawn: spawn as unknown as typeof realSpawn });
    h.start();
    h.send({ cmd: 'flush' });
    expect(h.status).toBe('unavailable');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('起動して ready まで進み、命令に答える', async () => {
    h = new VoiceHelper({ bin: '/fake', spawn: fixtureSpawn('ok') });
    const events: VoiceEvent[] = [];
    h.on('event', (e: VoiceEvent) => events.push(e));
    h.start();
    expect(h.status).toBe('starting');
    await until(() => h!.status === 'ready');
    h.send({ cmd: 'flush' });
    await until(() => events.some((e) => e.ev === 'flushed'));
    expect(events[0]).toEqual({ ev: 'ready', version: 'fake-1' });
  });

  it('壊れた行は捨てて落ちない', async () => {
    h = new VoiceHelper({ bin: '/fake', spawn: fixtureSpawn('garbage') });
    const events: VoiceEvent[] = [];
    h.on('event', (e: VoiceEvent) => events.push(e));
    h.start();
    await until(() => h!.status === 'ready');
    expect(events).toEqual([{ ev: 'ready', version: 'fake-1' }]);
  });

  it('ev を持っていても形の合わない行は捨てて流さない', async () => {
    h = new VoiceHelper({ bin: '/fake', spawn: fixtureSpawn('malformed') });
    const events: VoiceEvent[] = [];
    h.on('event', (e: VoiceEvent) => events.push(e));
    h.start();
    await until(() => h!.status === 'ready');
    expect(events).toEqual([{ ev: 'ready', version: 'fake-1' }]);
  });

  it('stop で quit を送って止まり、unavailable になる', async () => {
    h = new VoiceHelper({ bin: '/fake', spawn: fixtureSpawn('ok') });
    h.start();
    await until(() => h!.status === 'ready');
    await h.stop();
    expect(h.status).toBe('unavailable');
  });
});

describe('VoiceHelper の見張り', () => {
  afterEach(() => { vi.useRealTimers(); });

  function fakeChild() {
    const c = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: () => void };
    c.stdout = new PassThrough();
    c.stdin = new PassThrough();
    c.kill = () => {};
    return c;
  }

  it('helper crash marks unavailable and restarts with backoff', () => {
    vi.useFakeTimers();
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = vi.fn(() => { const c = fakeChild(); children.push(c); return c; });
    let t = 0;
    const h = new VoiceHelper({ bin: '/fake', spawn: spawn as unknown as typeof realSpawn, now: () => t });
    h.start();
    expect(spawn).toHaveBeenCalledTimes(1);

    // 1 秒、2 秒、4 秒、8 秒と間を空けて起こし直す。
    for (const [i, wait] of [1000, 2000, 4000, 8000].entries()) {
      children[i]!.emit('exit', 1, null);
      expect(h.status).toBe('crashed');
      vi.advanceTimersByTime(wait - 1);
      expect(spawn).toHaveBeenCalledTimes(i + 1);
      vi.advanceTimersByTime(1);
      expect(spawn).toHaveBeenCalledTimes(i + 2);
      expect(h.status).toBe('starting');
    }
    // 5 回続けて落ちたら止まる。
    children[4]!.emit('exit', 1, null);
    expect(h.status).toBe('unavailable');
    vi.advanceTimersByTime(60_000);
    expect(spawn).toHaveBeenCalledTimes(5);
  });

  it('stop は quit、2 秒で SIGTERM、さらに 2 秒で SIGKILL を送り、応じない補助でも 5 秒で解決する', async () => {
    vi.useFakeTimers();
    const kills: (string | undefined)[] = [];
    const quits: string[] = [];
    const c = fakeChild();
    c.kill = (sig?: string) => { kills.push(sig); };
    c.stdin.write = ((b: string) => { quits.push(String(b)); return true; }) as typeof c.stdin.write;
    const h = new VoiceHelper({ bin: '/fake', spawn: (() => c) as unknown as typeof realSpawn });
    h.start();
    let done = false;
    const p = h.stop().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(quits.join('')).toContain('"quit"');
    expect(kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(done).toBe(true);
    expect(h.status).toBe('unavailable');
  });

  it('stop は補助が quit で終われば待たずに解決し、強く止めない', async () => {
    vi.useFakeTimers();
    const kills: (string | undefined)[] = [];
    const c = fakeChild();
    c.kill = (sig?: string) => { kills.push(sig); };
    c.stdin.on('data', () => { c.emit('exit', 0, null); });
    const h = new VoiceHelper({ bin: '/fake', spawn: (() => c) as unknown as typeof realSpawn });
    h.start();
    await h.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kills).toEqual([]);
  });

  it('長く動いてから落ちたら数え直す', () => {
    vi.useFakeTimers();
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = vi.fn(() => { const c = fakeChild(); children.push(c); return c; });
    let t = 0;
    const h = new VoiceHelper({ bin: '/fake', spawn: spawn as unknown as typeof realSpawn, now: () => t });
    h.start();
    children[0]!.emit('exit', 1, null);
    vi.advanceTimersByTime(1000);
    t += 120_000;
    children[1]!.emit('exit', 1, null);
    vi.advanceTimersByTime(1000); // 数え直したので 1 秒で起こす
    expect(spawn).toHaveBeenCalledTimes(3);
  });
});
