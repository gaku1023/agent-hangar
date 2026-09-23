import { describe, expect, it } from 'vitest';
import { createHashLocation } from './hashLocation.ts';

/** ハッシュを押すと、段は新しくなり、印（state）は空に戻る。本物の履歴と同じ振る舞いを写す。 */
function fake() {
  let hash = '#/';
  let state: unknown = null;
  const gone: number[] = [];
  const history = {
    get state() { return state; },
    replaceState: (s: unknown) => { state = s; },
    go: (d: number) => { gone.push(d); },
  };
  const location = {
    get hash() { return hash; },
    set hash(v: string) { hash = v; state = null; },
  };
  return { history, location, gone, peek: () => ({ hash, state }) };
}

describe('ハッシュの履歴', () => {
  it('最初の段の深さは 0', () => {
    const f = fake();
    const loc = createHashLocation(f.history, f.location, () => () => {});
    expect(loc.depth()).toBe(0);
  });

  it('進むたびに深さが増える', () => {
    const f = fake();
    const loc = createHashLocation(f.history, f.location, () => () => {});
    loc.setHash('#/projects');
    expect(loc.depth()).toBe(1);
    loc.setHash('#/sessions');
    expect(loc.depth()).toBe(2);
    expect(f.peek().hash).toBe('#/sessions');
  });

  it('印の無い段は深さ 0 とみなす', () => {
    // アプリの外から来た段（起動直後の頁など）には印が無い。
    const f = fake();
    const loc = createHashLocation(f.history, f.location, () => () => {});
    loc.setHash('#/projects');
    f.history.replaceState(null);
    expect(loc.depth()).toBe(0);
  });

  it('go はそのまま履歴へ渡す', () => {
    const f = fake();
    const loc = createHashLocation(f.history, f.location, () => () => {});
    loc.go(-1);
    loc.go(1);
    expect(f.gone).toEqual([-1, 1]);
  });
});
