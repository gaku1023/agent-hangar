import { describe, expect, it } from 'vitest';
import type { CatalogModel } from './catalog.ts';
import type { OpencodeModelInfo } from './client.ts';
import { OpencodeOptionsService, type OpencodeOptionsRaw } from './options.ts';

// 会話の文脈の大きさ（右欄のコンテキストの帯の分母）を、取った選択肢のモデルの一覧から引く（計画の C5）。
const serve = { url: 'http://127.0.0.1:1', password: 'p', pid: 1 };
const model = (providerID: string, id: string, context: number | null): OpencodeModelInfo => ({ providerID, id, name: id, enabled: true, tools: true, context, cost: null });
const raw = (models: OpencodeModelInfo[]): OpencodeOptionsRaw => ({ agents: [{ id: 'build', description: null, mode: 'primary', hidden: false }], models, providers: [], defaultModel: null });

function make(byDir: Record<string, OpencodeModelInfo[]>, catalog: Record<string, CatalogModel> = {}) {
  return new OpencodeOptionsService({
    serves: { any: () => serve, ensure: async () => serve, stop: async () => {} },
    status: async () => ({ found: true, version: '2.1.4', verified: true }),
    home: '/home/me',
    read: async (_s, dir) => raw(byDir[dir] ?? []),
    catalog: {
      refresh: async () => false,
      current: () => ({ fetchedAt: 1 }),
      lookup: (p, m) => catalog[`${p}/${m}`] ?? null,
    },
  });
}

describe('OpencodeOptionsService.contextOf', () => {
  it('取った一覧にあるモデルの上限を返す（ID は provider/model）', async () => {
    const s = make({ '/w/a': [model('lmstudio', 'qwen3.8-27b', 40_000), model('opencode', 'glm-5.3-flash-free', 200_000)] });
    await s.get('/w/a');
    expect(s.contextOf('lmstudio/qwen3.8-27b')).toBe(40_000);
    expect(s.contextOf('opencode/glm-5.3-flash-free')).toBe(200_000);
  });

  it('モデルの ID に / を含むもの（lmstudio/qwen/qwen3-coder-30b）も引ける', async () => {
    const s = make({ '/w/a': [model('lmstudio', 'qwen/qwen3-coder-30b', 32_768)] });
    await s.get('/w/a');
    expect(s.contextOf('lmstudio/qwen/qwen3-coder-30b')).toBe(32_768);
  });

  it('どの場所の一覧にも無ければ models.dev のカタログで引き、そこにも無ければ null', async () => {
    const s = make({ '/w/a': [model('lmstudio', 'qwen3.8-27b', null)] }, { 'opencode/glm-5.3-flash-free': { cost: null, context: 128_000, tools: true } });
    await s.get('/w/a');
    expect(s.contextOf('opencode/glm-5.3-flash-free')).toBe(128_000);
    expect(s.contextOf('lmstudio/qwen3.8-27b')).toBeNull();
    expect(s.contextOf('nobody/none')).toBeNull();
    expect(s.contextOf('no-slash')).toBeNull();
  });

  it('一覧を 1 度も取っていなくても、カタログだけで引ける', () => {
    const s = make({}, { 'deepseek/v4.1-flash': { cost: null, context: 64_000, tools: true } });
    expect(s.contextOf('deepseek/v4.1-flash')).toBe(64_000);
  });
});
