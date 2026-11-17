import { describe, expect, it } from 'vitest';
import { DEVICE_OPENCODE_MODELS_MAX, parseDeviceStatus } from './deviceStatus.ts';
import { opencodeFallbackModel, type OpencodeModelOption } from './opencodeOptions.ts';

const m = (id: string, o: Partial<OpencodeModelOption> = {}): OpencodeModelOption => ({
  id, label: id, group: id.split('/')[0]!, provider: id.split('/')[0]!, tools: true, context: null, cost: null, ...o,
});
const FREE = { input: 0, output: 0 };

describe('opencodeFallbackModel（#698）', () => {
  it('既定がその PC の一覧にあれば、代わりは要らない', () => {
    expect(opencodeFallbackModel({ models: [m('lmstudio/qwen'), m('opencode/deepseek-v4-free', { cost: FREE })], defaultModel: 'lmstudio/qwen' })).toBeNull();
  });
  it('既定が無い（opencode.json に model が無い）ときは、opencode に任せる', () => {
    expect(opencodeFallbackModel({ models: [m('opencode/deepseek-v4-free', { cost: FREE })], defaultModel: null })).toBeNull();
  });
  it('既定が一覧に無ければ、Zen の無料で deepseek を含むものを選ぶ', () => {
    const models = [m('openrouter/qwen3', { cost: { input: 0.2, output: 0.8 } }), m('opencode/glm-5-free', { cost: FREE }), m('opencode/deepseek-v4.1-flash-free', { cost: FREE })];
    expect(opencodeFallbackModel({ models, defaultModel: 'lmstudio/qwen3.6' })).toBe('opencode/deepseek-v4.1-flash-free');
  });
  it('既定がローカルのサーバーに無い（missing）ときも、使えないものとして代わりを選ぶ', () => {
    const models = [m('lmstudio/qwen3.6', { missing: true }), m('opencode/glm-5-free', { cost: FREE })];
    expect(opencodeFallbackModel({ models, defaultModel: 'lmstudio/qwen3.6' })).toBe('opencode/glm-5-free');
  });
  it('deepseek が無ければ Zen の無料の先頭、それも無ければ使える先頭。ツールに対応しないもの、有料の Zen は飛ばす', () => {
    expect(opencodeFallbackModel({ models: [m('opencode/big-pickle', { cost: { input: 1, output: 2 } }), m('opencode/notools-free', { cost: FREE, tools: false }), m('opencode/glm-free', { cost: FREE })], defaultModel: 'x/y' })).toBe('opencode/glm-free');
    expect(opencodeFallbackModel({ models: [m('lmstudio/a', { missing: true }), m('openrouter/b', { tools: false }), m('openrouter/c')], defaultModel: 'x/y' })).toBe('openrouter/c');
  });
  it('使えるモデルが 1 つも無ければ null', () => {
    expect(opencodeFallbackModel({ models: [m('lmstudio/a', { missing: true })], defaultModel: 'x/y' })).toBeNull();
  });
});

describe('parseDeviceStatus の opencode の欄（#698）', () => {
  const base = { accounts: [], agents: ['opencode'], lan_ips: [], ssh_host_key: null, hangar_version: '0.22.0' };
  it('欄を読む。形の違う行は捨てる', () => {
    const s = parseDeviceStatus(JSON.stringify({ ...base, opencode: {
      modes: [{ id: 'build', description: 'd' }, { nope: 1 }],
      models: [{ id: 'opencode/a', label: 'A', group: 'Zen', provider: 'opencode', tools: true, context: 1000, cost: { input: 0, output: 0 } }, { id: 3 }],
      providers: [{ id: 'opencode', name: 'Zen', where: 'remote' }, { id: 'x', name: 'X', where: 'mars' }],
      defaultModel: 'opencode/a',
    } }));
    expect(s?.opencode).toEqual({
      modes: [{ id: 'build', description: 'd' }],
      models: [{ id: 'opencode/a', label: 'A', group: 'Zen', provider: 'opencode', tools: true, context: 1000, cost: { input: 0, output: 0 } }],
      providers: [{ id: 'opencode', name: 'Zen', where: 'remote' }],
      defaultModel: 'opencode/a',
    });
  });
  it('欄が無い（古い版）、形が違うときは欄だけ無く、ほかの欄は読める', () => {
    expect(parseDeviceStatus(JSON.stringify(base))).toEqual(base);
    expect(parseDeviceStatus(JSON.stringify({ ...base, opencode: { modes: 'x' } }))).toEqual(base);
  });
  it('モデルは上限で切る', () => {
    const models = Array.from({ length: DEVICE_OPENCODE_MODELS_MAX + 5 }, (_, i) => ({ id: `p/m${i}`, label: 'L', group: 'G', provider: 'p', tools: true, context: null, cost: null }));
    expect(parseDeviceStatus(JSON.stringify({ ...base, opencode: { modes: [], models, providers: [], defaultModel: null } }))?.opencode?.models).toHaveLength(DEVICE_OPENCODE_MODELS_MAX);
  });
});
