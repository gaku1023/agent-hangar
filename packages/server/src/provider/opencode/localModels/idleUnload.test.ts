import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdleUnloadWatch } from './idleUnload.ts';
import { ledgerPath, readLedger } from './prepare.ts';

const ORIGIN = 'http://127.0.0.1:1234';
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-idle-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const seed = (entries: { instanceId: string; sessions: string[] }[]) => {
  fs.mkdirSync(path.join(home, 'opencode'), { recursive: true });
  fs.writeFileSync(ledgerPath(home), JSON.stringify({ entries: entries.map((e) => ({ origin: ORIGIN, model: e.instanceId, ...e })) }));
};

/** LM Studio の偽物。loaded は載っている instance の ID。 */
function fakeLm(loaded: string[], o: { down?: boolean } = {}) {
  const calls: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${init?.method ?? 'GET'} ${u.pathname}${init?.body ? ` ${String(init.body)}` : ''}`);
    if (o.down) throw new Error('ECONNREFUSED');
    if (u.pathname === '/api/v1/models') return Response.json({ models: loaded.map((id) => ({ type: 'llm', key: id, loaded_instances: [{ id, config: { context_length: 65_536 } }] })) });
    const b = JSON.parse(String(init?.body)) as { instance_id: string };
    loaded.splice(loaded.indexOf(b.instance_id), 1);
    return Response.json({ instance_id: b.instance_id });
  }) as typeof fetch;
  return { f, calls };
}

function watch(over: { running?: Set<string>; minutes?: number; loaded?: string[]; down?: boolean } = {}) {
  let t = 0;
  const lm = fakeLm(over.loaded ?? ['qwen'], { down: over.down });
  const told: { model: string; minutes: number }[] = [];
  const running = over.running ?? new Set<string>();
  const w = new IdleUnloadWatch({ home, minutes: () => over.minutes ?? 5, isRunning: (id) => running.has(id), now: () => t, fetch: lm.f, announce: (model, minutes) => told.push({ model, minutes }) });
  return { w, lm, told, running, at: (min: number) => { t = min * 60_000; } };
}

describe('IdleUnloadWatch', () => {
  it('止まってから設定の分が過ぎたら外し、記録から消して知らせる', async () => {
    seed([{ instanceId: 'qwen', sessions: ['h1'] }]);
    const x = watch();
    await x.w.tick();
    x.at(4.9);
    await x.w.tick();
    expect(x.lm.calls).toEqual([]);
    x.at(5);
    await x.w.tick();
    expect(x.lm.calls).toEqual(['GET /api/v1/models', 'POST /api/v1/models/unload {"instance_id":"qwen"}']);
    expect(readLedger(home)).toEqual([]);
    expect(x.told).toEqual([{ model: 'qwen', minutes: 5 }]);
  });

  it('使う会話が 1 つでも動いている間は数えず、止まったらそこから数え直す', async () => {
    seed([{ instanceId: 'qwen', sessions: ['h1', 'h2'] }]);
    const x = watch({ running: new Set(['h2']) });
    await x.w.tick();
    x.at(10);
    await x.w.tick();
    expect(x.lm.calls).toEqual([]);
    x.running.clear();
    await x.w.tick();
    x.at(14);
    await x.w.tick();
    expect(x.lm.calls).toEqual([]);
    x.at(15);
    await x.w.tick();
    expect(x.told).toHaveLength(1);
  });

  it('途中で動き出したら数え直す', async () => {
    seed([{ instanceId: 'qwen', sessions: ['h1'] }]);
    const x = watch();
    await x.w.tick();
    x.at(4);
    x.running.add('h1');
    await x.w.tick();
    x.running.clear();
    x.at(6);
    await x.w.tick();
    x.at(10);
    await x.w.tick();
    expect(x.lm.calls).toEqual([]);
    x.at(11);
    await x.w.tick();
    expect(x.told).toHaveLength(1);
  });

  it('0 分（しない）なら外さない', async () => {
    seed([{ instanceId: 'qwen', sessions: ['h1'] }]);
    const x = watch({ minutes: 0 });
    await x.w.tick();
    x.at(600);
    await x.w.tick();
    expect(x.lm.calls).toEqual([]);
    expect(readLedger(home)).toHaveLength(1);
  });

  it('LM Studio につながらなければ飛ばし、記録は残す', async () => {
    seed([{ instanceId: 'qwen', sessions: ['h1'] }]);
    const x = watch({ down: true });
    await x.w.tick();
    x.at(6);
    await x.w.tick();
    expect(readLedger(home)).toHaveLength(1);
    expect(x.told).toEqual([]);
  });

  it('すでに外れている instance は、知らせずに記録から外す', async () => {
    seed([{ instanceId: 'qwen', sessions: ['h1'] }]);
    const x = watch({ loaded: [] });
    await x.w.tick();
    x.at(6);
    await x.w.tick();
    expect(x.lm.calls).toEqual(['GET /api/v1/models']);
    expect(readLedger(home)).toEqual([]);
    expect(x.told).toEqual([]);
  });

  it('記録に無い（手で載せた）モデルには触らない', async () => {
    seed([{ instanceId: 'qwen', sessions: ['h1'] }]);
    const x = watch({ loaded: ['qwen', 'manual'] });
    await x.w.tick();
    x.at(6);
    await x.w.tick();
    expect(x.lm.calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /api/v1/models/unload {"instance_id":"qwen"}']);
  });

  it('記録が無ければ何もしない', async () => {
    const x = watch();
    await x.w.tick();
    expect(x.lm.calls).toEqual([]);
  });
});
