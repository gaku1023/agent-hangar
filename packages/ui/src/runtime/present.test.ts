// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { createPresent, PALETTE_MORPH, SESSION_MORPH, SESSION_MORPH_DOT, SESSION_MORPH_NAME, type PresentEnv } from './present.ts';

const at = (screen: State['screen'], overlay: State['overlay'] = { kind: 'none' }): State => ({ ...initialState(), screen, overlay });
const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
// jsdom は view-transition-name を知らないので、付けていない要素では undefined が返る。空文字にそろえて読む。
const name = (sel: string) => $(sel).style.viewTransitionName || '';
const flush = () => new Promise((r) => setTimeout(r, 0));

/** View Transitions の偽物。本物は写しを取ってから非同期に update を呼ぶので、呼ぶ時を試験が決める。
 * 遷移ごとに終わり方を持ち、finish と skip は既定で最後の遷移を、引数で i 番目の遷移を終わらせる。 */
function fake(over: Partial<PresentEnv> = {}) {
  const updates: (() => void)[] = [];
  const settles: { ok: () => void; ng: (e: unknown) => void }[] = [];
  const skips: ReturnType<typeof vi.fn>[] = [];
  const start = vi.fn((update: () => void) => {
    updates.push(update);
    const finished = new Promise<void>((ok, ng) => { settles.push({ ok: () => ok(), ng }); });
    const skipTransition = vi.fn();
    skips.push(skipTransition);
    return { ready: finished, finished, skipTransition };
  });
  const env: PresentEnv = { startViewTransition: start, reducedMotion: () => false, flushSync: (fn) => fn(), root: document, pressed: () => null, focused: () => null, visible: () => true, ...over };
  const pick = (i?: number) => settles[i ?? settles.length - 1]!;
  return { env, start, skips, run: () => updates.shift()!(), finish: (i?: number) => pick(i).ok(), skip: (i?: number) => pick(i).ng(new DOMException('skipped', 'AbortError')) };
}

