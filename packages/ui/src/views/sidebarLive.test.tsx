import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionDto } from '@agent-hangar/shared';
import { IntentRoot } from '../intent/chain.tsx';
import { cleanSidebarOrder, mergeSidebarOrder, SIDEBAR_ORDER_KEY, SIDEBAR_ORDER_MAX, trimSidebarOrder } from '../mediator/sidebar.ts';
import { initialState, transition } from '../mediator/transition.ts';
import { presentShell, SIDE_LIVE_MAX, type SideLiveProps, type SideLiveRow } from '../presenters/shell.ts';
import { initialStore, liveSessionIds, type Store } from '../store/store.ts';
import { moveId, nudgeId, Sidebar } from './Sidebar.tsx';

const NOW = 1_800_000_000_000;
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: `u-${id}`, projectId: null, name: `name-${id}`, cwd: '/w', firstPrompt: null, aiTitle: null, live: 'busy', lastActivityAt: NOW - 60_000, startedAt: NOW - 600_000, hasTranscript: true, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, cost: null }, ...over } as unknown as SessionDto);
const storeWith = (list: SessionDto[]): Store => ({ ...initialStore(), bootstrapped: true, sessions: Object.fromEntries(list.map((s) => [s.id, s])) });
const liveOf = (store: Store, state = initialState()) => presentShell(state, store, NOW).live;
const at = (name: 'home' | 'projects') => ({ ...initialState(), screen: { name } });

