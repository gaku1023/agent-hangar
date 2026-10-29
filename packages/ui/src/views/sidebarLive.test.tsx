import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup as cleanupAll, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { cleanSidebarFolded, cleanSidebarOrder, mergeSidebarOrder, SIDEBAR_FOLDED_KEY, SIDEBAR_ORDER_KEY, SIDEBAR_ORDER_MAX, trimSidebarOrder } from '../mediator/sidebar.ts';
import { initialState, transition } from '../mediator/transition.ts';
import { presentShell, type SideLiveGroup, type SideLiveProps, type SideLiveRow } from '../presenters/shell.ts';
import type { SessionMenuProps } from '../presenters/sessionMenu.ts';
import { initialStore, liveSessionIds, type Store } from '../store/store.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { moveId, nudgeId, Sidebar } from './Sidebar.tsx';
// 前の版が DB に付けた名前（旧称）。表示がこれを出さないことを見るための見本で、文字コードで書く（noScratchWord.test.ts）。
const LEGACY = '\u30b9\u30af\u30e9\u30c3\u30c1';


const NOW = 1_800_000_000_000;
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: `u-${id}`, projectId: null, name: `name-${id}`, cwd: '/w', firstPrompt: null, aiTitle: null, live: 'busy', lastActivityAt: NOW - 60_000, startedAt: NOW - 600_000, hasTranscript: true, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, cost: null }, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, ...over } as unknown as SessionDto);
const storeWith = (list: SessionDto[]): Store => ({ ...initialStore(), bootstrapped: true, sessions: Object.fromEntries(list.map((s) => [s.id, s])) });
const liveOf = (store: Store, state = initialState()) => presentShell(state, store, NOW).live;
const at = (name: 'home' | 'projects') => ({ ...initialState(), screen: { name } });