// 行、Home の実行中の札、セッション画面の上段。点と名前を持つ。
const row = (id: string, s = 's1') => `<div class="row" id="${id}" data-morph-id="${s}"><span class="dot" id="${id}-dot"></span><span class="row-main"><span class="row-name" id="${id}-name">名前</span></span></div>`;
const card = (id: string, s = 's1') => `<div class="live-card" id="${id}" data-morph-id="${s}"><div class="live-head"><span class="dot" id="${id}-dot"></span><span class="live-name" id="${id}-name">名前</span></div></div>`;
const hero = (s = 's1') => `<div class="session-hero" id="hero" data-morph-hero="${s}"><span class="dot" id="hero-dot"></span><h1 class="session-name" id="hero-name">名前</h1></div>`;
const trio = (id: string) => [name(`#${id}`), name(`#${id}-dot`), name(`#${id}-name`)];
const MORPHS = [SESSION_MORPH, SESSION_MORPH_DOT, SESSION_MORPH_NAME];
const NONE = ['', '', ''];

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
  // 隠れた錠剤に名前を付けても行き先にならず、パレットの写しがその場に残って薄れていく。
  it('戻る先の錠剤が見えていなければ、パレットに名前を付けない。写しが残らない', () => {
    document.body.innerHTML = '<div class="dialog palette"></div><button id="global-search" style="display: none"></button>';
    const f = fake();
    createPresent(f.env)(() => { $('.palette').remove(); }, at({ name: 'home' }, { kind: 'palette' }), at({ name: 'home' }));
    expect(name('.palette')).toBe('');
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
  // 遷移の間は写しが画面を覆い、クリックが下の部品に届かない。押されたら遷移を終わらせて、クリックを通す（clickThrough.ts）。
  it('skip は動いている遷移を終わらせて true を返し、遷移が無ければ何もせず false を返す', async () => {
    const f = fake();
    const present = createPresent(f.env);
    expect(present.skip()).toBe(false);
    present(() => {}, at({ name: 'home' }), at({ name: 'projects' }));
    expect(present.skip()).toBe(true);
    expect(f.skips[0]).toHaveBeenCalledTimes(1);
    // 一度終わらせた遷移は、もう終わらせない。
    expect(present.skip()).toBe(false);
    present(() => {}, at({ name: 'projects' }), at({ name: 'sessions' }));
    f.run();
    f.finish();
    await flush();
    expect(present.skip()).toBe(false);
    expect(f.skips[1]).not.toHaveBeenCalled();
  });
  it('割り込まれた前の遷移が終わっても、後の遷移は終わらせられるままである', async () => {
    const f = fake();
    const present = createPresent(f.env);
    present(() => {}, at({ name: 'home' }), at({ name: 'projects' }));
    present(() => {}, at({ name: 'projects' }), at({ name: 'sessions' }));
    f.skip(0);
    await flush();
    expect(present.skip()).toBe(true);
    expect(f.skips[1]).toHaveBeenCalledTimes(1);
  });
  it('包んだ中で、描画を flushSync で同期させる', () => {
    const order: string[] = [];
    const f = fake({ flushSync: (fn) => { order.push('flush'); fn(); order.push('flushed'); } });
    createPresent(f.env)(() => order.push('commit'), at({ name: 'home' }), at({ name: 'projects' }));
    f.run();
    expect(order).toEqual(['flush', 'commit', 'flushed']);
  });
  it('行が上段へ広がるとき、器と点と名前の 3 組を付け、出る側は描き替えの前に外し、終わったら入る側も外す', async () => {
    document.body.innerHTML = row('row');
    const f = fake({ pressed: () => $('#row-name') });
    // 出る側を残したまま入る側を足し、描き替えの前に出る側から外したことを確かめる。
    createPresent(f.env)(() => { document.body.insertAdjacentHTML('beforeend', hero()); }, at({ name: 'sessions' }), at({ name: 'session', id: 's1' }));
    expect(trio('row')).toEqual(MORPHS);
    f.run();
    expect(trio('row')).toEqual(NONE);
    expect(trio('hero')).toEqual(MORPHS);
    f.finish();
    await flush();
    expect(trio('hero')).toEqual(NONE);
  });
  it('Home の札から開くと、札の点と名前が上段の点と名前へ動く', () => {
    document.body.innerHTML = card('card');
    const f = fake({ pressed: () => $('#card') });
    createPresent(f.env)(() => { document.body.innerHTML = hero(); }, at({ name: 'home' }), at({ name: 'session', id: 's1' }));
    expect(trio('card')).toEqual(MORPHS);
    f.run();
    expect(trio('hero')).toEqual(MORPHS);
  });
  it('戻るときは上段の器と点と名前から行の 3 つへ縮み、拒否されても入る側の名前を外す', async () => {
    document.body.innerHTML = hero();
    const f = fake();
    createPresent(f.env)(() => { document.body.insertAdjacentHTML('beforeend', row('row')); }, at({ name: 'session', id: 's1' }), at({ name: 'home' }));
    expect(trio('hero')).toEqual(MORPHS);
    f.run();
    expect(trio('hero')).toEqual(NONE);
    expect(trio('row')).toEqual(MORPHS);
    f.skip();
    await flush();
    expect(trio('row')).toEqual(NONE);
  });
  it('最近の行から開いたセッションは、戻るときも実行中の札ではなく最近の行へ縮む', () => {
    const home = card('card') + row('row');
    document.body.innerHTML = home;
    const f = fake({ pressed: () => $('#row') });
    const present = createPresent(f.env);
    present(() => { document.body.innerHTML = hero(); }, at({ name: 'home' }), at({ name: 'session', id: 's1' }));
    f.run();
    present(() => { document.body.innerHTML = home; }, at({ name: 'session', id: 's1' }), at({ name: 'home' }));
    f.run();
    expect(trio('row')).toEqual(MORPHS);
    expect(trio('card')).toEqual(NONE);
  });
  it('札から開いたセッションは、戻るときも札へ縮む', () => {
    const home = row('row') + card('card');
    document.body.innerHTML = home;
    const f = fake({ pressed: () => $('#card-name') });
    const present = createPresent(f.env);
    present(() => { document.body.innerHTML = hero(); }, at({ name: 'home' }), at({ name: 'session', id: 's1' }));
    f.run();
    present(() => { document.body.innerHTML = home; }, at({ name: 'session', id: 's1' }), at({ name: 'home' }));
    f.run();
    expect(trio('card')).toEqual(MORPHS);
    expect(trio('row')).toEqual(NONE);
  });
  it('戻る先は見えている行に限る。好む種類が見えていなければ、見えている別の行へ縮む', () => {
    document.body.innerHTML = hero();
    const f = fake({ visible: (el) => el.id !== 'hidden' });
    createPresent(f.env)(() => { document.body.innerHTML = row('hidden') + row('shown'); }, at({ name: 'session', id: 's1' }), at({ name: 'sessions' }));
    f.run();
    expect(trio('hidden')).toEqual(NONE);
    expect(trio('shown')).toEqual(MORPHS);
  });
  it('見えている行が 1 つも無ければ、戻る先に名前を付けない', () => {
    document.body.innerHTML = hero();
    const f = fake({ visible: (el) => el.id === 'hero' });
    createPresent(f.env)(() => { document.body.innerHTML = row('row'); }, at({ name: 'session', id: 's1' }), at({ name: 'sessions' }));
    f.run();
    expect(trio('row')).toEqual(NONE);
  });
  it('見えていない行は、押されていても広げる元にしない', () => {
    document.body.innerHTML = row('row');
    const f = fake({ pressed: () => $('#row'), visible: () => false });
    createPresent(f.env)(() => { document.body.innerHTML = hero(); }, at({ name: 'sessions' }), at({ name: 'session', id: 's1' }));
    expect(trio('row')).toEqual(NONE);
    f.run();
    expect(trio('hero')).toEqual(NONE);
  });
  it('パレットから別のダイアログへ移るときは、錠剤へ戻る組を作らず、画面が替わらなければ包まない', () => {
    document.body.innerHTML = '<div class="dialog palette"></div><input id="global-search">';
    const f = fake();
    const commit = vi.fn(() => { $('.palette').remove(); });
    createPresent(f.env)(commit, at({ name: 'home' }, { kind: 'palette' }), at({ name: 'home' }, { kind: 'newSession', projectId: null, scratch: false }));
    expect(f.start).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(name('#global-search')).toBe('');
  });
  it('パレットから別のダイアログへ移りながら画面が替わるときは、包むが錠剤の組は作らない', () => {
    document.body.innerHTML = '<div class="dialog palette"></div><input id="global-search">';
    const f = fake();
    createPresent(f.env)(() => { $('.palette').remove(); }, at({ name: 'home' }, { kind: 'palette' }), at({ name: 'projects' }, { kind: 'newSession', projectId: null, scratch: false }));
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(name('.palette')).toBe('');
    f.run();
    expect(name('#global-search')).toBe('');
  });
  it('最初の update が走る前に 2 回続けて出しても、最後の状態に追いつき、名前は 1 つも残らない', async () => {
    document.body.innerHTML = row('row');
    const f = fake({ pressed: () => $('#row') });
    const present = createPresent(f.env);
    const shown: string[] = [];
    // 1 回目は一覧から開き、2 回目はその update が走る前に戻る（Enter の直後の ⌘[）。
    present(() => { shown.push('session'); document.body.innerHTML = hero(); }, at({ name: 'sessions' }), at({ name: 'session', id: 's1' }));
    present(() => { shown.push('sessions'); document.body.innerHTML = row('row'); }, at({ name: 'session', id: 's1' }), at({ name: 'sessions' }));
    expect(f.start).toHaveBeenCalledTimes(2);
    f.run();
    f.run();
    expect(shown).toEqual(['session', 'sessions']);
    // 本物では、2 回目が 1 回目を割り込んで捨てる。
    f.skip(0);
    f.finish(1);
    await flush();
    expect($('#row')).not.toBeNull();
    expect(document.querySelector('#hero')).toBeNull();
    for (const el of document.querySelectorAll<HTMLElement>('*')) expect(el.style.viewTransitionName || '').toBe('');
  });
});
