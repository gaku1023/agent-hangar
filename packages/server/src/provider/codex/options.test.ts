import { describe, expect, it } from 'vitest';
import { CodexOptionsService, parseCodexModels } from './options.ts';

const RAW = JSON.stringify({
  models: [
    { slug: 'b-model', display_name: 'B', description: 'second', default_reasoning_level: 'medium', visibility: 'list', priority: 5, supported_reasoning_levels: [{ effort: 'low', description: 'l' }, { effort: 'medium', description: 'm' }] },
    { slug: 'hidden', display_name: 'H', description: '', default_reasoning_level: 'low', visibility: 'hide', priority: 1, supported_reasoning_levels: [] },
    { slug: 'a-model', display_name: 'A', description: 'first', default_reasoning_level: 'low', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'low', description: 'l' }, { effort: 'ultra', description: 'u' }], extra: 'ignored' },
  ],
});

describe('parseCodexModels', () => {
  it('visibility が list のものだけを priority の順で返し、推論の段階を codex の並びのまま持つ', () => {
    const models = parseCodexModels(RAW);
    expect(models.map((m) => m.id)).toEqual(['a-model', 'b-model']);
    expect(models[0]).toEqual({ id: 'a-model', label: 'A', description: 'first', efforts: [{ id: 'low', description: 'l' }, { id: 'ultra', description: 'u' }], defaultEffort: 'low' });
  });
  it('壊れた出力は投げる', () => {
    expect(() => parseCodexModels('not json')).toThrow();
    expect(() => parseCodexModels('{}')).toThrow();
  });
});

describe('CodexOptionsService', () => {
  const make = (over: Partial<ConstructorParameters<typeof CodexOptionsService>[0]> = {}) => {
    let now = 1_000;
    let calls = 0;
    const svc = new CodexOptionsService({
      bin: () => '/bin/codex',
      status: async () => ({ found: true, version: '0.164.0', verified: true, loggedIn: true }),
      run: async () => { calls++; return RAW; },
      now: () => now,
      freshMs: 60_000,
      ...over,
    });
    return { svc, calls: () => calls, advance: (ms: number) => { now += ms; } };
  };
  it('版と確かめの結果を添えて返す', async () => {
    const { svc } = make();
    const dto = await svc.get();
    expect(dto).toMatchObject({ version: '0.164.0', verified: true, fetchedAt: 1_000 });
    expect(dto.models.map((m) => m.id)).toEqual(['a-model', 'b-model']);
  });
  it('間もなければ打ち直さず、refresh か時間切れで打ち直す。同時の問いは 1 回にまとめる', async () => {
    const { svc, calls, advance } = make();
    await Promise.all([svc.get(), svc.get()]);
    expect(calls()).toBe(1);
    await svc.get();
    expect(calls()).toBe(1);
    await svc.get({ refresh: true });
    expect(calls()).toBe(2);
    advance(61_000);
    await svc.get();
    expect(calls()).toBe(3);
  });
  it('codex が無ければ投げる', async () => {
    const { svc } = make({ bin: () => null });
    await expect(svc.get()).rejects.toThrow(/not found/);
  });
  it('打ち直しに失敗したとき、前の一覧があれば返す', async () => {
    let fail = false;
    const { svc, advance } = make({ run: async () => { if (fail) throw new Error('boom'); return RAW; } });
    await svc.get();
    fail = true;
    advance(61_000);
    expect((await svc.get()).models).toHaveLength(2);
    const fresh = make({ run: async () => { throw new Error('boom'); } });
    await expect(fresh.svc.get()).rejects.toThrow('boom');
  });
  it('last は手元の一覧を待たずに返す。無ければ null を返して裏で取り始め、取れたら返す。間が空いていれば返したあとで取り直す', async () => {
    const { svc, calls, advance } = make();
    expect(svc.last()).toBeNull();
    await svc.get();
    expect(calls()).toBe(1);
    expect(svc.last()?.models).toHaveLength(2);
    expect(calls()).toBe(1);
    advance(61_000);
    expect(svc.last()?.fetchedAt).toBe(1_000);
    await svc.get();
    expect(calls()).toBe(2);
    const none = make({ bin: () => null });
    expect(none.svc.last()).toBeNull();
    await none.svc.get().catch(() => undefined);
    expect(none.svc.last()).toBeNull();
  });
  it('last が裏で取り始めた一覧は、次の last で返る', async () => {
    const { svc, calls } = make();
    expect(svc.last()).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls()).toBe(1);
    expect(svc.last()?.models).toHaveLength(2);
  });
});