describe('サイドバーの「動いている」の並び（presentShell）', () => {
  const store = storeWith([session('a', { live: 'idle' }), session('b', { live: 'busy' }), session('c', { live: 'waiting', lastActivityAt: NOW - 240_000 }), session('z', { live: null })]);
  it('動いているセッションだけを並べる。入力待ちを上へ寄せない。終わったものは入れない', () => {
    const live = liveOf(store, at('projects'));
    expect(live.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(live.count).toBe(3);
    expect(live.rows[2]).toMatchObject({ live: 'waiting', waited: '入力待ち 4 分', current: false });
    expect(live.rows[1]).toMatchObject({ live: 'busy', waited: null });
  });
  it('許可待ちと使用制限は印と右端の語を替える（許可待ち N 分、リセットの時刻、リセット済み）。行の位置は変えない', () => {
    const resetsAt = new Date(NOW).setHours(new Date(NOW).getHours() + 1, 50, 0, 0);
    const s = storeWith([
      session('p', { live: 'waiting', waitingFor: 'permission', lastActivityAt: NOW - 60_000 }),
      session('l', { live: 'idle', limit: { kind: 'five_hour', resetsAt, auto: true, reset: false } }),
      session('r', { live: 'idle', limit: { kind: 'five_hour', resetsAt: NOW - 200_000, auto: false, reset: true } }),
    ]);
    const rows = liveOf(s, at('projects')).rows;
    const hm = (t: number) => `${String(new Date(t).getHours()).padStart(2, '0')}:${String(new Date(t).getMinutes()).padStart(2, '0')}`;
    expect(rows.map((r) => [r.id, r.reason, r.waited])).toEqual([['l', 'limit', hm(resetsAt)], ['p', 'permission', '許可待ち 1 分'], ['r', 'reset', 'リセット済み']]);
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
  it('いま見ているセッションに印を付ける', () => {
    const live = liveOf(store, { ...initialState(), screen: { name: 'session', id: 'b' } });
    expect(live.rows.find((r) => r.id === 'b')?.current).toBe(true);
  });
  it('ホームでも、ほかの画面と同じ行を同じ並びで出す', () => {
    const st = { sidebarOrder: ['c', 'a', 'b'] };
    expect(liveOf(store, { ...at('home'), ...st })).toEqual(liveOf(store, { ...at('projects'), ...st }));
    render(<ActionRoot onAction={vi.fn()}><Sidebar nav={[]} foot={[]} collapsed={false} live={liveOf(store, { ...at('home'), ...st })} /></ActionRoot>);
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([expect.stringContaining('name-c'), expect.stringContaining('name-a'), expect.stringContaining('name-b')]);
  });
  it('上限を設けず、動いているものを全部並べる（入りきらない分は節の中でスクロールする）', () => {
    const many = storeWith(Array.from({ length: 30 }, (_, i) => session(`s${i}`, { lastActivityAt: NOW - i * 1000 })));
    const live = liveOf(many, at('projects'));
    expect(live.rows).toHaveLength(30);
    expect(live).not.toHaveProperty('more');
  });
});

describe('サイドバーの「実行中」をプロジェクトごとに分ける（presentShell）', () => {
  const project = (id: string, name: string) => ({ id, name }) as unknown as Store['projects'][string];
  const grouped = (state = at('projects')) => {
    const s = { ...storeWith([
      session('a', { projectId: 'p1' }), session('b', { projectId: 'p2' }), session('c', { projectId: null, live: 'waiting' }),
      session('d', { projectId: 'p1', live: 'waiting', waitingFor: 'permission' }), session('e', { projectId: 'p2' }),
    ]), projects: { p1: project('p1', 'web'), p2: project('p2', 'docs') } };
    return liveOf(s, { ...state, sidebarOrder: ['b', 'a', 'c', 'd', 'e'] });
  };
  it('プロジェクトごとに見出しを分け、グループの順は並びで先に出てくる順、グループの中は並びの順にする。プロジェクトの無いものは「未分類」', () => {
    const live = grouped();
    expect(live.groups.map((g) => [g.key, g.name, g.rows.map((r) => r.id)])).toEqual([['p2', 'docs', ['b', 'e']], ['p1', 'web', ['a', 'd']], ['', '未分類', ['c']]]);
    // 並べ替えの計算に渡す並びは、見えている順（グループをつないだ順）にする。
    expect(live.ids).toEqual(['b', 'e', 'a', 'd', 'c']);
    expect(live.rows.map((r) => r.id)).toEqual(['b', 'e', 'a', 'd', 'c']);
    expect(live.count).toBe(5);
  });
  it('グループは開いた形で出し、畳んだグループ（sidebarFolded）だけを閉じる。待っている行の数を持つ', () => {
    const live = grouped({ ...at('projects'), sidebarFolded: ['p1'] });
    expect(live.groups.map((g) => [g.key, g.open, g.waiting])).toEqual([['p2', true, 0], ['p1', false, 1], ['', true, 1]]);
  });
  it('名前の無い（消えた）プロジェクトは id のまま出さず、未分類と同じ名前にしない', () => {
    const s = storeWith([session('a', { projectId: 'gone' })]);
    const g = liveOf(s, at('projects')).groups[0]!;
    expect(g.key).toBe('gone');
    expect(g.name).toBe('（名前なし）');
  });
  it('クイックセッションのまとまりは、DB の名前（前の版の旧称など）ではなく辞書の名前で出す', () => {
    const quick = { id: 'q', name: LEGACY, isScratch: true } as unknown as Store['projects'][string];
    const s = { ...storeWith([session('a', { projectId: 'q' })]), projects: { q: quick } };
    expect(liveOf(s, at('projects')).groups[0]!.name).toBe('クイックセッション');
  });
});

describe('グループを畳む（sidebar.fold）', () => {
  it('畳んだグループを状態に入れて localStorage に残し、開くと外す。同じ形なら何もしない', () => {
    const fold = (state: ReturnType<typeof initialState>, key: string, open: boolean) => transition(state, initialStore(), { kind: 'action', action: { type: 'sidebar.fold', key, open } });
    const a = fold(initialState(), 'p1', false);
    expect(a.state.sidebarFolded).toEqual(['p1']);
    expect(a.effects).toContainEqual({ kind: 'storage.save', key: SIDEBAR_FOLDED_KEY, value: ['p1'] });
    const b = fold(a.state, '', false);
    expect(b.state.sidebarFolded).toEqual(['p1', '']);
    expect(fold(b.state, 'p1', false).effects).toEqual([]);
    expect(fold(b.state, 'p1', true).state.sidebarFolded).toEqual(['']);
  });
  it('壊れた保存値は空にし、文字列でない要素と重なりを落とす。未分類（空の文字列）は残す', () => {
    expect(cleanSidebarFolded({})).toEqual([]);
    expect(cleanSidebarFolded(['p1', 1, 'p1', ''])).toEqual(['p1', '']);
  });
});

describe('並びを覚える（sidebar.order）', () => {
  it('並びを状態に入れ、localStorage に残す', () => {
    const r = transition(initialState(), initialStore(), { kind: 'action', action: { type: 'sidebar.order', ids: ['b', 'a', 'b'] } });
    expect(r.state.sidebarOrder).toEqual(['b', 'a']);
    expect(r.effects).toContainEqual({ kind: 'storage.save', key: SIDEBAR_ORDER_KEY, value: ['b', 'a'] });
  });
  it('壊れた保存値は空の並びに戻す', () => {
    expect(cleanSidebarOrder('x')).toEqual([]);
    expect(cleanSidebarOrder(null)).toEqual([]);
    expect(cleanSidebarOrder(['a', 1, '', 'a', 'b'])).toEqual(['a', 'b']);
  });
  // 動いているセッションが、この順（始めた順）でストアにある。
  const liveStore = (ids: string[]) => storeWith(ids.map((id, n) => session(id, { startedAt: NOW + n })));
  // ストアが変わったと Mediator に届いた。
  const appeared = (order: string[], ids: string[]) => transition({ ...initialState(), sidebarOrder: order }, liveStore(ids), { kind: 'store' });
  it('初めて現れたセッションを、届いた順で並びの末尾に書き足し、保存する', () => {
    const r = appeared(['a'], ['c', 'a', 'b']);
    expect(r.state.sidebarOrder).toEqual(['a', 'c', 'b']);
    expect(r.effects).toContainEqual({ kind: 'storage.save', key: SIDEBAR_ORDER_KEY, value: ['a', 'c', 'b'] });
  });
  it('保存が空の端末でも、現れた順で 1 回だけ確定する', () => {
    const first = appeared([], ['a', 'b', 'c']);
    expect(first.state.sidebarOrder).toEqual(['a', 'b', 'c']);
    const again = transition(first.state, liveStore(['c', 'b', 'a']), { kind: 'store' });
    expect(again.state.sidebarOrder).toEqual(['a', 'b', 'c']);
    expect(again.effects).toEqual([]);
  });
  it('顔ぶれが同じなら、ストアが何度変わっても状態を変えず、保存もしない', () => {
    const first = appeared([], ['a', 'b']);
    const again = transition(first.state, liveStore(['a', 'b']), { kind: 'store' });
    expect(again.state).toBe(first.state);
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
    const r = transition({ ...initialState(), sidebarOrder: ['a', 'x', 'b', 'c'] }, initialStore(), { kind: 'action', action: { type: 'sidebar.order', ids: ['a', 'c', 'b'] } });
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

const menuOf = (id: string, stop: SessionMenuProps['stop'] = { runId: `r-${id}`, working: true, aside: false, shellTabs: 0 }): SessionMenuProps => ({ id, name: `name-${id}`, status: null, resumeHere: null, stop, moveBlocked: null });
const row = (id: string, over: Partial<SideLiveRow> = {}): SideLiveRow => ({ id, name: `name-${id}`, live: 'busy', aside: false, reason: null, waited: null, current: false, menu: menuOf(id), ...over });
// 行を 1 つのグループ（web）にまとめた形。groups を渡せば、それで分ける。
const group = (key: string, rows: SideLiveRow[], over: Partial<SideLiveGroup> = {}): SideLiveGroup => ({ key, name: key === '' ? '未分類' : key, open: true, waiting: rows.filter((r) => r.live === 'waiting').length, rows, ...over });
const shaped = (rows: SideLiveRow[], groups: SideLiveGroup[] = [group('web', rows)]): SideLiveProps => ({ count: rows.length, ids: groups.flatMap((g) => g.rows.map((r) => r.id)), rows: groups.flatMap((g) => g.rows), groups });
const liveProps = (over: Partial<SideLiveProps> = {}): SideLiveProps => ({ ...shaped([row('a'), row('b', { live: 'waiting', waited: '入力待ち 4 分' }), row('c', { current: true })]), ...over });
const mount = (live: SideLiveProps, onAction = vi.fn()) => ({ ...render(<ActionRoot onAction={onAction}><Sidebar nav={[]} foot={[]} collapsed={false} live={live} /></ActionRoot>), onAction });
// 並べ替えの途中で一覧が変わったことにする。行は ids の順に並べ、並びの計算にも同じ ids を渡す。
const liveOfIds = (ids: string[]): SideLiveProps => shaped(ids.map((id) => row(id)));
const remount = (m: ReturnType<typeof mount>, ids: string[]) => m.rerender(<ActionRoot onAction={m.onAction}><Sidebar nav={[]} foot={[]} collapsed={false} live={liveOfIds(ids)} /></ActionRoot>);
const linkOf = (id: string) => screen.getByRole('link', { name: new RegExp(`name-${id}`) });

// 行の縦の位置。a・b・c を h（既定 30px、畳んだ帯は 26px）ずつ上から並べる。jsdom は配置を測らないので、ここで与える。
const placeRows = (h = 30, ids = ['a', 'b', 'c']) => {
  ids.forEach((id, i) => {
    const top = 100 + i * h;
    screen.getByRole('link', { name: new RegExp(`name-${id}`) }).getBoundingClientRect = () => ({ top, height: h, bottom: top + h, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) });
  });
};
// jsdom はポインタのイベントに位置やボタンを載せないことがあるので、作ったイベントに足してから送る。
type PointerKind = 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel';
const pointerAt = (kind: PointerKind, el: HTMLElement, clientY: number, over: { button?: number; ctrlKey?: boolean; clientX?: number } = {}) => {
  const ev = createEvent[kind](el);
  for (const [k, v] of Object.entries({ clientX: over.clientX ?? 20, clientY, pointerId: 1, button: over.button ?? 0, ctrlKey: over.ctrlKey ?? false, isPrimary: true })) Object.defineProperty(ev, k, { value: v });
  fireEvent(el, ev);
};

describe('サイドバーの「実行中」の節（Sidebar）', () => {
  it('バックグラウンドだけ動いている行は、丸だけを薄いオレンジにし、名前の横に語を添えない', () => {
    const { container } = mount(shaped([row('a', { aside: true })]));
    const link = screen.getByRole('link', { name: /name-a/ });
    expect(link).toHaveTextContent(/^name-a$/);
    expect(container.querySelector('.dot')).toHaveAttribute('data-aside', 'true');
  });
  it('行を押すとそのセッションを開く', () => {
    const { onAction } = mount(liveProps());
    fireEvent.click(screen.getByRole('link', { name: /name-a/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 'a' });
  });
  it('入力待ちの行には待った時間を添え、いま見ている行には印を付ける', () => {
    mount(liveProps());
    expect(screen.getByRole('link', { name: /name-b/ })).toHaveTextContent('入力待ち 4 分');
    expect(screen.getByRole('link', { name: /name-c/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /name-a/ })).not.toHaveAttribute('aria-current');
  });
  it('見出し（実行中と件数）は出さず、読み上げの名前は「実行中のセッション」にする。グループの見出しから始める', () => {
    const { container } = mount(liveProps());
    expect(screen.getByRole('region', { name: '実行中のセッション' })).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(container.querySelector('.side-live-h, .side-live-n')).toBeNull();
  });
  it('動いているものが無ければ、節ごと出さない', () => {
    mount(shaped([], []));
    expect(screen.queryByRole('region', { name: '実行中のセッション' })).toBeNull();
  });
  it('「ほか N 件」は出さず、行は全部並べる', () => {
    mount(shaped(Array.from({ length: 20 }, (_, i) => row(`s${i}`))));
    expect(screen.queryByText(/ほか/)).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(20);
  });
  it('行を掴んで動かすと、その行が浮いてポインタに付き、ほかの行は入る場所に合わせて行の高さ分ずつよける', () => {
    mount(liveProps());
    placeRows();
    const [a, b, c] = ['a', 'b', 'c'].map((id) => screen.getByRole('link', { name: new RegExp(`name-${id}`) })) as [HTMLElement, HTMLElement, HTMLElement];
    pointerAt('pointerDown', c, 175);
    pointerAt('pointerMove', c, 145);
    expect(c).toHaveAttribute('data-lift', 'held');
    expect(c.closest('ul')).toHaveAttribute('data-sorting', 'true');
    expect(c.style.translate).toMatch(/-30px$/);
    // c は b の席へ入るので、b だけが 1 行下がる。
    expect(b.style.translate).toMatch(/ 30px$/);
    expect(a.style.translate).toBe('');
    pointerAt('pointerMove', c, 104);
    expect(c.style.translate).toMatch(/-68px$/);
    expect(a.style.translate).toMatch(/ 30px$/);
    expect(b.style.translate).toMatch(/ 30px$/);
    // 入る場所の線は出さない。
    expect(document.querySelector('[data-over]')).toBeNull();
  });
  it('浮いた行は、両端では行 1 つ分の手前より先（8px）で止まる', () => {
    mount(liveProps());
    placeRows();
    const a = screen.getByRole('link', { name: /name-a/ });
    pointerAt('pointerDown', a, 115);
    pointerAt('pointerMove', a, 400);
    expect(a.style.translate).toMatch(/ 68px$/);
    pointerAt('pointerMove', a, -200);
    expect(a.style.translate).toMatch(/-8px$/);
  });
  it('離すと空いた場所へ収まってから並びを確定し、確定と同時に浮きとずらしを外す。離したあとの click では行を開かない', () => {
    const restore = fakeMotionTokens();
    vi.useFakeTimers();
    try {
      const { onAction } = mount(liveProps());
      placeRows();
      const [a, b, c] = ['a', 'b', 'c'].map((id) => screen.getByRole('link', { name: new RegExp(`name-${id}`) })) as [HTMLElement, HTMLElement, HTMLElement];
      pointerAt('pointerDown', c, 175);
      pointerAt('pointerMove', c, 104);
      pointerAt('pointerUp', c, 104);
      // 離したあとの click（ブラウザは離した直後に送る）では、行を開かない。
      fireEvent.click(c);
      // 収まる間は、空いた席（2 行上）へ向かい、浮きの印は収まりへ替わる。並びはまだ出さない。
      expect(c).toHaveAttribute('data-lift', 'settle');
      expect(c.style.translate).toMatch(/-60px$/);
      expect(a.style.translate).toMatch(/ 30px$/);
      expect(onAction).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(200); });
      expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['c', 'a', 'b'] });
      for (const el of [a, b, c]) { expect(el.style.translate).toBe(''); expect(el).not.toHaveAttribute('data-lift'); }
      expect(c.closest('ul')).not.toHaveAttribute('data-sorting');
      expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
    } finally { vi.useRealTimers(); restore(); }
  });
  it('下へ動かして離すと、その後ろへ入る', () => {
    const { onAction } = mount(liveProps());
    placeRows();
    const a = screen.getByRole('link', { name: /name-a/ });
    pointerAt('pointerDown', a, 115);
    pointerAt('pointerMove', a, 155);
    pointerAt('pointerUp', a, 155);
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['b', 'a', 'c'] });
  });
  it('行の外まで動かして離しても、端の席に収まる', () => {
    const { onAction } = mount(liveProps());
    placeRows();
    const a = screen.getByRole('link', { name: /name-a/ });
    pointerAt('pointerDown', a, 115);
    pointerAt('pointerMove', a, 300);
    pointerAt('pointerUp', a, 300);
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['b', 'c', 'a'] });
  });
  it('押しただけ、または少しだけ動いて離したときは、並べ替えずに行を開く', () => {
    const { onAction } = mount(liveProps());
    placeRows();
    const a = screen.getByRole('link', { name: /name-a/ });
    pointerAt('pointerDown', a, 115);
    pointerAt('pointerMove', a, 117);
    expect(a).not.toHaveAttribute('data-lift');
    pointerAt('pointerUp', a, 117);
    fireEvent.click(a);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 'a' });
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sidebar.order' }));
  });
  it('元の席のまま離したときは並びを出さない。そのあとの click でも行を開かない', () => {
    const { onAction } = mount(liveProps());
    placeRows();
    const a = screen.getByRole('link', { name: /name-a/ });
    pointerAt('pointerDown', a, 115);
    pointerAt('pointerMove', a, 126);
    expect(a).toHaveAttribute('data-lift', 'held');
    pointerAt('pointerUp', a, 126);
    expect(a).not.toHaveAttribute('data-lift');
    fireEvent.click(a);
    expect(onAction).not.toHaveBeenCalled();
  });
  it('ドラッグが取り消されたら（pointercancel）、元の席へ同じ動きで戻り、並びを出さない', () => {
    const restore = fakeMotionTokens();
    vi.useFakeTimers();
    try {
      const { onAction } = mount(liveProps());
      placeRows();
      const c = screen.getByRole('link', { name: /name-c/ });
      const a = screen.getByRole('link', { name: /name-a/ });
      pointerAt('pointerDown', c, 175);
      pointerAt('pointerMove', c, 104);
      pointerAt('pointerCancel', c, 104);
      expect(c).toHaveAttribute('data-lift', 'settle');
      expect(c.style.translate).toMatch(/^0(px)? 0px$/);
      expect(a.style.translate).toBe('');
      act(() => { vi.advanceTimersByTime(200); });
      expect(c).not.toHaveAttribute('data-lift');
      expect(c.style.translate).toBe('');
      expect(onAction).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); restore(); }
  });
  it('右ボタンや control を押しながらの押し下げでは、ドラッグを始めない', () => {
    const { onAction } = mount(liveProps());
    placeRows();
    const c = screen.getByRole('link', { name: /name-c/ });
    pointerAt('pointerDown', c, 175, { button: 2 });
    pointerAt('pointerMove', c, 104);
    expect(c).not.toHaveAttribute('data-lift');
    pointerAt('pointerUp', c, 104);
    pointerAt('pointerDown', c, 175, { ctrlKey: true });
    pointerAt('pointerMove', c, 104);
    expect(c).not.toHaveAttribute('data-lift');
    pointerAt('pointerUp', c, 104);
    expect(onAction).not.toHaveBeenCalled();
  });
  it('ドラッグの途中で Esc を押すと、元の席へ戻り、並びを出さない。離したあとの click でも行を開かない', () => {
    const restore = fakeMotionTokens();
    vi.useFakeTimers();
    try {
      const { onAction } = mount(liveProps());
      placeRows();
      const c = screen.getByRole('link', { name: /name-c/ });
      const a = screen.getByRole('link', { name: /name-a/ });
      pointerAt('pointerDown', c, 175);
      pointerAt('pointerMove', c, 104);
      // WebKit はリンクを押しても焦点を移さないので、Esc は行ではなく窓で受ける。
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(c).toHaveAttribute('data-lift', 'settle');
      expect(c.style.translate).toMatch(/^0(px)? 0px$/);
      expect(a.style.translate).toBe('');
      // 戻る途中のポインタの動きでは、また掴まない。
      pointerAt('pointerMove', c, 150);
      expect(c).toHaveAttribute('data-lift', 'settle');
      act(() => { vi.advanceTimersByTime(200); });
      expect(c).not.toHaveAttribute('data-lift');
      pointerAt('pointerUp', c, 104);
      fireEvent.click(c);
      expect(onAction).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); restore(); }
  });
  it('reduced motion（長さが 0）では待たずに、離したその場で並びを確定して浮きを外す', () => {
    const restore = fakeMotionTokens({ '--dur-fast': '0ms', '--ease-out': 'ease-out' });
    try {
      const { onAction } = mount(liveProps());
      placeRows();
      const c = screen.getByRole('link', { name: /name-c/ });
      pointerAt('pointerDown', c, 175);
      pointerAt('pointerMove', c, 104);
      pointerAt('pointerUp', c, 104);
      expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['c', 'a', 'b'] });
      expect(c).not.toHaveAttribute('data-lift');
      expect(c.style.translate).toBe('');
    } finally { restore(); }
  });
  it('畳んだ帯（26px の行）でも、行の間隔を測って同じに動く', () => {
    const { onAction } = mount(liveProps());
    placeRows(26);
    const [a, , c] = ['a', 'b', 'c'].map((id) => screen.getByRole('link', { name: new RegExp(`name-${id}`) })) as [HTMLElement, HTMLElement, HTMLElement];
    pointerAt('pointerDown', c, 165);
    pointerAt('pointerMove', c, 90);
    expect(c.style.translate).toMatch(/-60px$/);
    expect(a.style.translate).toMatch(/ 26px$/);
    pointerAt('pointerUp', c, 90);
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['c', 'a', 'b'] });
  });
  it('行は HTML のドラッグを使わない（デスクトップのアプリでは窓の中の dragover と drop が届かないため）', () => {
    mount(liveProps());
    for (const link of screen.getAllByRole('link')) expect(link).toHaveAttribute('draggable', 'false');
  });
  it('キーボードでは ⌥↑ と ⌥↓ で 1 つずつ動かす。⌥ が無ければ動かさない', () => {
    const { onAction } = mount(liveProps());
    const b = screen.getByRole('link', { name: /name-b/ });
    fireEvent.keyDown(b, { key: 'ArrowUp', altKey: true });
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['b', 'a', 'c'] });
    fireEvent.keyDown(b, { key: 'ArrowDown', altKey: true });
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['a', 'c', 'b'] });
    onAction.mockClear();
    fireEvent.keyDown(b, { key: 'ArrowUp' });
    expect(onAction).not.toHaveBeenCalled();
  });
  it('掴んでいる間に前の行が消えても、浮いた行はポインタに付いたままで、ずらしは id から引き直し、離すと指した行の前に入る', () => {
    const m = mount(liveOfIds(['x', 'a', 'b', 'c']));
    placeRows(30, ['x', 'a', 'b', 'c']);
    pointerAt('pointerDown', linkOf('c'), 205);
    pointerAt('pointerMove', linkOf('c'), 134);
    expect(linkOf('c').style.translate).toMatch(/-71px$/);
    expect(linkOf('a').style.translate).toMatch(/ 30px$/);
    // x が消えて行が 1 つ上へ詰まる。ポインタ（134）は、いまは b の上にある。
    remount(m, ['a', 'b', 'c']);
    expect(linkOf('c').style.translate).toMatch(/-41px$/);
    expect(linkOf('b').style.translate).toMatch(/ 30px$/);
    expect(linkOf('a').style.translate).toBe('');
    pointerAt('pointerUp', linkOf('c'), 134);
    expect(m.onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['a', 'c', 'b'] });
  });
  it('掴んでいる間に前へ行が増えても、浮いた行はポインタに付いたままで、離すとその下の行の前に入る', () => {
    const m = mount(liveOfIds(['a', 'b', 'c']));
    placeRows();
    pointerAt('pointerDown', linkOf('c'), 175);
    pointerAt('pointerMove', linkOf('c'), 104);
    // y が先頭に入って行が 1 つ下へずれる。ポインタ（104）は、いまは y の上にあり、浮いた行は端で止まる。
    remount(m, ['y', 'a', 'b', 'c']);
    expect(linkOf('c').style.translate).toMatch(/-98px$/);
    for (const id of ['y', 'a', 'b']) expect(linkOf(id).style.translate).toMatch(/ 30px$/);
    pointerAt('pointerUp', linkOf('c'), 104);
    expect(m.onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['c', 'y', 'a', 'b'] });
  });
  it('収まる間に前の行が消えても、離したときに指した行の前に入る', () => {
    const restore = fakeMotionTokens();
    vi.useFakeTimers();
    try {
      const m = mount(liveOfIds(['x', 'a', 'b', 'c']));
      placeRows(30, ['x', 'a', 'b', 'c']);
      pointerAt('pointerDown', linkOf('c'), 205);
      pointerAt('pointerMove', linkOf('c'), 134);
      pointerAt('pointerUp', linkOf('c'), 134);
      expect(linkOf('c').style.translate).toMatch(/-60px$/);
      remount(m, ['a', 'b', 'c']);
      expect(linkOf('c').style.translate).toMatch(/-60px$/);
      expect(linkOf('a').style.translate).toMatch(/ 30px$/);
      expect(linkOf('b').style.translate).toMatch(/ 30px$/);
      act(() => { vi.advanceTimersByTime(200); });
      expect(m.onAction).toHaveBeenCalledTimes(1);
      expect(m.onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['c', 'a', 'b'] });
    } finally { vi.useRealTimers(); restore(); }
  });
  it('収まる間に前へ行が増えても、離したときに指した行の前に入る', () => {
    const restore = fakeMotionTokens();
    vi.useFakeTimers();
    try {
      const m = mount(liveOfIds(['a', 'b', 'c']));
      placeRows();
      pointerAt('pointerDown', linkOf('c'), 175);
      pointerAt('pointerMove', linkOf('c'), 104);
      pointerAt('pointerUp', linkOf('c'), 104);
      remount(m, ['y', 'a', 'b', 'c']);
      expect(linkOf('c').style.translate).toMatch(/-60px$/);
      expect(linkOf('a').style.translate).toMatch(/ 30px$/);
      expect(linkOf('b').style.translate).toMatch(/ 30px$/);
      expect(linkOf('y').style.translate).toBe('');
      act(() => { vi.advanceTimersByTime(200); });
      expect(m.onAction).toHaveBeenCalledTimes(1);
      expect(m.onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['y', 'c', 'a', 'b'] });
    } finally { vi.useRealTimers(); restore(); }
  });
  it('収まる間に指した行が消えたら、並べ替えを捨てて並びを出さない', () => {
    const restore = fakeMotionTokens();
    vi.useFakeTimers();
    try {
      const m = mount(liveOfIds(['a', 'b', 'c']));
      placeRows();
      pointerAt('pointerDown', linkOf('c'), 175);
      pointerAt('pointerMove', linkOf('c'), 104);
      pointerAt('pointerUp', linkOf('c'), 104);
      remount(m, ['b', 'c']);
      expect(linkOf('c')).not.toHaveAttribute('data-lift');
      expect(linkOf('c').style.translate).toBe('');
      expect(linkOf('c').closest('ul')).not.toHaveAttribute('data-sorting');
      act(() => { vi.advanceTimersByTime(200); });
      expect(m.onAction).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); restore(); }
  });
  it('掴んでいる間に掴んだ行が消えたら、並べ替えを捨てて並びを出さない', () => {
    const m = mount(liveOfIds(['a', 'b', 'c']));
    placeRows();
    const c = linkOf('c');
    pointerAt('pointerDown', c, 175);
    pointerAt('pointerMove', c, 104);
    remount(m, ['a', 'b']);
    expect(linkOf('a').closest('ul')).not.toHaveAttribute('data-sorting');
    expect(linkOf('a').style.translate).toBe('');
    pointerAt('pointerUp', c, 104);
    expect(m.onAction).not.toHaveBeenCalled();
  });
  it('並べ替えの間（掴んでいる間と収まる間）は、⌥↑↓、.、右クリックを受けない', () => {
    const restore = fakeMotionTokens();
    vi.useFakeTimers();
    try {
      const { onAction } = mount(liveProps());
      placeRows();
      const [a, b, c] = ['a', 'b', 'c'].map(linkOf) as [HTMLElement, HTMLElement, HTMLElement];
      const others = () => {
        fireEvent.keyDown(b, { key: 'ArrowUp', altKey: true });
        fireEvent.keyDown(a, { key: 'ArrowDown', altKey: true });
        fireEvent.keyDown(b, { key: '.' });
        const ev = createEvent.contextMenu(a, { clientX: 40, clientY: 120 });
        fireEvent(a, ev);
        // ブラウザのメニューも出さない。
        expect(ev.defaultPrevented).toBe(true);
        expect(screen.queryByRole('menu')).toBeNull();
        for (const el of [a, b, c]) expect(el).not.toHaveAttribute('data-menu');
        expect(onAction).not.toHaveBeenCalled();
      };
      pointerAt('pointerDown', c, 175);
      pointerAt('pointerMove', c, 104);
      expect(c).toHaveAttribute('data-lift', 'held');
      others();
      pointerAt('pointerUp', c, 104);
      expect(c).toHaveAttribute('data-lift', 'settle');
      others();
      act(() => { vi.advanceTimersByTime(200); });
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['c', 'a', 'b'] });
    } finally { vi.useRealTimers(); restore(); }
  });
  it('並べ替えの途中の Esc は、ほかの Esc の受け手（窓の捕捉と浮上、Root、ダイアログの殻）へ届かせない。並べ替えの外では届く', () => {
    // Esc を受けるのは、窓の浮上の段の Root（overlay.close）、要素の上のダイアログの殻とポップオーバー、窓の捕捉の段の EditorMissing である。
    // サイドバーは掴んだときに窓の捕捉の段へ付けるので、それより後に付いた捕捉と、浮上の段の受け手のすべてより先に受ける。
    const restore = fakeMotionTokens();
    vi.useFakeTimers();
    const bubble = vi.fn();
    const onBody = vi.fn();
    const capture = vi.fn();
    window.addEventListener('keydown', bubble);
    document.body.addEventListener('keydown', onBody);
    try {
      mount(liveProps());
      placeRows();
      const c = linkOf('c');
      pointerAt('pointerDown', c, 175);
      pointerAt('pointerMove', c, 104);
      window.addEventListener('keydown', capture, true);
      const ev = createEvent.keyDown(document.body, { key: 'Escape' });
      fireEvent(document.body, ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(c).toHaveAttribute('data-lift', 'settle');
      expect(capture).not.toHaveBeenCalled();
      expect(onBody).not.toHaveBeenCalled();
      expect(bubble).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(200); });
      pointerAt('pointerUp', c, 104);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(onBody).toHaveBeenCalledTimes(1);
      expect(bubble).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', bubble);
      window.removeEventListener('keydown', capture, true);
      document.body.removeEventListener('keydown', onBody);
      vi.useRealTimers();
      restore();
    }
  });
  it('収まる間に節が消えても（アンマウント）、収まりの予約と窓の Esc を片付け、並びを出さない', () => {
    const restore = fakeMotionTokens();
    vi.useFakeTimers();
    const removed = vi.spyOn(window, 'removeEventListener');
    try {
      const m = mount(liveProps());
      placeRows();
      pointerAt('pointerDown', linkOf('c'), 175);
      pointerAt('pointerMove', linkOf('c'), 104);
      pointerAt('pointerUp', linkOf('c'), 104);
      m.unmount();
      act(() => { vi.advanceTimersByTime(200); });
      expect(m.onAction).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      // 掴んでいる間に消えたときも、窓の Esc を外す。
      const n = mount(liveProps());
      placeRows();
      pointerAt('pointerDown', linkOf('c'), 175);
      pointerAt('pointerMove', linkOf('c'), 104);
      removed.mockClear();
      n.unmount();
      expect(removed).toHaveBeenCalledWith('keydown', expect.any(Function), true);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      act(() => { vi.advanceTimersByTime(200); });
      expect(n.onAction).not.toHaveBeenCalled();
    } finally { removed.mockRestore(); vi.useRealTimers(); restore(); }
  });
});

