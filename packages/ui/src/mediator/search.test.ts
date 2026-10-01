import { describe, expect, it } from 'vitest';
import type { Input } from './types.ts';
import { initialState, transition, type State } from './transition.ts';
import { hasConditions } from './screen.ts';

function run(inputs: Input[], start: State = initialState()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const intent = (i: Extract<Input, { kind: 'intent' }>['intent']): Input => ({ kind: 'intent', intent: i });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });

describe('状態のタブと欄の条件（★）', () => {
  it('欄の Enter は、読んだ条件をまるごと渡して今の絞り込みと入れ替える', () => {
    const a = run([intent({ type: 'search.filter', patch: { projectId: 'p1', status: 'paused' } }), intent({ type: 'search.query', text: '動画', filter: { status: 'done', days: 7 } })]);
    expect(a.state.search).toEqual({ text: '動画', filter: { status: 'done', days: 7 } });
  });
  it('filter の無い search.query（パレットの全文検索）は今の絞り込みを保つ', () => {
    const a = run([intent({ type: 'search.filter', patch: { status: 'paused' } }), intent({ type: 'search.query', text: '動画' })]);
    expect(a.state.search).toEqual({ text: '動画', filter: { status: 'paused' } });
  });
  it('サーバへは状態を status で渡し、状態が無いときは Archived を除く印を付ける', () => {
    const a = run([runtime({ type: 'hash.changed', route: { name: 'sessions', q: '動画' } })]);
    expect(a.effects).toEqual([{ kind: 'api.search', params: { q: '動画', hideArchived: true } }]);
    const b = run([intent({ type: 'search.filter', patch: { status: 'archived' } })], a.state);
    expect(b.effects).toEqual([{ kind: 'api.search', params: { q: '動画', status: 'archived' } }]);
  });
  it('状態のタブだけなら手元で絞り、問い合わせない', () => {
    const a = run([runtime({ type: 'hash.changed', route: { name: 'sessions' } }), intent({ type: 'search.filter', patch: { status: 'paused' } })]);
    expect(a.effects).toEqual([]);
  });
  it('条件が 1 つでも効いているかを hasConditions が言う', () => {
    expect(hasConditions({ text: '', filter: {} })).toBe(false);
    expect(hasConditions({ text: '', filter: { status: undefined, projectId: undefined } })).toBe(false);
    expect(hasConditions({ text: '', filter: { status: 'done' } })).toBe(true);
    expect(hasConditions({ text: '', filter: { live: 'waiting' } })).toBe(true);
    expect(hasConditions({ text: 'x', filter: {} })).toBe(true);
  });
  it('同じ語のままトークンだけ変えて Enter を押しても、問い合わせ直す（ハッシュが変わらないので自分で出す）', () => {
    const at = run([runtime({ type: 'hash.changed', route: { name: 'sessions', q: '動画' } })]);
    const a = run([intent({ type: 'search.query', text: '動画', filter: { status: 'done' } })], at.state);
    expect(a.effects).toEqual([
      { kind: 'api.search', params: { q: '動画', status: 'done' } },
      { kind: 'navigate', route: { name: 'sessions', q: '動画' } },
      { kind: 'focus', target: 'results' },
    ]);
  });
  it('語が変わるときは移った先の hash.changed が問い合わせるので、Enter では出さない', () => {
    const at = run([runtime({ type: 'hash.changed', route: { name: 'sessions', q: '動画' } })]);
    const a = run([intent({ type: 'search.query', text: '音声', filter: { status: 'done' } })], at.state);
    expect(a.effects.map((e) => (e as { kind: string }).kind)).toEqual(['navigate', 'focus']);
    // 語の無い一覧から語を足すときも同じ。
    const b = run([runtime({ type: 'hash.changed', route: { name: 'sessions' } }), intent({ type: 'search.query', text: '音声', filter: {} })]);
    expect(b.effects.map((e) => (e as { kind: string }).kind)).toEqual(['navigate', 'focus']);
  });
  it('語の無いままトークンだけ変えたときは、触ったファイルが無ければ手元で絞るので問い合わせない', () => {
    const a = run([runtime({ type: 'hash.changed', route: { name: 'sessions' } }), intent({ type: 'search.query', text: '', filter: { status: 'paused' } })]);
    expect(a.effects.map((e) => (e as { kind: string }).kind)).toEqual(['navigate', 'focus']);
    const b = run([runtime({ type: 'hash.changed', route: { name: 'sessions' } }), intent({ type: 'search.query', text: '', filter: { file: 'a.md' } })]);
    expect(b.effects).toEqual([
      { kind: 'api.search', params: { q: '', file: 'a.md', hideArchived: true } },
      { kind: 'navigate', route: { name: 'sessions' } },
      { kind: 'focus', target: 'results' },
    ]);
  });
});
