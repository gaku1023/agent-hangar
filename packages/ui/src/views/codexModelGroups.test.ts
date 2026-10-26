import { describe, expect, it } from 'vitest';
import { splitCodexModels } from './codexModelGroups.ts';

const m = (id: string) => ({ id, label: id, description: '', efforts: [], defaultEffort: null });

describe('splitCodexModels', () => {
  it('いちばん新しい版より古い版の gpt を「過去のモデル」に分け、並びは保つ', () => {
    const { current, older } = splitCodexModels([m('gpt-6.1-sol'), m('gpt-6-astra'), m('gpt-5.6-sol'), m('gpt-6-luna'), m('gpt-5.6-luna')]);
    expect(current.map((x) => x.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']);
    expect(older.map((x) => x.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna']);
  });
  it('版の読めない名前は上に残す', () => {
    const { current, older } = splitCodexModels([m('gpt-6-sol'), m('codex-mini'), m('gpt-5-sol')]);
    expect(current.map((x) => x.id)).toEqual(['gpt-6-sol', 'codex-mini']);
    expect(older.map((x) => x.id)).toEqual(['gpt-5-sol']);
  });
  it('版が 1 つだけなら分けない', () => {
    expect(splitCodexModels([m('gpt-6-sol'), m('gpt-6.1-luna')]).older).toEqual([]);
    expect(splitCodexModels([m('o4'), m('codex-mini')]).older).toEqual([]);
  });
});