describe('「実行中」のグループ（Sidebar）', () => {
  // web に a・b、docs に c、未分類に d。
  const three = (over: { web?: Partial<SideLiveGroup>; docs?: Partial<SideLiveGroup> } = {}) => {
    const rows = [row('a'), row('b', { live: 'waiting', waited: '入力待ち 1 分' }), row('c'), row('d')];
    return shaped(rows, [group('web', rows.slice(0, 2), over.web), group('docs', rows.slice(2, 3), over.docs), group('', rows.slice(3))]);
  };
  const head = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
  it('グループごとに見出しを出し、名前だけを添える（動いている会話の数は出さない）。見出しは開き閉じのボタンで、開いていれば aria-expanded が真', () => {
    mount(three());
    expect(head('web')).toHaveAttribute('aria-expanded', 'true');
    expect(head('web')).toHaveTextContent(/^web$/);
    expect(head('未分類')).toHaveTextContent(/^未分類$/);
    const web = head('web').closest('[data-group]')!;
    expect([...web.querySelectorAll('a')].map((a) => a.dataset.id)).toEqual(['a', 'b']);
  });
  it('見出しを押すと畳む手を出し、畳んだグループの見出しを押すと開く手を出す。畳んだグループの行は見せない', () => {
    const { onAction } = mount(three({ docs: { open: false } }));
    fireEvent.click(head('web'));
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.fold', key: 'web', open: false });
    fireEvent.click(head('docs'));
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.fold', key: 'docs', open: true });
    expect(head('docs')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: /name-c/ })).toBeNull();
  });
  it('畳んだグループに入力待ちがあれば、見出しに印を付け、読み上げにも待ちの数を添える。開いているときは付けない', () => {
    mount(three({ web: { open: false } }));
    expect(head('web')).toHaveAttribute('data-waiting', 'true');
    expect(head('web')).toHaveAccessibleName(/入力待ち 1/);
    cleanupAll();
    mount(three());
    expect(head('web')).not.toHaveAttribute('data-waiting');
  });
  it('行の ⌥↑↓ はグループの中だけで動かす。グループの端では動かさない', () => {
    const { onAction } = mount(three());
    fireEvent.keyDown(linkOf('b'), { key: 'ArrowUp', altKey: true });
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['b', 'a'] });
    onAction.mockClear();
    fireEvent.keyDown(linkOf('b'), { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(linkOf('c'), { key: 'ArrowUp', altKey: true });
    expect(onAction).not.toHaveBeenCalled();
  });
  it('見出しの ⌥↑↓ はグループごと動かし、全部の並びを出す。端では動かさない', () => {
    const { onAction } = mount(three());
    fireEvent.keyDown(head('web'), { key: 'ArrowDown', altKey: true });
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['c', 'a', 'b', 'd'] });
    onAction.mockClear();
    fireEvent.keyDown(head('web'), { key: 'ArrowUp', altKey: true });
    fireEvent.keyDown(head('未分類'), { key: 'ArrowDown', altKey: true });
    expect(onAction).not.toHaveBeenCalled();
  });
  it('見出しを掴んで動かすとグループごと浮き、ほかのグループはその高さ分よける。離すとグループの順を確定し、離したあとの click では畳まない', () => {
    const { onAction } = mount(three());
    // web は 100〜190、docs は 190〜250、未分類は 250〜310。
    const boxes: Record<string, [number, number]> = { web: [100, 90], docs: [190, 60], '': [250, 60] };
    for (const el of document.querySelectorAll<HTMLElement>('[data-group]')) {
      const [top, height] = boxes[el.dataset.group!]!;
      el.getBoundingClientRect = () => ({ top, height, bottom: top + height, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) });
    }
    const h = head('web');
    const box = (key: string) => document.querySelector<HTMLElement>(`[data-group="${key}"]`)!;
    // 80px 下げると、web の下の端（270）が docs の真ん中（220）を越え、未分類の真ん中（280）は越えない。
    pointerAt('pointerDown', h, 110);
    pointerAt('pointerMove', h, 190);
    expect(box('web')).toHaveAttribute('data-lift', 'held');
    expect(box('web').style.translate).toMatch(/ 80px$/);
    expect(box('docs').style.translate).toMatch(/-90px$/);
    expect(box('').style.translate).toBe('');
    pointerAt('pointerUp', h, 190);
    fireEvent.click(h);
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['c', 'a', 'b', 'd'] });
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sidebar.fold' }));
    expect(box('web')).not.toHaveAttribute('data-lift');
  });
  it('背の高いグループも、背の低いグループの下へ動かせる。下へは下の端、上へは上の端が相手の真ん中を越えたら入れ替わる', () => {
    const { onAction } = mount(three());
    // web は行の多い背の高いグループ（100〜400）、docs（400〜460）と未分類（460〜520）は低い。
    const boxes: Record<string, [number, number]> = { web: [100, 300], docs: [400, 60], '': [460, 60] };
    for (const el of document.querySelectorAll<HTMLElement>('[data-group]')) {
      const [top, height] = boxes[el.dataset.group!]!;
      el.getBoundingClientRect = () => ({ top, height, bottom: top + height, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) });
    }
    const h = head('web');
    // 40px 下げると、web の下の端（440）が docs の真ん中（430）を越える。真ん中同士で比べていた前は、端まで下げても越えられなかった。
    pointerAt('pointerDown', h, 110);
    pointerAt('pointerMove', h, 150);
    const box = (key: string) => document.querySelector<HTMLElement>(`[data-group="${key}"]`)!;
    expect(box('docs').style.translate).toMatch(/-300px$/);
    expect(box('').style.translate).toBe('');
    pointerAt('pointerUp', h, 150);
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['c', 'a', 'b', 'd'] });
    onAction.mockClear();
    cleanupAll();
    // 低いグループを、背の高いグループの上へ動かす向きも同じ決まりで入れ替わる。
    const again = mount(three());
    const tall: Record<string, [number, number]> = { web: [100, 300], docs: [400, 60], '': [460, 60] };
    for (const el of document.querySelectorAll<HTMLElement>('[data-group]')) {
      const [top, height] = tall[el.dataset.group!]!;
      el.getBoundingClientRect = () => ({ top, height, bottom: top + height, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) });
    }
    // docs の上の端（400）を 160px 上げて 240 にすると、web の真ん中（250）を越える。
    pointerAt('pointerDown', head('docs'), 410);
    pointerAt('pointerMove', head('docs'), 250);
    pointerAt('pointerUp', head('docs'), 250);
    expect(again.onAction).toHaveBeenCalledWith({ type: 'sidebar.order', ids: ['c', 'a', 'b', 'd'] });
  });
  it('グループの並びをスクロールの箱に入れる', () => {
    const { container } = mount(three());
    const scroller = container.querySelector('.side-live-scroll')!;
    expect(scroller.querySelectorAll('a')).toHaveLength(4);
  });
});

