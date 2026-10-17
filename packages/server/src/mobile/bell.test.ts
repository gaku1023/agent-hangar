import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { COMPAT_HEADER, COMPAT_VERSION } from '@agent-hangar/shared';
import { FakeTimers } from '../../test/fake-timers.ts';
import type { BellTarget } from '../sync/client.ts';
import { BELL_PING_MS, BELL_PONG_TIMEOUT_MS, BELL_RETRY_MAX_MS, BELL_RETRY_MIN_MS, MobileBell } from './bell.ts';

/** Worker の /m/bell の真似。受けた見出し、つながり、届いた文面を覚える。 */
async function fakeWorker(o: { reject?: number | false; pong?: boolean } = {}) {
  const state: { reject: number | false; pong: boolean } = { reject: o.reject ?? false, pong: o.pong ?? true };
  const attempts: IncomingHttpHeaders[] = [];
  const conns: WebSocket[] = [];
  const received: string[] = [];
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (info, cb) => {
      attempts.push(info.req.headers);
      if (state.reject !== false) cb(false, state.reject);
      else cb(true);
    },
  });
  wss.on('connection', (ws) => {
    conns.push(ws);
    ws.on('message', (d) => {
      const s = d.toString();
      received.push(s);
      if (s === 'ping' && state.pong) ws.send('pong');
    });
  });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/m/bell`;
  const open = () => conns.filter((c) => c.readyState === c.OPEN);
  return { wss, url, attempts, conns, received, open, state, close: () => new Promise<void>((r) => { for (const c of conns) c.terminate(); wss.close(() => r()); }) };
}

const settle = (cond: () => boolean): Promise<void> => vi.waitFor(() => { if (!cond()) throw new Error('not yet'); }, { timeout: 3000, interval: 5 });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function setup(o: { reject?: number | false; pong?: boolean; target?: BellTarget | null } = {}) {
  const w = await fakeWorker(o);
  const timers = new FakeTimers();
  let target: BellTarget | null = o.target === undefined ? { url: w.url, headers: { authorization: 'Bearer pc-token', [COMPAT_HEADER]: String(COMPAT_VERSION) } } : o.target;
  const onLaunch = vi.fn();
  const onAsk = vi.fn(async (id: string, sealed: string): Promise<string | null> => (sealed === 'unopenable' ? null : `reply-for-${id}`));
  const bell = new MobileBell({ target: () => target, onLaunch, onAsk, timers });
  cleanups.push(() => bell.stop(), () => w.close());
  return { w, timers, bell, onLaunch, onAsk, setTarget: (t: BellTarget | null) => { target = t; } };
}

describe('MobileBell', () => {
  it('つなぎ先が無いあいだはつながない。現れたら Bearer と互換の版の見出しでつなぐ', async () => {
    const s = await setup({ target: null });
    s.bell.check();
    await new Promise((r) => setTimeout(r, 30));
    expect(s.w.attempts).toHaveLength(0);
    expect(s.bell.state()).toBe('idle');
    s.setTarget({ url: s.w.url, headers: { authorization: 'Bearer pc-token', [COMPAT_HEADER]: String(COMPAT_VERSION) } });
    s.bell.check();
    await settle(() => s.bell.state() === 'open');
    expect(s.w.attempts).toHaveLength(1);
    expect(s.w.attempts[0]!.authorization).toBe('Bearer pc-token');
    expect(s.w.attempts[0]![COMPAT_HEADER]).toBe(String(COMPAT_VERSION));
    // つながっている間の check は何もしない。
    s.bell.check();
    await new Promise((r) => setTimeout(r, 30));
    expect(s.w.attempts).toHaveLength(1);
  });

  it('{t:launch} で onLaunch を呼ぶ', async () => {
    const s = await setup();
    s.bell.check();
    await settle(() => s.w.open().length === 1);
    s.w.open()[0]!.send(JSON.stringify({ t: 'launch' }));
    await settle(() => s.onLaunch.mock.calls.length === 1);
  });

  it('{t:ask} を onAsk に渡し、答えを {t:reply} で返す。開けないもの（null）には答えない', async () => {
    const s = await setup();
    s.bell.check();
    await settle(() => s.w.open().length === 1);
    const ws = s.w.open()[0]!;
    ws.send(JSON.stringify({ t: 'ask', id: 'q0', sealed: 'unopenable' }));
    ws.send(JSON.stringify({ t: 'ask', id: 'q1', sealed: 'sealed-body' }));
    await settle(() => s.w.received.some((x) => x.includes('q1')));
    expect(s.onAsk).toHaveBeenCalledWith('q1', 'sealed-body');
    expect(s.w.received.map((x) => JSON.parse(x) as unknown)).toEqual([{ t: 'reply', id: 'q1', sealed: 'reply-for-q1' }]);
  });

  it('形の違う文面は無視して落ちない', async () => {
    const s = await setup();
    s.bell.check();
    await settle(() => s.w.open().length === 1);
    const ws = s.w.open()[0]!;
    for (const bad of ['not json', '{"t":"ask"}', '{"t":"ask","id":1,"sealed":"x"}', '{"t":"other"}', 'null']) ws.send(bad);
    ws.send(JSON.stringify({ t: 'launch' }));
    await settle(() => s.onLaunch.mock.calls.length === 1);
    expect(s.onAsk).not.toHaveBeenCalled();
    expect(s.bell.state()).toBe('open');
  });

  it('30 秒ごとに ping を送る', async () => {
    const s = await setup();
    s.bell.check();
    await settle(() => s.bell.state() === 'open');
    await s.timers.advance(BELL_PING_MS - 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.w.received).toEqual([]);
    await s.timers.advance(1);
    await settle(() => s.w.received.length === 1);
    expect(s.w.received).toEqual(['ping']);
    expect(BELL_PING_MS).toBe(30_000);
  });

  it('75 秒 pong が無ければ切って張り直す。pong が来ていれば張り直さない', async () => {
    const s = await setup({ pong: false });
    s.bell.check();
    await settle(() => s.bell.state() === 'open');
    await s.timers.advance(BELL_PONG_TIMEOUT_MS - 1);
    expect(s.bell.state()).toBe('open');
    await s.timers.advance(1);
    await settle(() => s.bell.state() === 'waiting');
    await s.timers.advance(BELL_RETRY_MIN_MS);
    await settle(() => s.w.attempts.length === 2 && s.bell.state() === 'open');
    expect(BELL_PONG_TIMEOUT_MS).toBe(75_000);

    // pong を返すようにすると、30 秒ごとの ping で生きていると分かり、張り直さない。
    s.w.state.pong = true;
    for (let i = 0; i < 6; i++) {
      await s.timers.advance(BELL_PING_MS);
      await settle(() => s.w.received.filter((x) => x === 'ping').length >= i + 1 + 2);
    }
    expect(s.w.attempts).toHaveLength(2);
    expect(s.bell.state()).toBe('open');
  });

  it('つなげなければ 1、2、4… 秒と倍に待ち、60 秒で頭打ちにして張り直す', async () => {
    const s = await setup({ reject: 500 });
    s.bell.check();
    await settle(() => s.bell.state() === 'waiting');
    expect(s.w.attempts).toHaveLength(1);
    const waits = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
    for (const [i, ms] of waits.entries()) {
      await s.timers.advance(ms - 1);
      expect(s.w.attempts).toHaveLength(i + 1);
      await s.timers.advance(1);
      await settle(() => s.w.attempts.length === i + 2 && s.bell.state() === 'waiting');
    }
    expect(BELL_RETRY_MIN_MS).toBe(1000);
    expect(BELL_RETRY_MAX_MS).toBe(60_000);
  });

  for (const status of [401, 403]) {
    it(`${status} で断られたら張り直さず、つなぎ先が変わるまで止める`, async () => {
      const s = await setup({ reject: status });
      s.bell.check();
      await settle(() => s.w.attempts.length === 1 && s.bell.state() === 'idle');
      await s.timers.advance(BELL_RETRY_MAX_MS * 3);
      s.bell.check();
      await new Promise((r) => setTimeout(r, 30));
      expect(s.w.attempts).toHaveLength(1);
      expect(s.bell.state()).toBe('idle');
      expect(s.timers.pendingCount()).toBe(0);
      // トークンを読み直した（つなぎ先が変わった）ら、もう一度試す。
      s.w.state.reject = false;
      s.setTarget({ url: s.w.url, headers: { authorization: 'Bearer renewed' } });
      s.bell.check();
      await settle(() => s.w.attempts.length === 2 && s.bell.state() === 'open');
    });
  }

  it('断られた後につなぎ先が一度無くなり、同じ先が戻ったら、もう一度試す', async () => {
    const s = await setup({ reject: 401 });
    s.bell.check();
    await settle(() => s.w.attempts.length === 1 && s.bell.state() === 'idle');
    // クラウドから抜けて、同じ先とトークンで入り直した。
    s.setTarget(null);
    s.bell.check();
    s.w.state.reject = false;
    s.setTarget({ url: s.w.url, headers: { authorization: 'Bearer pc-token', [COMPAT_HEADER]: String(COMPAT_VERSION) } });
    s.bell.check();
    await settle(() => s.w.attempts.length === 2 && s.bell.state() === 'open');
  });

  for (const status of [503, 404, 426]) {
    it(`${status}（呼び鈴の無い Worker）では、待ちを上限の 60 秒にして張り直す`, async () => {
      const s = await setup({ reject: status });
      s.bell.check();
      await settle(() => s.w.attempts.length === 1 && s.bell.state() === 'waiting');
      await s.timers.advance(BELL_RETRY_MAX_MS - 1);
      expect(s.w.attempts).toHaveLength(1);
      await s.timers.advance(1);
      await settle(() => s.w.attempts.length === 2 && s.bell.state() === 'waiting');
      await s.timers.advance(BELL_RETRY_MAX_MS - 1);
      expect(s.w.attempts).toHaveLength(2);
    });
  }

  it('同じ PC の新しいつながりに替えられた（4000）ら、待ちを上限の 60 秒にして張り直す', async () => {
    const s = await setup();
    s.bell.check();
    await settle(() => s.w.open().length === 1);
    s.w.open()[0]!.close(4000, 'replaced');
    await settle(() => s.bell.state() === 'waiting');
    await s.timers.advance(BELL_RETRY_MAX_MS - 1);
    expect(s.w.attempts).toHaveLength(1);
    await s.timers.advance(1);
    await settle(() => s.w.attempts.length === 2 && s.bell.state() === 'open');
  });

  it('つながって pong を受けたら、待ちの長さを 1 秒に戻す', async () => {
    const s = await setup({ reject: 500 });
    s.bell.check();
    await settle(() => s.bell.state() === 'waiting');
    await s.timers.advance(1000);
    await settle(() => s.w.attempts.length === 2 && s.bell.state() === 'waiting');
    s.w.state.reject = false;
    await s.timers.advance(2000);
    await settle(() => s.bell.state() === 'open');
    await s.timers.advance(BELL_PING_MS);
    await settle(() => s.w.received.includes('ping'));
    await new Promise((r) => setTimeout(r, 30));
    // Worker の側から切る。
    for (const c of s.w.open()) c.close();
    await settle(() => s.bell.state() === 'waiting');
    await s.timers.advance(BELL_RETRY_MIN_MS);
    await settle(() => s.w.attempts.length === 4 && s.bell.state() === 'open');
  });

  it('つなぎ先が変わったら古いのを閉じて新しい先へつなぐ。無くなったら閉じて張り直さない', async () => {
    const s = await setup();
    const w2 = await fakeWorker();
    cleanups.push(() => w2.close());
    s.bell.check();
    await settle(() => s.w.open().length === 1);
    s.setTarget({ url: w2.url, headers: { authorization: 'Bearer new-token' } });
    s.bell.check();
    await settle(() => s.w.open().length === 0 && w2.open().length === 1 && s.bell.state() === 'open');
    expect(w2.attempts[0]!.authorization).toBe('Bearer new-token');
    // 同じ先でもトークンが変われば張り直す。
    s.setTarget({ url: w2.url, headers: { authorization: 'Bearer newer-token' } });
    s.bell.check();
    await settle(() => w2.attempts.length === 2 && w2.open().length === 1 && s.bell.state() === 'open');
    s.setTarget(null);
    s.bell.check();
    await settle(() => w2.open().length === 0);
    expect(s.bell.state()).toBe('idle');
    await s.timers.advance(BELL_RETRY_MAX_MS * 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(w2.attempts).toHaveLength(2);
    expect(s.timers.pendingCount()).toBe(0);
  });

  it('stop で閉じ、タイマーを残さず、以後はつながない', async () => {
    const s = await setup();
    s.bell.check();
    await settle(() => s.w.open().length === 1);
    s.bell.stop();
    await settle(() => s.w.open().length === 0);
    expect(s.timers.pendingCount()).toBe(0);
    s.bell.check();
    await new Promise((r) => setTimeout(r, 30));
    expect(s.w.attempts).toHaveLength(1);
  });
});
