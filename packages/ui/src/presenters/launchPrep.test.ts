import { describe, expect, it } from 'vitest';
import { translator, type LaunchPrepDto, type LaunchPrepStepDto } from '@agent-hangar/shared';
import { contextLabel, elapsedLabel, presentLaunchPrep } from './launchPrep.ts';

const t = translator('ja');
const en = translator('en');
const step = (over: Partial<LaunchPrepStepDto> = {}): LaunchPrepStepDto => ({ id: '1', kind: 'local-model', target: 'qwen3.8-27b', action: 'load', state: 'running', fromContext: null, toContext: 65_536, startedAt: 1_000, endedAt: null, reason: null, ...over });
const prep = (over: Partial<LaunchPrepDto> = {}): LaunchPrepDto => ({ key: 'k-12345678', phase: 'running', startedAt: 1_000, endedAt: null, steps: [], ask: null, reason: null, ...over });

describe('起動前の準備の見せ方', () => {
  it('コンテキスト長は 1024 を 1K として丸め、無ければ ? にする', () => {
    expect(contextLabel(65_536)).toBe('64K');
    expect(contextLabel(8_192)).toBe('8K');
    expect(contextLabel(131_072)).toBe('128K');
    expect(contextLabel(null)).toBe('?');
  });
  it('経過時間は m:ss', () => {
    expect(elapsedLabel(0)).toBe('0:00');
    expect(elapsedLabel(9_400)).toBe('0:09');
    expect(elapsedLabel(161_000)).toBe('2:41');
    expect(elapsedLabel(-5)).toBe('0:00');
  });

  it('いまの段の文を 1 行にし、load と reload の間だけ帯を出す', () => {
    const v = presentLaunchPrep(prep({ steps: [step()] }), t, null);
    expect(v.line).toEqual({ text: 'qwen3.8-27b をロード中…（64K）', bar: true });
    expect(presentLaunchPrep(prep({ steps: [step({ action: 'reload', fromContext: 8_192 })] }), t, null).line).toEqual({ text: 'qwen3.8-27b を再ロード中…（64K）', bar: true });
    expect(presentLaunchPrep(prep({ steps: [step({ action: 'check', toContext: null })] }), t, null).line).toEqual({ text: 'LM Studio を確認中…', bar: false });
    expect(presentLaunchPrep(prep({ steps: [step({ action: 'unload', toContext: null })] }), t, null).line).toEqual({ text: 'qwen3.8-27b をアンロード中…', bar: false });
  });
  it('動いている段が無くなったら「opencode を起動中…」にする。段が 1 つも無いうちも同じ', () => {
    const done = step({ state: 'done', endedAt: 15_000 });
    expect(presentLaunchPrep(prep({ steps: [done] }), t, null).line).toEqual({ text: 'opencode を起動中…', bar: false });
    expect(presentLaunchPrep(prep(), t, null).line).toEqual({ text: 'opencode を起動中…', bar: false });
  });
  it('済んだ段を一覧にする。確かめと飛ばした段と失敗した段は載せない', () => {
    const v = presentLaunchPrep(prep({ steps: [
      step({ id: '1', action: 'check', toContext: null, state: 'done', endedAt: 1_500 }),
      step({ id: '2', action: 'unload', target: 'old', toContext: null, state: 'done', endedAt: 2_000 }),
      step({ id: '3', action: 'reload', fromContext: 8_192, state: 'done', startedAt: 2_000, endedAt: 16_000 }),
      step({ id: '4', action: 'load', target: 'small', state: 'done', startedAt: 16_000, endedAt: 17_000 }),
      step({ id: '5', target: 'skipped-one', state: 'skipped', endedAt: 17_000 }),
      step({ id: '6', target: 'broken', state: 'failed', endedAt: 18_000, reason: 'x' }),
    ] }), t, null);
    expect(v.done).toEqual([
      { id: '2', text: 'old をアンロードしました' },
      { id: '3', text: 'qwen3.8-27b をコンテキスト長 64K で再ロードしました（元: 8K / 0:14）' },
      { id: '4', text: 'small をロードしました（64K / 0:01）' },
    ]);
  });
  it('言語は辞書に従う', () => {
    expect(presentLaunchPrep(prep({ steps: [step()] }), en, null).line.text).toContain('qwen3.8-27b');
    expect(presentLaunchPrep(prep({ steps: [step()] }), en, null).line.text).not.toContain('ロード');
  });

  it('失敗の理由は phase が failed のときだけ持つ', () => {
    expect(presentLaunchPrep(prep(), t, null).failure).toBeNull();
    expect(presentLaunchPrep(prep({ phase: 'failed', reason: 'メモリが足りません' }), t, null).failure).toBe('メモリが足りません');
    expect(presentLaunchPrep(prep({ phase: 'failed', reason: null }), t, null).failure).toBe('');
  });
});