describe('行のメニューの「停止」に要る情報（presentShell）', () => {
  const run = (id: string, sessionId: string, endedAt: number | null = null) => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: 1, startedAt: 1, endedAt, endReason: null, heartbeatAt: 1 });
  const tab = (id: string, runId: string, kind: 'agent' | 'shell', closedAt: number | null = null) => ({ id, runId, sessionId: 'a', kind, title: id, tmuxName: `hangar-${runId}-${id}`, createdAt: 1, closedAt });
  const withRuns = (list: SessionDto[], runs: ReturnType<typeof run>[], tabs: ReturnType<typeof tab>[] = []): Store => ({ ...storeWith(list), runs: Object.fromEntries(runs.map((r) => [r.id, r])), tabs: Object.fromEntries(tabs.map((t) => [t.id, t])) } as unknown as Store);
  const stopOf = (store: Store, id: string) => liveOf(store, at('projects')).rows.find((r) => r.id === id)?.menu.stop;

  it('hangar の run が生きていれば、その id と、作業中かどうかと、開いているシェルのタブの数を持つ', () => {
    const store = withRuns([session('a', { live: 'idle' }), session('b', { live: 'busy' }), session('c', { live: 'waiting' })], [run('ra', 'a'), run('rb', 'b'), run('rc', 'c')],
      [tab('t1', 'ra', 'agent'), tab('t2', 'ra', 'shell'), tab('t3', 'ra', 'shell'), tab('t4', 'ra', 'shell', 5)]);
    expect(stopOf(store, 'a')).toEqual({ runId: 'ra', working: false, aside: false, shellTabs: 2 });
    expect(stopOf(store, 'b')).toEqual({ runId: 'rb', working: true, aside: false, shellTabs: 0 });
    expect(stopOf(store, 'c')).toEqual({ runId: 'rc', working: true, aside: false, shellTabs: 0 });
  });
  it('hangar の外で動いているもの（生きた run が無い）は、外部ターミナルのものとして止める手を持たない', () => {
    const store = withRuns([session('a', { live: 'busy' }), session('b', { live: 'idle' })], [run('rb-old', 'b', 9)]);
    expect(stopOf(store, 'a')).toBe('external');
    expect(stopOf(store, 'b')).toBe('external');
  });
});

