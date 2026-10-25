import { describe, expect, it } from 'vitest';
import { MODEL_FACTS_STALE_DAYS, MODEL_FACTS_UPDATED, translator, type OpencodeModelOption, type OpencodeProviderOption } from '@agent-hangar/shared';
import { contextLabel, costKindOf, presentModelPicker, priceLabel, type ModelPickerInput } from './modelPicker.ts';

const ja = translator('ja');
const en = translator('en');
const FRESH = Date.parse(`${MODEL_FACTS_UPDATED}T09:00:00Z`);
const STALE = FRESH + (MODEL_FACTS_STALE_DAYS + 2) * 86_400_000;

const m = (id: string, over: Partial<OpencodeModelOption> = {}): OpencodeModelOption => {
  const [provider] = id.split('/');
  return { id, label: id.slice(provider!.length + 1), group: provider!, provider: provider!, tools: true, context: 200_000, cost: { input: 0, output: 0 }, ...over };
};
const P: OpencodeProviderOption[] = [
  { id: 'opencode', name: 'OpenCode', where: 'remote' },
  { id: 'lmstudio', name: 'LM Studio (local)', where: 'device' },
  { id: 'deepseek', name: 'DeepSeek', where: 'remote' },
  { id: 'home', name: 'Home GPU', where: 'lan' },
  { id: 'opencode-go', name: 'OpenCode Go', where: 'remote' },
];
const MODELS: OpencodeModelOption[] = [
  m('opencode/big-pickle', { label: 'Big Pickle' }),
  m('opencode/glm-5.3-flash-free', { label: 'GLM-5.3-Flash Free' }),
  m('opencode/nemotron-3-ultra-free', { label: 'Nemotron 3 Ultra Free', context: 1_000_000 }),
  m('opencode/brand-new-free', { label: 'Brand New Free' }),
  m('lmstudio/qwen3.6-35b-a3b', { label: 'Qwen3.6 35B A3B', context: 262_144, cost: null }),
  m('lmstudio/laguna-xs', { label: 'Laguna XS', tools: false, context: 131_072, cost: null }),
  m('deepseek/deepseek-v4-flash', { label: 'DeepSeek V4 Flash', context: 1_048_576, cost: { input: 0.15, output: 0.6 } }),
  m('home/qwen3.8-27b-awq', { label: 'qwen3.8-27b-awq', context: 128_000, cost: null }),
  m('opencode-go/kimi-k3.1-pro', { label: 'Kimi K3.1 Pro', context: 1_000_000, cost: { input: 2, output: 10 } }),
];
const input = (over: Partial<ModelPickerInput> = {}): ModelPickerInput => ({
  models: MODELS, providers: P, defaultModel: 'lmstudio/qwen3.6-35b-a3b', pricesAt: Date.UTC(2026, 9, 25, 3), fetchedAt: Date.UTC(2026, 9, 25, 4),
  selected: '', query: '', now: FRESH, ...over,
});
const labels = (tags: { label: string }[]) => tags.map((t) => t.label);

describe('costKindOf（費用の型）', () => {
  const where = (id: string) => P.find((p) => p.id === id)!.where;
  it('定額のプロバイダー、この PC か内側の網、料金のあるもの、0 円のもの、の順に決める', () => {
    expect(costKindOf(m('opencode-go/kimi', { cost: { input: 2, output: 10 } }), where('opencode-go'))).toBe('plan');
    expect(costKindOf(m('lmstudio/x', { cost: null }), 'device')).toBe('local');
    expect(costKindOf(m('home/x', { cost: null }), 'lan')).toBe('local');
    expect(costKindOf(m('deepseek/x', { cost: { input: 0.15, output: 0.6 } }), 'remote')).toBe('metered');
    expect(costKindOf(m('opencode/x', { cost: { input: 0, output: 0 } }), 'remote')).toBe('free');
    // 料金の分からない、外のサーバーは自前のものとして扱う（opencode.json で足した OpenAI 互換のサーバー）。
    expect(costKindOf(m('school/x', { cost: null }), 'remote')).toBe('local');
  });
});