describe('サイドバーの「動いている」の並び（presentShell）', () => {
  const store = storeWith([session('a', { live: 'idle' }), session('b', { live: 'busy' }), session('c', { live: 'waiting', lastActivityAt: NOW - 240_000 }), session('z', { live: null })]);
  it('動いているセッションだけを並べる。入力待ちを上へ寄せない。終わったものは入れない', () => {
    const live = liveOf(store, at('projects'));
    expect(live.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(live.count).toBe(3);
    expect(live.rows[2]).toMatchObject({ live: 'waiting', waited: '待ち 4 分', current: false });
    expect(live.rows[1]).toMatchObject({ live: 'busy', waited: null });
  });
  it('置いていないセッションは、始めた時刻の古い順に並べる。時刻の無いものは後ろ、同じ時刻は id の順', () => {
    const s = storeWith([session('n', { startedAt: null }), session('y', { startedAt: NOW - 100 }), session('x', { startedAt: NOW - 100 }), session('o', { startedAt: NOW - 900 })]);
    expect(liveSessionIds(s)).toEqual(['o', 'x', 'y', 'n']);
    expect(liveOf(s, at('projects')).ids).toEqual(['o', 'x', 'y', 'n']);
  });
  it('状態や最後の活動が変わっても、並びは変わらない', () => {
    const before = liveOf(store, at('projects')).ids;
    const after = storeWith([session('a', { live: 'waiting', lastActivityAt: NOW }), session('b', { live: 'idle', lastActivityAt: NOW - 1 }), session('c', { live: 'busy', lastActivityAt: NOW - 999_000 }), session('z', { live: null })]);
    expect(liveOf(after, at('projects')).ids).toEqual(before);
  });
  it('利用者が置いた順を保ち、入力待ちになっても行を動かさない', () => {
    const live = liveOf(store, { ...at('projects'), sidebarOrder: ['c', 'a', 'b'] });
    expect(live.rows.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(live.ids).toEqual(['c', 'a', 'b']);
  });
  it('置いていないセッション（新しく動き始めたもの）は、置いた行の下に入る', () => {
    const live = liveOf(store, { ...at('projects'), sidebarOrder: ['b'] });
    expect(live.rows.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
  it('覚えた並びに、いま動いていないセッションが残っていても出さない', () => {
    expect(liveOf(store, { ...at('projects'), sidebarOrder: ['gone', 'b', 'z'] }).rows.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
  it('上限を超えて動いているときに新しく始めたものは「ほか N 件」に入り、見えている行は動かない', () => {
    const ids = Array.from({ length: SIDE_LIVE_MAX }, (_, i) => `s${i}`);
    const full = storeWith(ids.map((id) => session(id)));
    const more = storeWith([...ids.map((id) => session(id)), session('new', { live: 'waiting', startedAt: NOW })]);
    const st = { ...at('projects'), sidebarOrder: ids };
    expect(liveOf(more, st).rows.map((r) => r.id)).toEqual(liveOf(full, st).rows.map((r) => r.id));
    expect(liveOf(more, st).more).toBe(1);
    expect(liveOf(more, st).ids.at(-1)).toBe('new');
  });
  it('いま見ているセッションに印を付ける', () => {
    const live = liveOf(store, { ...initialState(), screen: { name: 'session', id: 'b' } });
    expect(live.rows.find((r) => r.id === 'b')?.current).toBe(true);
    expect(live.folded).toBe(false);
  });
  it('ホームでは見出しと件数だけにする（本文の要対応と実行中が同じ件を出している）', () => {
    expect(liveOf(store, at('home')).folded).toBe(true);
    expect(liveOf(store, at('projects')).folded).toBe(false);
  });
  it('並べるのは上限までで、超えた分は数だけ返す。並べ替えの計算には全部の並びを渡す', () => {
    const many = storeWith(Array.from({ length: SIDE_LIVE_MAX + 3 }, (_, i) => session(`s${i}`, { lastActivityAt: NOW - i * 1000 })));
    const live = liveOf(many, at('projects'));
    expect(live.rows).toHaveLength(SIDE_LIVE_MAX);
    expect(live.more).toBe(3);
    expect(live.ids).toHaveLength(SIDE_LIVE_MAX + 3);
  });
});

describe('並びを覚える（sidebar.order）', () => {
  it('並びを状態に入れ、localStorage に残す', () => {
    const r = transition(initialState(), { kind: 'intent', intent: { type: 'sidebar.order', ids: ['b', 'a', 'b'] } });
    expect(r.state.sidebarOrder).toEqual(['b', 'a']);
    expect(r.effects).toContainEqual({ kind: 'storage.save', key: SIDEBAR_ORDER_KEY, value: ['b', 'a'] });
  });
  it('壊れた保存値は空の並びに戻す', () => {
    expect(cleanSidebarOrder('x')).toEqual([]);
    expect(cleanSidebarOrder(null)).toEqual([]);
    expect(cleanSidebarOrder(['a', 1, '', 'a', 'b'])).toEqual(['a', 'b']);
  });
  const appeared = (order: string[], ids: string[]) => transition({ ...initialState(), sidebarOrder: order }, { kind: 'runtime', event: { type: 'live.changed', ids } });
  it('初めて現れたセッションを、届いた順で並びの末尾に書き足し、保存する', () => {
    const r = appeared(['a'], ['c', 'a', 'b']);
    expect(r.state.sidebarOrder).toEqual(['a', 'c', 'b']);
    expect(r.effects).toContainEqual({ kind: 'storage.save', key: SIDEBAR_ORDER_KEY, value: ['a', 'c', 'b'] });
  });
  it('保存が空の端末でも、現れた順で 1 回だけ確定する', () => {
    const first = appeared([], ['a', 'b', 'c']);
    expect(first.state.sidebarOrder).toEqual(['a', 'b', 'c']);
    const again = transition(first.state, { kind: 'runtime', event: { type: 'live.changed', ids: ['c', 'b', 'a'] } });
    expect(again.state.sidebarOrder).toEqual(['a', 'b', 'c']);
    expect(again.effects).toEqual([]);
  });
  it('動いているものが減っても、ゼロになっても、覚えた並びは変えず、保存もしない', () => {
    for (const ids of [['a'], []]) {
      const r = appeared(['a', 'b', 'c'], ids);
      expect(r.state.sidebarOrder).toEqual(['a', 'b', 'c']);
      expect(r.effects).toEqual([]);
    }
  });
  it('抜けていたセッションがまた現れても、覚えた席のまま動かさない', () => {
    const r = appeared(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(r.state.sidebarOrder).toEqual(['a', 'b', 'c']);
    expect(r.effects).toEqual([]);
  });
  it('並べ替えは動いている行の席だけを入れ替え、抜けているセッションの席を残す', () => {
    expect(mergeSidebarOrder(['a', 'x', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'x', 'a', 'b']);
    const r = transition({ ...initialState(), sidebarOrder: ['a', 'x', 'b', 'c'] }, { kind: 'intent', intent: { type: 'sidebar.order', ids: ['a', 'c', 'b'] } });
    expect(r.state.sidebarOrder).toEqual(['a', 'x', 'c', 'b']);
    expect(r.effects).toContainEqual({ kind: 'storage.save', key: SIDEBAR_ORDER_KEY, value: ['a', 'x', 'c', 'b'] });
  });
  it('並べ替えに、まだ覚えていない id が混じっていたら末尾に足す', () => {
    expect(mergeSidebarOrder(['a', 'b'], ['n', 'b', 'a'])).toEqual(['b', 'a', 'n']);
    expect(mergeSidebarOrder([], ['b', 'a'])).toEqual(['b', 'a']);
  });
  it('覚える id は上限までにし、動いていないものを先頭の側から落とす。動いているものは落とさない', () => {
    const old = Array.from({ length: SIDEBAR_ORDER_MAX }, (_, i) => `o${i}`);
    expect(trimSidebarOrder(old, [])).toBe(old);
    const trimmed = trimSidebarOrder(['live1', ...old, 'live2'], ['live1', 'live2']);
    expect(trimmed).toHaveLength(SIDEBAR_ORDER_MAX);
    expect(trimmed).toEqual(['live1', ...old.slice(2), 'live2']);
    const allLive = Array.from({ length: SIDEBAR_ORDER_MAX + 5 }, (_, i) => `l${i}`);
    expect(trimSidebarOrder(allLive, allLive)).toEqual(allLive);
    const r = appeared(old, ['o0', 'new']);
    expect(r.state.sidebarOrder).toEqual(['o0', ...old.slice(2), 'new']);
  });
});

describe('行の移し方', () => {
  it('掴んだ行を、落とした行の前か後ろへ入れる', () => {
    expect(moveId(['a', 'b', 'c'], 'c', 'a', true)).toEqual(['c', 'a', 'b']);
    expect(moveId(['a', 'b', 'c'], 'a', 'c', false)).toEqual(['b', 'c', 'a']);
    expect(moveId(['a', 'b', 'c'], 'a', 'b', false)).toEqual(['b', 'a', 'c']);
  });
  it('自分の上や、知らない行へは動かさない', () => {
    const ids = ['a', 'b'];
    expect(moveId(ids, 'a', 'a', true)).toBe(ids);
    expect(moveId(ids, 'x', 'a', true)).toBe(ids);
    expect(moveId(ids, 'a', 'x', true)).toBe(ids);
  });
  it('1 つ上か下へずらす。端ではそのまま', () => {
    expect(nudgeId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(nudgeId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    const ids = ['a', 'b'];
    expect(nudgeId(ids, 'a', -1)).toBe(ids);
    expect(nudgeId(ids, 'b', 1)).toBe(ids);
  });
});

const row = (id: string, over: Partial<SideLiveRow> = {}): SideLiveRow => ({ id, name: `name-${id}`, live: 'busy', waited: null, current: false, ...over });
const liveProps = (over: Partial<SideLiveProps> = {}): SideLiveProps => ({ count: 3, ids: ['a', 'b', 'c'], rows: [row('a'), row('b', { live: 'waiting', waited: '待ち 4 分' }), row('c', { current: true })], more: 0, folded: false, ...over });
const mount = (live: SideLiveProps, onIntent = vi.fn()) => ({ ...render(<IntentRoot onIntent={onIntent}><Sidebar nav={[]} collapsed={false} live={live} /></IntentRoot>), onIntent });

// jsdom はドラッグのイベントにポインタの位置を載せないので、作ったイベントに clientY を足してから送る。
const dragAt = (kind: 'dragOver' | 'drop', el: HTMLElement, clientY: number) => {
  const ev = createEvent[kind](el);
  Object.defineProperty(ev, 'clientY', { value: clientY });
  fireEvent(el, ev);
};

describe('サイドバーの「動いている」の節（Sidebar）', () => {
  it('見出しに件数を出し、行を押すとそのセッションを開く', () => {
    const { onIntent } = mount(liveProps());
    expect(screen.getByRole('heading', { name: /動いている/ })).toHaveTextContent('3');
    fireEvent.click(screen.getByRole('link', { name: /name-a/ }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 'a' });
  });
  it('入力待ちの行には待った時間を添え、いま見ている行には印を付ける', () => {
    mount(liveProps());
    expect(screen.getByRole('link', { name: /name-b/ })).toHaveTextContent('待ち 4 分');
    expect(screen.getByRole('link', { name: /name-c/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /name-a/ })).not.toHaveAttribute('aria-current');
  });
  it('動いているものが無ければ、節ごと出さない', () => {
    mount(liveProps({ count: 0, ids: [], rows: [] }));
    expect(screen.queryByRole('heading', { name: /動いている/ })).toBeNull();
  });
  it('ホームでは見出しと件数だけを出し、行は出さない', () => {
    mount(liveProps({ folded: true }));
    expect(screen.getByRole('heading', { name: /動いている/ })).toHaveTextContent('3');
    expect(screen.queryByRole('link', { name: /name-a/ })).toBeNull();
  });
  it('並べきれない分は「ほか N 件」にして、押すとホームへ行く', () => {
    const { onIntent } = mount(liveProps({ count: 11, more: 8 }));
    fireEvent.click(screen.getByText('ほか 8 件'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'home' } });
  });
  it('行を掴んで別の行の上半分に落とすと、その前へ入る並びを出す', () => {
    const { onIntent } = mount(liveProps());
    const c = screen.getByRole('link', { name: /name-c/ });
    const a = screen.getByRole('link', { name: /name-a/ });
    a.getBoundingClientRect = () => ({ top: 100, height: 30, bottom: 130, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) });
    const dataTransfer = { effectAllowed: '', setData: vi.fn() };
    fireEvent.dragStart(c, { dataTransfer });
    dragAt('dragOver', a, 104);
    expect(a).toHaveAttribute('data-over', 'before');
    dragAt('drop', a, 104);
    expect(onIntent).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['c', 'a', 'b'] });
  });
  it('下半分に落とすと、その後ろへ入る', () => {
    const { onIntent } = mount(liveProps());
    const a = screen.getByRole('link', { name: /name-a/ });
    const b = screen.getByRole('link', { name: /name-b/ });
    b.getBoundingClientRect = () => ({ top: 130, height: 30, bottom: 160, left: 0, right: 200, width: 200, x: 0, y: 130, toJSON: () => ({}) });
    const dataTransfer = { effectAllowed: '', setData: vi.fn() };
    fireEvent.dragStart(a, { dataTransfer });
    dragAt('dragOver', b, 155);
    expect(b).toHaveAttribute('data-over', 'after');
    dragAt('drop', b, 155);
    expect(onIntent).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['b', 'a', 'c'] });
  });
  it('キーボードでは ⌥↑ と ⌥↓ で 1 つずつ動かす。⌥ が無ければ動かさない', () => {
    const { onIntent } = mount(liveProps());
    const b = screen.getByRole('link', { name: /name-b/ });
    fireEvent.keyDown(b, { key: 'ArrowUp', altKey: true });
    expect(onIntent).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['b', 'a', 'c'] });
    fireEvent.keyDown(b, { key: 'ArrowDown', altKey: true });
    expect(onIntent).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['a', 'c', 'b'] });
    onIntent.mockClear();
    fireEvent.keyDown(b, { key: 'ArrowUp' });
    expect(onIntent).not.toHaveBeenCalled();
  });
});

describe('サイドバーの「動いている」の見た目', () => {
  const base = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../styles/base.css'), 'utf8');
  it('入る場所は行の上か下の線で示す', () => {
    expect(base).toMatch(/\.side-live-row\[data-over='before'\] \{[^}]*box-shadow: inset 0 2px 0 var\(--accent\)/);
    expect(base).toMatch(/\.side-live-row\[data-over='after'\] \{[^}]*box-shadow: inset 0 -2px 0 var\(--accent\)/);
  });
  it('畳んだ帯では見出しと名前を出さず、点だけを並べる', () => {
    expect(base).toMatch(/\[data-sidebar='collapsed'\] \.side-live-h, [^{]*\.side-live-name, [^{]*\{ display: none; \}/);
  });
});