describe('行のメニュー（右クリックと .）', () => {
  it('行を右クリックすると、その行に印を付けてセッションのメニュー（1A）を押した点に出す。ブラウザのメニューは出さない', () => {
    mount(liveProps());
    const a = screen.getByRole('link', { name: /name-a/ });
    const ev = createEvent.contextMenu(a, { clientX: 40, clientY: 120 });
    fireEvent(a, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(a).toHaveAttribute('data-menu', 'true');
    expect(screen.getByRole('link', { name: /name-b/ })).not.toHaveAttribute('data-menu');
    expect(screen.getByRole('menu')).toHaveAccessibleName('name-a のメニュー');
    expect(screen.getAllByRole('menuitemradio').map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([['Activeu', 'true'], ['Pausedp', 'false'], ['Doned', 'false'], ['Archiveda', 'false']]);
    const items = screen.getAllByRole('menuitem');
    // 停止の補足の 1 行は出さない。
    expect(items.map((i) => i.textContent)).toEqual(['右に分割して開く', '下に分割して開く', 'プロジェクトを変更…m', 'セッション ID をコピー', '停止']);
    expect(items[4]).toHaveAttribute('data-danger', 'true');
  });
  it('「停止」を押すと、その行の run を止める手を出し、メニューを閉じる。行は開かない', () => {
    const { onAction } = mount(liveProps({ rows: [row('a', { menu: menuOf('a', { runId: 'r9', working: false, aside: false, shellTabs: 2 }) }), row('b')] }));
    fireEvent.contextMenu(screen.getByRole('link', { name: /name-a/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^停止/ }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.kill', runId: 'r9', working: false, aside: false, shellTabs: 2 });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('link', { name: /name-a/ })).not.toHaveAttribute('data-menu');
  });
  it('hangar の外で動いている行では、「停止」を押せない形で出し、理由を添える', () => {
    const { onAction } = mount(liveProps({ rows: [row('a', { menu: menuOf('a', 'external') })] }));
    fireEvent.contextMenu(screen.getByRole('link', { name: /name-a/ }));
    const item = screen.getByRole('menuitem', { name: /^停止/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('外部ターミナルで実行中');
    fireEvent.click(item);
    expect(onAction).not.toHaveBeenCalled();
  });
  it('「プロジェクトを変更…」は移す先のダイアログを開き、状態は打鍵の印でその状態にする', () => {
    const { onAction } = mount(liveProps());
    fireEvent.contextMenu(screen.getByRole('link', { name: /name-a/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /プロジェクトを変更/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.move.open', id: 'a' });
    fireEvent.contextMenu(screen.getByRole('link', { name: /name-b/ }));
    fireEvent.keyDown(document.activeElement!, { key: 'd' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 'b', status: 'done' });
  });
  it('行に焦点があるときの . でも開き、Esc で閉じて焦点を行へ戻す', () => {
    const { onAction } = mount(liveProps());
    const b = screen.getByRole('link', { name: /name-b/ });
    b.focus();
    fireEvent.keyDown(b, { key: '.' });
    expect(b).toHaveAttribute('data-menu', 'true');
    const first = screen.getAllByRole('menuitemradio')[0]!;
    expect(first).toHaveFocus();
    expect(first).toHaveTextContent('Active');
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(b).toHaveFocus();
    expect(onAction).not.toHaveBeenCalled();
  });
  it('修飾キーの付いた . では開かない', () => {
    mount(liveProps());
    const b = screen.getByRole('link', { name: /name-b/ });
    fireEvent.keyDown(b, { key: '.', metaKey: true });
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('別の行を右クリックすると、メニューはその行のものに替わる', () => {
    mount(liveProps());
    fireEvent.contextMenu(screen.getByRole('link', { name: /name-a/ }));
    fireEvent.contextMenu(screen.getByRole('link', { name: /name-b/ }));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByRole('menu')).toHaveAccessibleName('name-b のメニュー');
    expect(screen.getByRole('link', { name: /name-a/ })).not.toHaveAttribute('data-menu');
  });
});

describe('サイドバーの「実行中」の見た目', () => {
  const base = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../styles/base.css'), 'utf8');
  it('掴んだ行は白い面と影と 102% で浮き、ほかの行は --dur-fast で滑る。入る場所の線は出さない', () => {
    expect(base).not.toContain('data-over');
    expect(base).toMatch(/\.side-live-list \.side-live-row\[data-lift='held'\] \{[^}]*background: rgba\(255, 255, 255, 0\.9\d\)[^}]*box-shadow: var\(--glass-drop\)[^}]*scale: 1\.02/);
    expect(base).toMatch(/\.side-live-list\[data-sorting='true'\] \.side-live-row \{[^}]*translate var\(--dur-fast\) var\(--ease-out\)/);
    expect(base).toMatch(/\.side-live-list \.side-live-row\[data-lift='settle'\] \{[^}]*translate var\(--dur-fast\) var\(--ease-out\)/);
  });
  it('reduced motion では浮いた行を大きくしない', () => {
    expect(base).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.side-live-list \.side-live-row\[data-lift='held'\] \{ scale: none; \}/);
  });
  it('節は設定の上までの高さを使い、行の一覧だけをスクロールさせる', () => {
    expect(base).toMatch(/\.side-live \{[^}]*flex: 1[^}]*min-height: 0/);
    expect(base).toMatch(/\.side-live-scroll \{[^}]*overflow-y: auto/);
    expect(base).not.toContain('side-live-more');
  });
  it('畳んだ帯ではグループの見出しを出さず、畳んだグループの点も出す', () => {
    expect(base).toMatch(/\[data-sidebar='collapsed'\] \.side-live-grp-h[^{]*\{ display: none; \}/);
    expect(base).toMatch(/\[data-sidebar='collapsed'\] \.side-live-grp-body\[hidden\] \{ display: block; \}/);
  });
  it('掴んだグループは行と同じ形で浮き、ほかのグループは --dur-fast で滑る', () => {
    expect(base).toMatch(/\.side-live-grp\[data-lift='held'\] \{[^}]*box-shadow: var\(--glass-drop\)/);
    expect(base).toMatch(/\.side-live-scroll\[data-sorting='true'\] \.side-live-grp \{[^}]*translate var\(--dur-fast\) var\(--ease-out\)/);
  });
  it('畳んだ帯では名前を出さず、点だけを並べる', () => {
    expect(base).toMatch(/\[data-sidebar='collapsed'\] \.side-live-name, [^{]*\{ display: none; \}/);
  });
  it('「実行中」の見出しと件数の形は残さない', () => {
    expect(base).not.toMatch(/\.side-live-[hn]\b/);
  });
});

describe('⌥クリックで右に分割して開く（サイドバーの行）', () => {
  it('⌥ を押しながら行を押すと pane.open（右）を出し、session.open は出さない。ふつうに押すと session.open', () => {
    const { onAction } = mount(liveProps());
    fireEvent.click(linkOf('a'), { altKey: true });
    expect(onAction).toHaveBeenCalledWith({ type: 'pane.open', sessionId: 'a', target: null, side: 'right' });
    expect(onAction).not.toHaveBeenCalledWith({ type: 'session.open', id: 'a' });
    onAction.mockClear();
    fireEvent.click(linkOf('a'));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 'a' });
  });
});
