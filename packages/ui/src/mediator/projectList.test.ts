import type { SearchHitDto } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { initialStore, type Store } from '../store/store.ts';
import { searchParams, usesServerSearch } from './screen.ts';
import { initialState, transition, type Input, type State } from './transition.ts';

// 1 つのプロジェクトの画面の一覧（Q3）は、ホームと同じ検索の状態（State.search）を、そのプロジェクトに絞って使う。
// プロジェクトの絞り込みは画面が決めるので、State.search.filter には入れない。

const action = (i: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: i });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });
const go = (route: Extract<Extract<Input, { kind: 'runtime' }>['event'], { type: 'hash.changed' }>['route']): Input => runtime({ type: 'hash.changed', route });
const hit = (id: string): SearchHitDto => ({ sessionId: id, matchCount: 1, snippets: [] });
const storeWith = (hits: number, total: number): Store => ({ ...initialStore(), search: { params: null, result: { hits: Array.from({ length: hits }, (_, i) => hit(`s${i}`)), total }, loading: false } });

function run(inputs: Input[], start: State = initialState(), store: Store = initialStore()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, store, i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const onProject = (id = 'p1', more: Input[] = []) => run([go({ name: 'project', id }), ...more]);

describe('プロジェクトの画面に入る・出る', () => {
  it('入ると、ホームで掛けていた語と絞り込みを持ち込まず、1 ページ目から読む。問い合わせない', () => {
    const home = run([go({ name: 'home', q: '動画' }), action({ type: 'search.filter', patch: { status: 'done' } }), action({ type: 'search.page', page: 3 })]);
    const r = run([go({ name: 'project', id: 'p1' })], home.state);
    expect(r.state.search).toEqual({ text: '', filter: {}, page: 1 });
    expect(r.effects).toEqual([{ kind: 'api.loadMemo', projectId: 'p1' }]);
  });
  it('別のプロジェクトへ移っても、前のプロジェクトの絞り込みを持ち込まない', () => {
    const a = onProject('p1', [action({ type: 'search.filter', patch: { status: 'paused', days: 7 } })]);
    expect(run([go({ name: 'project', id: 'p2' })], a.state).state.search).toEqual({ text: '', filter: {}, page: 1 });
  });
  it('同じプロジェクトの URL が入り直しても（再読み込みなど）、掛けていた絞り込みを残す', () => {
    const a = onProject('p1', [action({ type: 'search.filter', patch: { status: 'done' } })]);
    expect(run([go({ name: 'project', id: 'p1' })], a.state).state.search.filter).toEqual({ status: 'done' });
  });
  it('ホームへ戻ると、プロジェクトの絞り込みを外して、URL の語だけで開く', () => {
    const a = onProject('p1', [action({ type: 'search.filter', patch: { status: 'done', days: 7 } }), action({ type: 'search.page', page: 2 })]);
    const r = run([go({ name: 'home' })], a.state);
    expect(r.state.search).toEqual({ text: '', filter: {}, page: 1 });
    expect(run([go({ name: 'home', q: '動画' })], a.state).effects).toEqual([{ kind: 'api.search', params: { q: '動画', hideArchived: true, limit: 50 } }]);
  });
  it('セッションを開いて戻ってきたときは、ホームの絞り込みを残す（今までどおり）', () => {
    const a = run([go({ name: 'home' }), action({ type: 'search.filter', patch: { status: 'paused' } }), go({ name: 'session', id: 's1' }), go({ name: 'home' })]);
    expect(a.state.search.filter).toEqual({ status: 'paused' });
  });
});

describe('プロジェクトの画面の検索', () => {
  it('状態のタブだけなら手元で絞り、問い合わせない', () => {
    const a = onProject('p1', [action({ type: 'search.filter', patch: { status: 'paused' } })]);
    expect(a.effects.filter((e) => (e as { kind: string }).kind === 'api.search')).toEqual([]);
    expect(a.state.search.filter).toEqual({ status: 'paused' });
  });
  it('語の問い合わせは、画面のプロジェクトで絞る。絞り込みの状態には projectId を入れない', () => {
    const a = onProject('p1');
    const b = run([action({ type: 'search.query', text: '動画', filter: { status: 'done' } })], a.state);
    expect(b.state.search).toEqual({ text: '動画', filter: { status: 'done' }, page: 1 });
    expect(b.effects).toEqual([{ kind: 'api.search', params: { q: '動画', projectId: 'p1', status: 'done', limit: 50 } }, { kind: 'focus', target: 'results' }]);
    expect(searchParams(b.state)).toEqual({ q: '動画', projectId: 'p1', status: 'done', limit: 50 });
  });
  it('欄で打った project: は、このプロジェクトに絞る画面では効かせず捨てる', () => {
    const a = onProject('p1');
    const b = run([action({ type: 'search.query', text: '動画', filter: { projectId: 'other', days: 7 } })], a.state);
    expect(b.state.search.filter).toEqual({ days: 7 });
    expect(searchParams(b.state).projectId).toBe('p1');
  });
  it('タブを替えたときも、語があれば画面のプロジェクトで問い合わせ直す', () => {
    const a = run([action({ type: 'search.query', text: '動画', filter: {} })], onProject('p1').state);
    const b = run([action({ type: 'search.filter', patch: { status: 'paused' } })], a.state);
    expect(b.effects).toEqual([{ kind: 'api.search', params: { q: '動画', projectId: 'p1', status: 'paused', limit: 50 } }]);
  });
  it('欄の Enter は、画面を移さずに語を入れる。語が空なら問い合わせない', () => {
    const a = onProject('p1');
    const b = run([action({ type: 'search.query', text: '', filter: { status: 'done' } })], a.state);
    expect(b.effects).toEqual([{ kind: 'focus', target: 'results' }]);
    expect(b.state.screen).toEqual({ name: 'project', id: 'p1' });
  });
  it('パレットの全文検索（filter なし）は、これまでどおりホームの検索へ移る', () => {
    const a = onProject('p1', [action({ type: 'search.filter', patch: { status: 'done' } })]);
    const b = run([action({ type: 'search.query', text: '動画' })], a.state);
    expect(b.effects).toEqual([{ kind: 'navigate', route: { name: 'home', q: '動画' } }, { kind: 'focus', target: 'results' }]);
    // 着いたホームには、プロジェクトの絞り込みを持ち込まない。
    expect(run([go({ name: 'home', q: '動画' })], b.state).state.search).toEqual({ text: '動画', filter: {}, page: 1 });
  });
  it('「条件をクリア」は、プロジェクトの画面に留まったまま語と絞り込みを外す', () => {
    const a = run([action({ type: 'search.query', text: '動画', filter: { status: 'done' } })], onProject('p1').state);
    const b = run([action({ type: 'search.clear' })], a.state);
    expect(b.state.search).toEqual({ text: '', filter: {}, page: 1 });
    expect(b.effects).toEqual([]);
    expect(usesServerSearch(b.state.search)).toBe(false);
  });
  it('続きの読み込みは、画面のプロジェクトで絞って offset を足す', () => {
    const a = run([action({ type: 'search.query', text: '動画', filter: {} })], onProject('p1').state);
    const b = run([action({ type: 'search.more' })], a.state, storeWith(50, 120));
    expect(b.effects).toEqual([{ kind: 'api.search', params: { q: '動画', projectId: 'p1', hideArchived: true, limit: 50, offset: 50 }, append: true }]);
  });
  it('ページ送りは手元の一覧のページだけを覚える', () => {
    const a = onProject('p1', [action({ type: 'search.page', page: 3 })]);
    expect(a.state.search.page).toBe(3);
  });
});
