import { describe, expect, it } from 'vitest';
import type { LmModel } from './lmstudio.ts';
import { planLocalModels, type PlanInput } from './plan.ts';

const GB = 1024 ** 3;
const model = (key: string, size: number, instances: { id: string; context: number | null }[] = []): LmModel => ({ key, type: 'llm', sizeBytes: size * GB, maxContext: 262_144, instances });
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  wanted: [{ model: 'qwen', uses: ['$session'], limit: null }],
  models: [model('qwen', 16), model('gemma', 15)],
  context: 65_536,
  owned: new Map(),
  choice: {},
  memLimitBytes: 25.6 * GB,
  ...over,
});

describe('planLocalModels', () => {
  it('載っていなければ、設定の長さで載せる', () => {
    expect(planLocalModels(input())).toEqual({ actions: [{ kind: 'load', model: 'qwen', to: 65_536 }], ask: null });
  });

  it('足りる長さで載っていれば何もしない', () => {
    expect(planLocalModels(input({ models: [model('qwen', 16, [{ id: 'qwen', context: 65_536 }])] }))).toEqual({ actions: [], ask: null });
  });

  it('opencode の limit.context と LM Studio の最大が小さければ、そちらに合わせる', () => {
    const p = planLocalModels(input({ wanted: [{ model: 'qwen', uses: ['$session'], limit: 32_768 }] }));
    expect(p.actions).toEqual([{ kind: 'load', model: 'qwen', to: 32_768 }]);
    const m = { ...model('qwen', 16), maxContext: 16_384 };
    expect(planLocalModels(input({ models: [m] })).actions).toEqual([{ kind: 'load', model: 'qwen', to: 16_384 }]);
  });

  it('hangar が短く載せたものは外して載せ直す', () => {
    const p = planLocalModels(input({ models: [model('qwen', 16, [{ id: 'qwen', context: 8192 }])], owned: new Map([['qwen', { protected: false }]]) }));
    expect(p).toEqual({ actions: [{ kind: 'reload', model: 'qwen', instanceId: 'qwen', from: 8192, to: 65_536 }], ask: null });
  });

  it('手で短く載せたもの（記録に無いもの）は外さずに聞く。答えで外してよいと言われたら載せ直す', () => {
    const models = [model('qwen', 16, [{ id: 'qwen', context: 8192 }])];
    const p = planLocalModels(input({ models }));
    expect(p.actions).toEqual([]);
    expect(p.ask).toEqual({ kind: 'unload-manual', model: 'qwen', want: 65_536, blocking: [{ instanceId: 'qwen', model: 'qwen', sizeBytes: 16 * GB, context: 8192 }] });
    expect(planLocalModels(input({ models, choice: { unload: ['qwen'] } }))).toEqual({ actions: [{ kind: 'reload', model: 'qwen', instanceId: 'qwen', from: 8192, to: 65_536 }], ask: null });
  });

  it('reloadShort なら、手で短く載せた同じモデルも聞かずに載せ直す', () => {
    const models = [model('qwen', 16, [{ id: 'qwen', context: 8192 }])];
    expect(planLocalModels(input({ models, reloadShort: true }))).toEqual({ actions: [{ kind: 'reload', model: 'qwen', instanceId: 'qwen', from: 8192, to: 65_536 }], ask: null });
  });

  it('メモリに収まらないとき、hangar が載せて今は使っていないものを先に外す', () => {
    const models = [model('qwen', 16), model('gemma', 15, [{ id: 'gemma', context: 65_536 }])];
    const p = planLocalModels(input({ models, owned: new Map([['gemma', { protected: false }]]) }));
    expect(p).toEqual({ actions: [{ kind: 'unload', model: 'gemma', instanceId: 'gemma' }, { kind: 'load', model: 'qwen', to: 65_536 }], ask: null });
  });

  it('ほかの会話が使っている hangar のモデルは外さない。手で載せたものは聞く', () => {
    const models = [model('qwen', 16), model('gemma', 15, [{ id: 'gemma', context: 65_536 }])];
    const p = planLocalModels(input({ models, owned: new Map([['gemma', { protected: true }]]) }));
    expect(p.ask).toBeNull();
    expect(p.actions).toEqual([{ kind: 'load', model: 'qwen', to: 65_536 }]);
    const manual = planLocalModels(input({ models }));
    expect(manual.ask).toEqual({ kind: 'unload-manual', model: 'qwen', want: 65_536, blocking: [{ instanceId: 'gemma', model: 'gemma', sizeBytes: 15 * GB, context: 65_536 }] });
    expect(planLocalModels(input({ models, choice: { unload: ['gemma'] } })).actions).toEqual([{ kind: 'unload', model: 'gemma', instanceId: 'gemma' }, { kind: 'load', model: 'qwen', to: 65_536 }]);
  });

  it('会話と agent が別のモデルで、合わせると収まらなければ、1 モデルに寄せるかを聞く（会話のモデルを勧める）', () => {
    const wanted = [{ model: 'qwen', uses: ['$session', 'build'], limit: null }, { model: 'gemma', uses: ['scout', 'fetcher'], limit: null }];
    const p = planLocalModels(input({ wanted }));
    expect(p.actions).toEqual([]);
    expect(p.ask).toEqual({ kind: 'memory', models: [{ model: 'qwen', uses: ['$session', 'build'], sizeBytes: 16 * GB }, { model: 'gemma', uses: ['scout', 'fetcher'], sizeBytes: 15 * GB }], totalBytes: 31 * GB, limitBytes: 25.6 * GB, suggest: 'qwen' });
  });

  it('このまま始める（skip）なら何もしない', () => {
    const wanted = [{ model: 'qwen', uses: ['$session'], limit: null }, { model: 'gemma', uses: ['scout'], limit: null }];
    expect(planLocalModels(input({ wanted, choice: { skip: true } }))).toEqual({ actions: [], ask: null });
  });

  it('合わせて収まるなら、別のモデルでも両方載せる', () => {
    const wanted = [{ model: 'qwen', uses: ['$session'], limit: null }, { model: 'gemma', uses: ['scout'], limit: null }];
    const p = planLocalModels(input({ wanted, memLimitBytes: 64 * GB }));
    expect(p).toEqual({ actions: [{ kind: 'load', model: 'qwen', to: 65_536 }, { kind: 'load', model: 'gemma', to: 65_536 }], ask: null });
  });

  it('1 つで収まらないモデルは、聞かずに載せてみる（LM Studio が断れば失敗として出る）', () => {
    expect(planLocalModels(input({ memLimitBytes: 8 * GB }))).toEqual({ actions: [{ kind: 'load', model: 'qwen', to: 65_536 }], ask: null });
  });

  it('LM Studio が持っていないモデルは飛ばす', () => {
    expect(planLocalModels(input({ wanted: [{ model: 'nope', uses: ['$session'], limit: null }] }))).toEqual({ actions: [], ask: null });
  });
});
