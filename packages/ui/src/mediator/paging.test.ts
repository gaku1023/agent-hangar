import { describe, expect, it } from 'vitest';
import type { Input } from './types.ts';
import { initialState, transition, type State } from './transition.ts';
import { initialStore } from '../store/store.ts';
import { PAGE_SIZE_KEY, PAGE_SIZES, readPageSize } from './paging.ts';

function run(inputs: Input[], start: State = initialState()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, initialStore(), i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const intent = (i: Extract<Input, { kind: 'intent' }>['intent']): Input => ({ kind: 'intent', intent: i });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });
const sessions = (q?: string) => runtime({ type: 'hash.changed', route: q ? { name: 'home', q } : { name: 'home' } });

describe('一覧のページ送り（A4）', () => {
  it('はじめは 1 ページ目、1 ページ 50 件', () => {
    expect(initialState().search.page).toBe(1);
    expect(initialState().pageSize).toBe(50);
  });

  it('手元で組む一覧のページ送りは、問い合わせずにページだけを変える', () => {
    const a = run([sessions(), intent({ type: 'search.filter', patch: { status: 'done' } }), intent({ type: 'search.page', page: 3 })]);
    expect(a.state.search.page).toBe(3);
    expect(a.effects).toEqual([]);
  });

  it('検索の結果は「さらに読み込む」で足す。ページ送りは検索を問い合わせ直さず、最初の検索は先頭から 50 件を読む', () => {
    const a = run([sessions('動画')]);
    expect(a.effects).toEqual([{ kind: 'api.search', params: { q: '動画', hideArchived: true, limit: 50 } }]);
    const b = run([intent({ type: 'search.page', page: 3 })], a.state);
    expect(b.effects).toEqual([]);
  });

  it('1 より前のページへは行かない', () => {
    const a = run([sessions(), intent({ type: 'search.page', page: 0 })]);
    expect(a.state.search.page).toBe(1);
  });

  it('タブ・絞り込み・語・条件のクリアは 1 ページ目に戻す', () => {
    const at = run([sessions(), intent({ type: 'search.filter', patch: { status: 'done' } }), intent({ type: 'search.page', page: 4 })]).state;
    expect(run([intent({ type: 'search.filter', patch: { status: 'paused' } })], at).state.search.page).toBe(1);
    expect(run([intent({ type: 'search.query', text: '動画' })], at).state.search.page).toBe(1);
    expect(run([intent({ type: 'search.clear' })], at).state.search.page).toBe(1);
  });

  it('画面に入り直したら 1 ページ目から', () => {
    const at = run([sessions(), intent({ type: 'search.filter', patch: { status: 'done' } }), intent({ type: 'search.page', page: 4 })]).state;
    const b = run([runtime({ type: 'hash.changed', route: { name: 'home' } }), sessions()], at);
    expect(b.state.search.page).toBe(1);
  });

  it('件数を変えると、見ていた先頭の行を含むページに留まり、件数を覚える', () => {
    // 3 ページ目（50 件ずつ）の先頭は 101 件目。100 件ずつなら 2 ページ目に入る。
    const at = run([sessions(), intent({ type: 'search.filter', patch: { status: 'done' } }), intent({ type: 'search.page', page: 3 })]).state;
    const b = run([intent({ type: 'list.pageSize', size: 100 })], at);
    expect(b.state.pageSize).toBe(100);
    expect(b.state.search.page).toBe(2);
    expect(b.effects).toEqual([{ kind: 'storage.save', key: PAGE_SIZE_KEY, value: 100 }]);
    // 25 件ずつなら 101 件目は 5 ページ目。
    expect(run([intent({ type: 'list.pageSize', size: 25 })], at).state.search.page).toBe(5);
  });

  it('検索の結果は件数に依らず 50 件ずつ読むので、件数を変えても問い合わせ直さない', () => {
    const at = run([sessions('動画'), intent({ type: 'search.page', page: 3 })]).state;
    const b = run([intent({ type: 'list.pageSize', size: 100 })], at);
    expect(b.effects).toEqual([{ kind: 'storage.save', key: PAGE_SIZE_KEY, value: 100 }]);
  });

  it('選択肢に無い件数は受け取らない', () => {
    const a = run([sessions(), intent({ type: 'list.pageSize', size: 70 })]);
    expect(a.state.pageSize).toBe(50);
    expect(a.effects).toEqual([]);
  });

  it('保存した件数は、選択肢に入っているものだけ読み戻す', () => {
    expect(PAGE_SIZES).toEqual([25, 50, 100, 200]);
    expect(readPageSize(100)).toBe(100);
    expect(readPageSize(70)).toBe(50);
    expect(readPageSize('100')).toBe(50);
    expect(readPageSize(undefined)).toBe(50);
  });
});
