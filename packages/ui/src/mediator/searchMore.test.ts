import type { SearchHitDto } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { initialStore, type Store } from '../store/store.ts';
import { SEARCH_STEP } from './screen.ts';
import { initialState, transition, type Input, type State } from './transition.ts';

const hit = (id: string): SearchHitDto => ({ sessionId: id, matchCount: 1, snippets: [] });
const storeWith = (hits: number, total: number, loading = false): Store => ({ ...initialStore(), search: { params: null, result: { hits: Array.from({ length: hits }, (_, i) => hit(`s${i}`)), total }, loading } });
const intent = (i: Extract<Input, { kind: 'intent' }>['intent']): Input => ({ kind: 'intent', intent: i });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });
const at = (state: State, store: Store, input: Input) => transition(state, store, input);
/** ホームで語を検索した状態。 */
const searching = (): State => transition(initialState(), initialStore(), runtime({ type: 'hash.changed', route: { name: 'home', q: '動画' } })).state;

describe('検索の「さらに読み込む」（search.more）', () => {
  it('1 回に読む件数は 50 で、最初の検索は先頭から読む（ページ送りの件数や番号には依らない）', () => {
    expect(SEARCH_STEP).toBe(50);
    const state = transition(initialState(), initialStore(), intent({ type: 'list.pageSize', size: 200 })).state;
    const r = at({ ...state, search: { ...state.search, page: 3 } }, initialStore(), runtime({ type: 'hash.changed', route: { name: 'home', q: '動画' } }));
    expect(r.effects).toEqual([{ kind: 'api.search', params: { q: '動画', hideArchived: true, limit: 50 } }]);
  });

  it('持っている行の数を offset にして、続きを追記で問い合わせる', () => {
    const r = at(searching(), storeWith(50, 132), intent({ type: 'search.more' }));
    expect(r.effects).toEqual([{ kind: 'api.search', params: { q: '動画', hideArchived: true, limit: 50, offset: 50 }, append: true }]);
    expect(r.state).toEqual(searching());
  });

  it('絞り込みは最初の検索と同じものをかける', () => {
    const state = at(searching(), initialStore(), intent({ type: 'search.filter', patch: { projectId: 'p1', days: 7 } })).state;
    const r = at(state, storeWith(50, 80), intent({ type: 'search.more' }));
    expect(r.effects).toEqual([{ kind: 'api.search', params: { q: '動画', projectId: 'p1', days: 7, hideArchived: true, limit: 50, offset: 50 }, append: true }]);
  });

  it('読み込み中と、全部読み終えたあと、まだ何も読んでいないときは何もしない', () => {
    expect(at(searching(), storeWith(50, 132, true), intent({ type: 'search.more' })).effects).toEqual([]);
    expect(at(searching(), storeWith(132, 132), intent({ type: 'search.more' })).effects).toEqual([]);
    expect(at(searching(), initialStore(), intent({ type: 'search.more' })).effects).toEqual([]);
  });

  it('サーバに問い合わせない一覧（語も触ったファイルも無い）では何もしない', () => {
    const state = transition(initialState(), initialStore(), runtime({ type: 'hash.changed', route: { name: 'home' } })).state;
    expect(at(state, storeWith(50, 132), intent({ type: 'search.more' })).effects).toEqual([]);
  });

  it('ページ送りと件数の切り替えは、検索を問い合わせ直さない（ページ送りは手元の一覧のもの）', () => {
    expect(at(searching(), storeWith(50, 132), intent({ type: 'search.page', page: 2 })).effects).toEqual([]);
    expect(at(searching(), storeWith(50, 132), intent({ type: 'list.pageSize', size: 100 })).effects.filter((e) => e.kind === 'api.search')).toEqual([]);
  });
});
