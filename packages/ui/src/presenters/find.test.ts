import { describe, expect, it } from 'vitest';
import { toolItem } from '../test/items.ts';
import { findIn, itemLeaves } from './find.ts';
import type { TranscriptItem } from './session.ts';

const items: TranscriptItem[] = [
  { kind: 'user', seq: 0, text: 'バリデーションを足して', when: '' },
  { kind: 'assistant', seq: 1, text: '**バリデーション**を足します。`バリデーション` の関数も', when: '' },
  toolItem(2, 'Bash', { command: 'echo バリデーション' }, { text: 'バリデーション ok', isError: false }),
  { kind: 'system', seq: 3, text: '無関係', when: '' },
  { kind: 'assistant', seq: 4, text: 'バリデーション', when: '' },
];

describe('itemLeaves', () => {
  it('返答は Markdown の葉、ツールは行と中身の葉、ほかは本文そのもの', () => {
    expect(itemLeaves(items[0]!)).toEqual(['バリデーションを足して']);
    expect(itemLeaves(items[1]!)).toEqual(['バリデーション', 'を足します。', 'バリデーション', ' の関数も']);
    expect(itemLeaves(items[2]!)).toEqual(['echo バリデーション', 'echo バリデーション', 'バリデーション ok']);
  });
});

describe('findIn', () => {
  const find = (over: Partial<Parameters<typeof findIn>[1]> = {}) => findIn(items, { query: 'バリデーション', caseSensitive: false, from: null, step: 0, n: 1, ...over });
  it('行ごとの一致の数と全体の数を数え、印の付く行を並べる', () => {
    const f = find();
    expect(f.total).toBe(7);
    expect([...f.hits]).toEqual([[0, 1], [1, 2], [2, 3], [4, 1]]);
    expect(f.ticks).toEqual([0, 1, 2, 4]);
  });
  it('今の一致は最初の一致から step だけ進めたもので、端で折り返す', () => {
    expect(find()).toMatchObject({ current: 0, seq: 0, ordinal: 0 });
    expect(find({ step: 2 })).toMatchObject({ current: 2, seq: 1, ordinal: 1 });
    expect(find({ step: 5 })).toMatchObject({ current: 5, seq: 2, ordinal: 2 });
    expect(find({ step: 7 })).toMatchObject({ current: 0, seq: 0 });
    expect(find({ step: -1 })).toMatchObject({ current: 6, seq: 4, ordinal: 0 });
  });
  it('from があれば、その seq 以降の最初の一致から数える', () => {
    expect(find({ from: 2 })).toMatchObject({ current: 3, seq: 2, ordinal: 0 });
    expect(find({ from: 3 })).toMatchObject({ current: 6, seq: 4 });
    // 後ろに一致が無ければ先頭へ戻る。
    expect(find({ from: 9 })).toMatchObject({ current: 0, seq: 0 });
  });
  it('大文字と小文字を分けるときは分けて数える', () => {
    const it2: TranscriptItem[] = [{ kind: 'user', seq: 0, text: 'Foo foo', when: '' }];
    expect(findIn(it2, { query: 'foo', caseSensitive: false, from: null, step: 0, n: 1 }).total).toBe(2);
    expect(findIn(it2, { query: 'foo', caseSensitive: true, from: null, step: 0, n: 1 }).total).toBe(1);
  });
  it('語が空か一致が無ければ、今の一致は無い', () => {
    expect(find({ query: '' })).toMatchObject({ total: 0, current: -1, seq: null });
    expect(find({ query: 'ない語' })).toMatchObject({ total: 0, current: -1, seq: null, ticks: [] });
  });
});
