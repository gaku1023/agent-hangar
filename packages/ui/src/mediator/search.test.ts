import { describe, expect, it } from 'vitest';
import type { Input } from './types.ts';
import { initialState, transition, type State } from './transition.ts';
import { initialStore } from '../store/store.ts';
import { hasConditions } from './screen.ts';

function run(inputs: Input[], start: State = initialState()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, initialStore(), i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const action = (i: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: i });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });

describe('状態のタブと欄の条件（★）', () => {
  it('欄の Enter は、読んだ条件をまるごと渡して今の絞り込みと入れ替える', () => {
    const a = run([action({ type: 'search.filter', patch: { projectId: 'p1', status: 'paused' } }), action({ type: 'search.query', text: '動画', filter: { status: 'done', days: 7 } })]);
    expect(a.state.search).toEqual({ text: '動画', filter: { status: 'done', days: 7 }, page: 1 });
  });
  it('filter の無い search.query（パレットの全文検索）は今の絞り込みを保つ', () => {
    const a = run([action({ type: 'search.filter', patch: { status: 'paused' } }), action({ type: 'search.query', text: '動画' })]);
    expect(a.state.search).toEqual({ text: '動画', filter: { status: 'paused' }, page: 1 });
  });
  it('サーバへは状態を status で渡し、状態が無いときは Archived を除く印を付ける', () => {
    const a = run([runtime({ type: 'hash.changed', route: { name: 'home', q: '動画' } })]);
    expect(a.effects).toEqual([{ kind: 'api.search', params: { q: '動画', hideArchived: true, limit: 50 } }]);
    const b = run([action({ type: 'search.filter', patch: { status: 'archived' } })], a.state);
    expect(b.effects).toEqual([{ kind: 'api.search', params: { q: '動画', status: 'archived', limit: 50 } }]);
  });
  it('状態のタブだけなら手元で絞り、問い合わせない', () => {
    const a = run([runtime({ type: 'hash.changed', route: { name: 'home' } }), action({ type: 'search.filter', patch: { status: 'paused' } })]);
    expect(a.effects).toEqual([]);
  });
  it('条件が 1 つでも効いているかを hasConditions が言う', () => {
    expect(hasConditions({ text: '', filter: {} })).toBe(false);
    expect(hasConditions({ text: '', filter: { status: undefined, projectId: undefined } })).toBe(false);
    expect(hasConditions({ text: '', filter: { status: 'done' } })).toBe(true);
    expect(hasConditions({ text: '', filter: { live: 'waiting' } })).toBe(true);
    expect(hasConditions({ text: 'x', filter: {} })).toBe(true);
  });
  it('欄の Enter は移る効果を出し、問い合わせは移った先の hash.changed が出す（同じ語でも Runtime が hash.changed を返す）', () => {
    const at = run([runtime({ type: 'hash.changed', route: { name: 'home', q: '動画' } })]);
    const a = run([action({ type: 'search.query', text: '動画', filter: { status: 'done' } })], at.state);
    expect(a.effects).toEqual([{ kind: 'navigate', route: { name: 'home', q: '動画' } }, { kind: 'focus', target: 'results' }]);
    // その hash.changed が、入れ替えた後の絞り込みで問い合わせる。
    const b = run([runtime({ type: 'hash.changed', route: { name: 'home', q: '動画' } })], a.state);
    expect(b.effects).toEqual([{ kind: 'api.search', params: { q: '動画', status: 'done', limit: 50 } }]);
  });
  it('語の無いまま触ったファイルだけを変えたときも、hash.changed が入れ替え後の絞り込みで問い合わせる', () => {
    const a = run([runtime({ type: 'hash.changed', route: { name: 'home' } }), action({ type: 'search.query', text: '', filter: { file: 'a.md' } }), runtime({ type: 'hash.changed', route: { name: 'home' } })]);
    expect(a.effects).toEqual([
      { kind: 'navigate', route: { name: 'home' } },
      { kind: 'focus', target: 'results' },
      { kind: 'api.search', params: { q: '', file: 'a.md', hideArchived: true, limit: 50 } },
    ]);
  });
});