describe('準備の問い', () => {
  const inst = (id: string, model: string, context: number | null = 8_192) => ({ instanceId: id, model, sizeBytes: 15 * 1024 ** 3, context });
  const ask = (a: LaunchPrepDto['ask']) => presentLaunchPrep(prep({ phase: 'asking', ask: a }), t, 'lmstudio/qwen3.8-27b').ask;

  it('求めたモデルと別のモデルが手で載っていれば、アンロードしてロードを聞く。外す instance は全部送る', () => {
    const a = ask({ kind: 'unload-manual', model: 'qwen3.8-27b', want: 65_536, blocking: [inst('i1', 'gemma-4-26b'), inst('i2', 'other')] })!;
    expect(a.title).toBe('gemma-4-26b、other をアンロードしてロードしますか？');
    expect(a.body).toBe('LM Studio で手動でロードされた gemma-4-26b、other が残っているため、qwen3.8-27b をロードするためのメモリが足りません。');
    expect(a.hint).toBeNull();
    expect(a.choices.map((c) => [c.label, c.choice, c.primary])).toEqual([
      ['アンロードしてロード', { unload: ['i1', 'i2'] }, true],
      ['そのまま開始', { skip: true }, false],
    ]);
  });
  it('同じモデルしか載っていなければ、再ロードを聞く', () => {
    const a = ask({ kind: 'unload-manual', model: 'qwen3.8-27b', want: 65_536, blocking: [inst('i1', 'qwen3.8-27b', 8_192)] })!;
    expect(a.title).toBe('qwen3.8-27b を 64K で再ロードしますか？');
    expect(a.body).toBe('現在のコンテキスト長は 8K です。opencode の初期指示が収まらないため、64K で再ロードします。');
    expect(a.choices.map((c) => [c.label, c.choice])).toEqual([['再ロード', { unload: ['i1'] }], ['そのまま開始', { skip: true }]]);
  });
  it('メモリが足りないときは、モデルの組を GB で並べ、1 つに寄せる案内を添える', () => {
    const a = ask({ kind: 'memory', models: [
      { model: 'qwen3.8-27b', uses: ['$session', 'build'], sizeBytes: 16.1 * 1024 ** 3 },
      { model: 'gemma-4-26b', uses: ['$small', 'scout'], sizeBytes: 15.6 * 1024 ** 3 },
    ], totalBytes: 31.7 * 1024 ** 3, limitBytes: 25.6 * 1024 ** 3, suggest: 'qwen3.8-27b', suggestRef: 'lmstudio/qwen3.8-27b' })!;
    expect(a.title).toBe('これらのモデルは同時にロードできません');
    expect(a.body).toBe('メイン会話、build: qwen3.8-27b（16.1 GB）、small_model、scout: gemma-4-26b（15.6 GB）。合計で 31.7 GB 必要となり、メモリ上限の目安（25.6 GB / 80%）を超えます。');
    expect(a.hint).toBe('サブエージェントにも同じモデルを指定すると、LM Studio は 1 つのモデルで並列処理するため、メモリに収まります。');
    expect(a.choices.map((c) => [c.label, c.choice])).toEqual([['qwen3.8-27b のみで開始', { singleModel: 'lmstudio/qwen3.8-27b' }], ['そのまま開始', { skip: true }]]);
  });
  it('勧めるモデルの指定（provider/model）が無ければ、1 つに寄せるボタンを出さない', () => {
    const a = presentLaunchPrep(prep({ phase: 'asking', ask: { kind: 'memory', models: [], totalBytes: 1, limitBytes: 1, suggest: 'x', suggestRef: 'x' } }), t, null).ask!;
    expect(a.choices.map((c) => c.label)).toEqual(['そのまま開始']);
  });
  it('asking でなければ問いは出さない', () => {
    expect(presentLaunchPrep(prep({ phase: 'failed', ask: { kind: 'memory', models: [], totalBytes: 1, limitBytes: 1, suggest: 'x', suggestRef: 'a/x' } }), t, 'a/b').ask).toBeNull();
  });
});