describe('contextLabel と priceLabel', () => {
  it('コンテキストは K と M で縮める', () => {
    expect([262_144, 131_072, 200_000, 1_000_000, 1_048_576, 1_500_000, 900].map(contextLabel)).toEqual(['262K', '131K', '200K', '1M', '1M', '1.5M', '900']);
  });
  it('値段は、ローカルと無料は 0 円、従量は入力と出力（100 万トークンあたり）、定額は「定額に含む」', () => {
    expect(priceLabel(ja, 'local', null)).toEqual({ main: '0 円', sub: null });
    expect(priceLabel(ja, 'free', { input: 0, output: 0 })).toEqual({ main: '0 円', sub: null });
    expect(priceLabel(ja, 'metered', { input: 0.15, output: 0.6 })).toEqual({ main: '$0.15 / $0.6', sub: '入力 / 出力 · 100万トークン' });
    expect(priceLabel(ja, 'plan', { input: 2, output: 10 })).toEqual({ main: '定額に含む', sub: null });
    expect(priceLabel(en, 'metered', { input: 2, output: 10 })).toEqual({ main: '$2 / $10', sub: 'Input / output · per 1M tokens' });
  });
});

describe('presentModelPicker', () => {
  it('プロバイダーごとにまとめ、ローカル、無料、従量、定額の順に並べる。見出しに件数、費用の型、接続の状態を出す', () => {
    const v = presentModelPicker(ja, input());
    expect(v.groups.map((g) => [g.name, g.kind.label, g.status])).toEqual([
      ['LM Studio（2）', 'ローカル', '起動中 · 自動で取得'],
      ['Home GPU（1）', 'ローカル', '接続済み'],
      ['OpenCode Zen（4）', '無料', 'API キー不要 · 期間限定'],
      ['DeepSeek（1）', '従量', '接続済み'],
      ['OpenCode Go（1）', '定額', '接続済み'],
    ]);
    expect(v.groups.map((g) => g.kind.tone)).toEqual(['local', 'local', 'free', 'metered', 'plan']);
  });

  it('行は名前、費用の型、データの扱い、コンテキスト、期間限定の札と、右端の値段', () => {
    const rows = presentModelPicker(ja, input()).groups.flatMap((g) => g.rows);
    const row = (id: string) => rows.find((r) => r.id === id)!;
    expect(labels(row('lmstudio/qwen3.6-35b-a3b').tags)).toEqual(['ローカル', 'PC 外への送信なし', '262K']);
    expect(row('lmstudio/qwen3.6-35b-a3b').price).toEqual({ main: '0 円', sub: null });
    // 内側の網のサーバーは PC の外へ出るので、「PC 外への送信なし」は付けない。
    expect(labels(row('home/qwen3.8-27b-awq').tags)).toEqual(['ローカル', '128K']);
    expect(labels(row('opencode/glm-5.3-flash-free').tags)).toEqual(['無料', '学習への利用なし', '200K', '期間限定']);
    expect(labels(row('deepseek/deepseek-v4-flash').tags)).toEqual(['従量', '学習への利用なし', '1M']);
    expect(row('deepseek/deepseek-v4-flash').price).toEqual({ main: '$0.15 / $0.6', sub: '入力 / 出力 · 100万トークン' });
    expect(row('opencode-go/kimi-k3.1-pro').price).toEqual({ main: '定額に含む', sub: null });
  });

  it('「学習利用の可能性あり」と「プロバイダー側で記録」は警告の札にする', () => {
    const rows = presentModelPicker(ja, input()).groups.flatMap((g) => g.rows);
    const tag = (id: string) => rows.find((r) => r.id === id)!.tags[1]!;
    expect(tag('opencode/big-pickle')).toEqual({ label: '⚠ 学習利用の可能性あり', tone: 'warn' });
    expect(tag('opencode/nemotron-3-ultra-free')).toEqual({ label: '⚠ プロバイダー側で記録', tone: 'warn' });
    expect(tag('opencode/glm-5.3-flash-free')).toEqual({ label: '学習への利用なし', tone: 'ok' });
  });

  it('データの扱いを書いていないモデルは「要確認」。手書きの表が古くなったら、事実の札に「要確認」を添える', () => {
    const fresh = presentModelPicker(ja, input()).groups.flatMap((g) => g.rows);
    expect(labels(fresh.find((r) => r.id === 'opencode/brand-new-free')!.tags)).toEqual(['無料', '要確認', '200K', '期間限定']);
    const old = presentModelPicker(ja, input({ now: STALE })).groups.flatMap((g) => g.rows);
    expect(labels(old.find((r) => r.id === 'opencode/glm-5.3-flash-free')!.tags)).toEqual(['無料', '学習への利用なし', '要確認', '200K', '期間限定']);
    // PC の外へ出ないことは表ではなく宛先から決めるので、古くなっても添えない。
    expect(labels(old.find((r) => r.id === 'lmstudio/qwen3.6-35b-a3b')!.tags)).toEqual(['ローカル', 'PC 外への送信なし', '262K']);
  });

  it('ツール呼び出しに対応しないモデルは、選べない行にして「ツール非対応」と説明を添える', () => {
    const rows = presentModelPicker(ja, input()).groups.flatMap((g) => g.rows);
    const off = rows.find((r) => r.id === 'lmstudio/laguna-xs')!;
    expect(off.disabled).toBe(true);
    expect(off.note).toBe('ツール呼び出しに対応していないため、エージェントでは使えません');
    expect(off.tags).toContainEqual({ label: 'ツール非対応', tone: 'warn' });
    expect(rows.filter((r) => r.disabled).map((r) => r.id)).toEqual(['lmstudio/laguna-xs']);
  });

  it('LM Studio のまとまりにだけ再読み込みを置く', () => {
    expect(presentModelPicker(ja, input()).groups.filter((g) => g.reload).map((g) => g.key)).toEqual(['lmstudio']);
  });

  it('選んだ行に印を付ける。何も選んでいなければデフォルトの行で、opencode.json のモデルを添える', () => {
    const none = presentModelPicker(ja, input());
    expect(none.def).toEqual({ selected: true, sub: 'lmstudio/qwen3.6-35b-a3b' });
    const picked = presentModelPicker(ja, input({ selected: 'deepseek/deepseek-v4-flash' }));
    expect(picked.def?.selected).toBe(false);
    expect(picked.groups.flatMap((g) => g.rows).filter((r) => r.selected).map((r) => r.id)).toEqual(['deepseek/deepseek-v4-flash']);
  });

  it('絞り込みは名前と ID の一部で、大文字小文字を問わない。合わないまとまりとデフォルトの行は出さない', () => {
    const v = presentModelPicker(ja, input({ query: 'QWEN' }));
    expect(v.def).toBeNull();
    expect(v.groups.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
      ['lmstudio', ['lmstudio/qwen3.6-35b-a3b']],
      ['home', ['home/qwen3.8-27b-awq']],
    ]);
    expect(v.groups[0]!.name).toBe('LM Studio（1）');
    expect(presentModelPicker(ja, input({ query: 'zzz' })).empty).toBe(true);
  });

  it('同じプロバイダーに無料と従量が混ざれば、費用の型ごとのまとまりに分ける（見出しの札で見分ける）', () => {
    const v = presentModelPicker(ja, input({ models: [m('opencode/glm-5.3-flash-free', { label: 'GLM' }), m('opencode/kimi-k3.1-pro', { label: 'Kimi', cost: { input: 2, output: 10 } })] }));
    expect(v.groups.map((g) => [g.key, g.name, g.kind.label, g.status])).toEqual([
      ['opencode:free', 'OpenCode Zen（1）', '無料', 'API キー不要 · 期間限定'],
      ['opencode:metered', 'OpenCode Zen（1）', '従量', '接続済み'],
    ]);
  });

  it('下端は料金の取得日。models.dev から取れていなければ、opencode から取った日', () => {
    const at = (d: number) => new Date(2026, 9, d, 12).getTime();
    expect(presentModelPicker(ja, input({ pricesAt: at(24), fetchedAt: at(25) })).footer).toBe('料金は models.dev と各社の公開情報（10/24 取得）。');
    expect(presentModelPicker(ja, input({ pricesAt: null, fetchedAt: at(25) })).footer).toBe('料金は models.dev と各社の公開情報（10/25 取得）。');
  });

  it('英語でも組める', () => {
    const v = presentModelPicker(en, input());
    expect(v.groups[0]!.kind.label).toBe('Local');
    expect(v.groups[0]!.rows[0]!.price.main).toBe('$0');
  });
});
