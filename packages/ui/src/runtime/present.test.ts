// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { createPresent, PALETTE_MORPH, SESSION_MORPH, type PresentEnv } from './present.ts';

const at = (screen: State['screen'], overlay: State['overlay'] = { kind: 'none' }): State => ({ ...initialState(), screen, overlay });
const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
// jsdom は view-transition-name を知らないので、付けていない要素では undefined が返る。空文字にそろえて読む。
const name = (sel: string) => $(sel).style.viewTransitionName || '';
const flush = () => new Promise((r) => setTimeout(r, 0));

/** View Transitions の偽物。本物は写しを取ってから非同期に update を呼ぶので、呼ぶ時を試験が決める。 */
function fake(over: Partial<PresentEnv> = {}) {
  const updates: (() => void)[] = [];
  let settle: { ok: () => void; ng: (e: unknown) => void } | null = null;
  const start = vi.fn((update: () => void) => {
    updates.push(update);
    const finished = new Promise<void>((ok, ng) => { settle = { ok: () => ok(), ng }; });
    return { ready: finished, finished };
  });
  const env: PresentEnv = { startViewTransition: start, reducedMotion: () => false, flushSync: (fn) => fn(), root: document, pressed: () => null, focused: () => null, ...over };
  return { env, start, run: () => updates.shift()!(), finish: () => settle!.ok(), skip: () => settle!.ng(new DOMException('skipped', 'AbortError')) };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('createPresent', () => {
  it('画面が替わらず、パレットも閉じないなら、包まずにその場で描く', () => {
    const f = fake();
    const commit = vi.fn();
    createPresent(f.env)(commit, at({ name: 'home' }), { ...at({ name: 'home' }), connection: 'connected' });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('Sessions の検索語が変わるだけなら包まない。打つたびに画面の移り変わりを走らせない', () => {
    const f = fake();
    const commit = vi.fn();
    createPresent(f.env)(commit, at({ name: 'sessions', q: 'a' }), at({ name: 'sessions', q: 'ab' }));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('起動中からの最初の描画は包まない', () => {
    const f = fake();
    const commit = vi.fn();
    createPresent(f.env)(commit, at({ name: 'booting' }), at({ name: 'home' }));
    expect(f.start).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['View Transitions が無い環境', { startViewTransition: undefined }],
    ['reduced motion', { reducedMotion: () => true }],
  ])('%s では、包まずにその場で描く', (_label, over) => {
    const f = fake(over);
    const commit = vi.fn();
    createPresent(f.env)(commit, at({ name: 'home' }), at({ name: 'projects' }));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('押した行から上段へ広げる。同じセッションのほかの札には名前を付けない', async () => {
    document.body.innerHTML = '<div id="card" data-morph-id="s1"></div><div id="row" data-morph-id="s1"><span id="in"></span></div>';
    const f = fake({ pressed: () => $('#in') });
    const commit = vi.fn(() => { document.body.innerHTML = '<div id="hero" data-morph-hero="s1"></div>'; });
    createPresent(f.env)(commit, at({ name: 'home' }), at({ name: 'session', id: 's1' }));
    expect(commit).not.toHaveBeenCalled();
    expect(name('#row')).toBe(SESSION_MORPH);
    expect(name('#card')).toBe('');
    f.run();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(name('#hero')).toBe(SESSION_MORPH);
    f.finish();
    await flush();
    expect(name('#hero')).toBe('');
  });
  it('一覧のカーソルの行を Enter で開いたときは、その行から広げる', () => {
    document.body.innerHTML = '<div class="rows-host" id="host"><div id="a" data-morph-id="s1"></div><div id="b" data-morph-id="s1" data-cursor="true"></div></div>';
    const f = fake({ focused: () => $('#host') });
    createPresent(f.env)(() => {}, at({ name: 'project', id: 'p1' }), at({ name: 'session', id: 's1' }));
    expect(name('#b')).toBe(SESSION_MORPH);
    expect(name('#a')).toBe('');
  });
  it('パレットから開いたときは行を広げず、ふつうの画面遷移にする', () => {
    document.body.innerHTML = '<div id="row" data-morph-id="s1"></div><div class="dialog palette"><input id="palette-input"></div><input id="global-search">';
    const f = fake({ focused: () => $('#palette-input') });
    const commit = vi.fn(() => { document.body.innerHTML = '<div id="hero" data-morph-hero="s1"></div><input id="global-search">'; });
    createPresent(f.env)(commit, at({ name: 'home' }, { kind: 'palette' }), at({ name: 'session', id: 's1' }));
    expect(name('#row')).toBe('');
    expect(name('.palette')).toBe(PALETTE_MORPH);
    f.run();
    expect(name('#hero')).toBe('');
    expect(name('#global-search')).toBe(PALETTE_MORPH);
  });
  it('セッション画面から戻ると、上段が元の行へ縮んで帰る', () => {
    document.body.innerHTML = '<div id="hero" data-morph-hero="s1"></div>';
    const f = fake();
    createPresent(f.env)(() => { document.body.innerHTML = '<div id="row" data-morph-id="s1"></div>'; }, at({ name: 'session', id: 's1' }), at({ name: 'home' }));
    expect(name('#hero')).toBe(SESSION_MORPH);
    f.run();
    expect(name('#row')).toBe(SESSION_MORPH);
  });
  it('広がる元が無ければ、行き先にも名前を付けない', () => {
    const f = fake();
    createPresent(f.env)(() => { document.body.innerHTML = '<div id="hero" data-morph-hero="s1"></div>'; }, at({ name: 'home' }), at({ name: 'session', id: 's1' }));
    f.run();
    expect(name('#hero')).toBe('');
  });
  it('パレットが閉じると、パレットから検索欄の錠剤へ戻る', () => {
    document.body.innerHTML = '<div class="dialog palette"></div><input id="global-search">';
    const f = fake();
    createPresent(f.env)(() => { $('.palette').remove(); }, at({ name: 'home' }, { kind: 'palette' }), at({ name: 'home' }));
    expect(name('.palette')).toBe(PALETTE_MORPH);
    expect(name('#global-search')).toBe('');
    f.run();
    expect(name('#global-search')).toBe(PALETTE_MORPH);
  });
  it('次の遷移に割り込まれても、名前を外し、拒否を外へ漏らさない', async () => {
    document.body.innerHTML = '<div class="dialog palette"></div><input id="global-search">';
    const f = fake();
    createPresent(f.env)(() => { $('.palette').remove(); }, at({ name: 'home' }, { kind: 'palette' }), at({ name: 'home' }));
    f.run();
    f.skip();
    await flush();
    expect(name('#global-search')).toBe('');
  });
  it('包んだ中で、描画を flushSync で同期させる', () => {
    const order: string[] = [];
    const f = fake({ flushSync: (fn) => { order.push('flush'); fn(); order.push('flushed'); } });
    createPresent(f.env)(() => order.push('commit'), at({ name: 'home' }), at({ name: 'projects' }));
    f.run();
    expect(order).toEqual(['flush', 'commit', 'flushed']);
  });
});
