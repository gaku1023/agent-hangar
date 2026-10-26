import { describe, expect, it } from 'vitest';
import type { CodexOptionsDto } from '@agent-hangar/shared';
import { codexAgentNote, codexEffortChoice, codexEffortsOf, codexModelChoice } from './codexLaunch.ts';
import { translatorOf } from './i18n.ts';
import { initialStore } from '../store/store.ts';

const eff = (...ids: string[]) => ids.map((id) => ({ id, description: id }));
const DATA: CodexOptionsDto = {
  version: '0.164.0', verified: true, fetchedAt: 1,
  models: [
    { id: 'm-full', label: 'Full', description: '', efforts: eff('low', 'medium', 'high', 'ultra'), defaultEffort: 'low' },
    { id: 'm-nomedium', label: 'No medium', description: '', efforts: eff('low', 'high'), defaultEffort: 'high' },
  ],
};

describe('codexEffortsOf', () => {
  it('モデルごとの段階を返し、モデルが空なら先頭のモデルの段階を使う', () => {
    expect(codexEffortsOf(DATA, 'm-nomedium').map((e) => e.id)).toEqual(['low', 'high']);
    expect(codexEffortsOf(DATA, '').map((e) => e.id)).toEqual(['low', 'medium', 'high', 'ultra']);
  });
  it('一覧が無い、モデルが一覧に無いときは空', () => {
    expect(codexEffortsOf(null, 'm-full')).toEqual([]);
    expect(codexEffortsOf(DATA, 'gone')).toEqual([]);
  });
});

describe('codexModelChoice', () => {
  it('一覧にあれば前回のまま、無ければデフォルト（空）に戻す。一覧が届く前は前回のまま', () => {
    expect(codexModelChoice('m-full', DATA)).toBe('m-full');
    expect(codexModelChoice('gone', DATA)).toBe('');
    expect(codexModelChoice('m-full', null)).toBe('m-full');
    expect(codexModelChoice('', DATA)).toBe('');
  });
});

describe('codexEffortChoice', () => {
  it('選べる段階ならそのまま、選べないなら medium に戻す', () => {
    expect(codexEffortChoice('ultra', DATA, 'm-full')).toBe('ultra');
    expect(codexEffortChoice('ultra', DATA, 'm-nomedium')).toBe('high');
    expect(codexEffortChoice('', DATA, 'm-full')).toBe('medium');
  });
  it('medium も選べないモデルは、そのモデルの既定の段階', () => {
    expect(codexEffortChoice('ultra', DATA, 'm-nomedium')).toBe('high');
  });
  it('一覧が届く前は、選んだ値か medium', () => {
    expect(codexEffortChoice('high', null, 'x')).toBe('high');
    expect(codexEffortChoice('', null, '')).toBe('medium');
  });
});

describe('codexAgentNote', () => {
  const t = translatorOf(initialStore());
  it('版と確かめの結果。版が分からなければ null', () => {
    expect(codexAgentNote(t, DATA)).toBe('codex 0.164.0 · 検証済み');
    expect(codexAgentNote(t, { ...DATA, verified: false })).toBe('codex 0.164.0 · 未検証');
    expect(codexAgentNote(t, { ...DATA, version: null })).toBeNull();
    expect(codexAgentNote(t, null)).toBeNull();
  });
});
