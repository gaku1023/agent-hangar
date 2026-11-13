import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { addPcDevice, startCloud, type CloudHarness } from './harness.ts';

let cloud: CloudHarness;

const send = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const K = (name: string): string => `k${name}`.padEnd(43, '_');
const row = (name: string) => ({ k: K(name), op: 'upsert', updatedAt: 1000, epoch: 1, sealed: Buffer.from(name).toString('base64url') });
const push = (token: string, query: string, changes: unknown) =>
  send(`/changes${query}`, { method: 'POST', headers: { ...auth(token), 'content-type': 'application/json' }, body: JSON.stringify({ changes }) });

type MfSocket = { accept(): void; close(code?: number, reason?: string): void; addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void };
type Bell = { next: (ms?: number) => Promise<{ t: string }>; silent: (ms: number) => Promise<void>; close: () => void };
const openBell = async (token: string): Promise<Bell> => {
  const r = await send('/m/bell', { headers: { ...auth(token), upgrade: 'websocket' } });
  expect(r.status).toBe(101);
  const ws = (r as unknown as { webSocket: MfSocket }).webSocket;
  ws.accept();
  const queue: string[] = [];
  const waiters: ((m: string) => void)[] = [];
  ws.addEventListener('message', (e) => {
    const m = String(e.data);
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = (ms = 3000) =>
    new Promise<{ t: string }>((resolve, reject) => {
      const m = queue.shift();
      if (m !== undefined) return resolve(JSON.parse(m));
      const t = setTimeout(() => reject(new Error('呼び鈴に何も届きませんでした')), ms);
      waiters.push((v) => {
        clearTimeout(t);
        resolve(JSON.parse(v));
      });
    });
  const silent = async (ms: number) => {
    await new Promise((r) => setTimeout(r, ms));
    expect(queue).toEqual([]);
  };
  return { next, silent, close: () => ws.close(1000, 'bye') };
};

let a: string;
let b: string;
let c: string;

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
  a = await addPcDevice(cloud.env, 'pc-a');
  b = await addPcDevice(cloud.env, 'pc-b');
  c = await addPcDevice(cloud.env, 'pc-c');
});

afterEach(async () => {
  await cloud.dispose();
});

describe('急ぐ push の呼び鈴（POST /changes?ring=1）', () => {
  it('印付きの push が通ると、送り主以外の PC に { t: changes } が届く', async () => {
    const ba = await openBell(a);
    const bb = await openBell(b);
    const bc = await openBell(c);
    expect((await push(a, '?ring=1', [row('x')])).status).toBe(200);
    expect(await bb.next()).toEqual({ t: 'changes' });
    expect(await bc.next()).toEqual({ t: 'changes' });
    await ba.silent(300);
    [ba, bb, bc].forEach((x) => x.close());
  });

  it('印が無い push では鳴らさない', async () => {
    const bb = await openBell(b);
    expect((await push(a, '', [row('x')])).status).toBe(200);
    await bb.silent(300);
    bb.close();
  });

  it('印が ring=1 でなければ鳴らさない', async () => {
    const bb = await openBell(b);
    expect((await push(a, '?ring=0', [row('x')])).status).toBe(200);
    await bb.silent(300);
    bb.close();
  });

  it('断られた push（本文が不正）では鳴らさない', async () => {
    const bb = await openBell(b);
    expect((await push(a, '?ring=1', 'nope')).status).toBe(400);
    await bb.silent(300);
    bb.close();
  });

  it('解除した PC には鳴らさず、ほかの PC には鳴らす', async () => {
    await cloud.env.DB.prepare('update devices set revoked_at = 1 where id = ?').bind('pc-c').run();
    const bb = await openBell(b);
    expect((await push(a, '?ring=1', [row('x')])).status).toBe(200);
    expect(await bb.next()).toEqual({ t: 'changes' });
    bb.close();
  });
});
