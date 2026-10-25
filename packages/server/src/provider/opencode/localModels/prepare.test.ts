import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchPrepAsked, LaunchPreps } from '../../../runs/launchPrep.ts';
import { ledgerPath, prepareLocalModels, type LocalModelsDeps, type PrepareInput } from './prepare.ts';

const GB = 1024 ** 3;
type Row = { key: string; size: number; instances: { id: string; context: number }[] };

/** LM Studio の偽物。呼ばれた順を calls に残す。 */
function fakeLm(rows: Row[], o: { status?: number } = {}) {
  const calls: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${init?.method ?? 'GET'} ${u.host}${u.pathname}${init?.body ? ` ${String(init.body)}` : ''}`);
    if (o.status) return new Response('not found', { status: o.status });
    if (u.pathname === '/api/v1/models') {
      return Response.json({ models: rows.map((r) => ({ type: 'llm', key: r.key, size_bytes: r.size * GB, max_context_length: 262_144, loaded_instances: r.instances.map((x) => ({ id: x.id, config: { context_length: x.context } })) })) });
    }
    const body = JSON.parse(String(init?.body)) as { model?: string; instance_id?: string; context_length?: number };
    if (u.pathname === '/api/v1/models/load') {
      const r = rows.find((x) => x.key === body.model)!;
      r.instances.push({ id: body.model!, context: body.context_length! });
      return Response.json({ type: 'llm', instance_id: body.model, status: 'loaded' });
    }
    if (u.pathname === '/api/v1/models/unload') {
      for (const r of rows) r.instances = r.instances.filter((x) => x.id !== body.instance_id);
      return Response.json({ instance_id: body.instance_id });
    }
    return new Response('?', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-lm-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const deps = (f: typeof fetch, over: Partial<LocalModelsDeps> = {}): LocalModelsDeps => ({ home, context: () => 65_536, isRunning: () => false, totalmem: () => 32 * GB, fetch: f, ...over });
const preps = new LaunchPreps({ broadcast: () => undefined });
const input = (over: Partial<PrepareInput> = {}): PrepareInput => ({
  hangarSessionId: 'h1',
  uses: [{ ref: 'lmstudio/qwen', uses: ['$session'] }],
  providers: [{ id: 'lmstudio', baseURL: 'http://127.0.0.1:1234/v1' }],
  limits: new Map(),
  choice: {},
  prep: preps.begin(undefined),
  ...over,
});

describe('prepareLocalModels', () => {
  it('載っていないモデルを設定の長さで載せ、hangar が載せたと記録する', async () => {
    const lm = fakeLm([{ key: 'qwen', size: 16, instances: [] }]);
    await prepareLocalModels(deps(lm.f), input());
    expect(lm.calls).toEqual(['GET 127.0.0.1:1234/api/v1/models', 'POST 127.0.0.1:1234/api/v1/models/load {"model":"qwen","context_length":65536}']);
    expect(JSON.parse(fs.readFileSync(ledgerPath(home), 'utf8'))).toEqual({ entries: [{ origin: 'http://127.0.0.1:1234', instanceId: 'qwen', model: 'qwen', sessions: ['h1'] }] });
  });

  it('8192 で載っている hangar のモデルは、外して載せ直す', async () => {
    const lm = fakeLm([{ key: 'qwen', size: 16, instances: [{ id: 'qwen', context: 8192 }] }]);
    fs.mkdirSync(path.join(home, 'opencode'));
    fs.writeFileSync(ledgerPath(home), JSON.stringify({ entries: [{ origin: 'http://127.0.0.1:1234', instanceId: 'qwen', model: 'qwen', sessions: ['old'] }] }));
    await prepareLocalModels(deps(lm.f), input());
    expect(lm.calls.slice(1)).toEqual(['POST 127.0.0.1:1234/api/v1/models/unload {"instance_id":"qwen"}', 'POST 127.0.0.1:1234/api/v1/models/load {"model":"qwen","context_length":65536}']);
  });

  it('65536 で載っていれば何もしない', async () => {
    const lm = fakeLm([{ key: 'qwen', size: 16, instances: [{ id: 'qwen', context: 65_536 }] }]);
    await prepareLocalModels(deps(lm.f), input());
    expect(lm.calls).toEqual(['GET 127.0.0.1:1234/api/v1/models']);
  });

  it('手で載せた別のモデルがあり、合わせて収まらなければ聞く', async () => {
    const lm = fakeLm([{ key: 'qwen', size: 16, instances: [] }, { key: 'gemma', size: 15, instances: [{ id: 'gemma', context: 65_536 }] }]);
    await expect(prepareLocalModels(deps(lm.f), input())).rejects.toBeInstanceOf(LaunchPrepAsked);
    expect(lm.calls).toEqual(['GET 127.0.0.1:1234/api/v1/models']);
  });

  it('ほかの動いている会話が使う hangar のモデルは外さない', async () => {
    const lm = fakeLm([{ key: 'qwen', size: 16, instances: [] }, { key: 'gemma', size: 15, instances: [{ id: 'gemma', context: 65_536 }] }]);
    fs.mkdirSync(path.join(home, 'opencode'));
    fs.writeFileSync(ledgerPath(home), JSON.stringify({ entries: [{ origin: 'http://127.0.0.1:1234', instanceId: 'gemma', model: 'gemma', sessions: ['h0'] }] }));
    await prepareLocalModels(deps(lm.f, { isRunning: (id) => id === 'h0' }), input());
    expect(lm.calls.some((c) => c.includes('unload'))).toBe(false);
  });

  it('LAN の宛先は触らない', async () => {
    const lm = fakeLm([{ key: 'qwen', size: 16, instances: [] }]);
    await prepareLocalModels(deps(lm.f), input({ providers: [{ id: 'lmstudio', baseURL: 'http://192.168.1.20:1234/v1' }] }));
    expect(lm.calls).toEqual([]);
  });

  it('LM Studio ではない宛先（404）は黙って飛ばす', async () => {
    const lm = fakeLm([], { status: 404 });
    await prepareLocalModels(deps(lm.f), input());
    expect(lm.calls).toEqual(['GET 127.0.0.1:1234/api/v1/models']);
  });

  it('このまま始める（skip）なら問い合わせもしない', async () => {
    const lm = fakeLm([{ key: 'qwen', size: 16, instances: [] }]);
    await prepareLocalModels(deps(lm.f), input({ choice: { skip: true } }));
    expect(lm.calls).toEqual([]);
  });
});
