import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionDto, UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import { presentSessionMenu, sessionMenuEntries, type SessionMenuProps } from '../presenters/sessionMenu.ts';
import { presentShell, type SideLiveProps, type SideLiveRow } from '../presenters/shell.ts';
import { initialStore, type Store } from '../store/store.ts';
import { translatorOf } from '../presenters/i18n.ts';
import { Sidebar } from './Sidebar.tsx';

const NOW = 1_800_000_000_000;
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', projectId: null, name: `name-${id}`, cwd: '/w', live: 'busy', startedAt: NOW - 1000, lastActivityAt: NOW, unread: null, state: null, ...over }) as SessionDto;
const storeWith = (list: SessionDto[]): Store => ({ ...initialStore(), bootstrapped: true, sessions: Object.fromEntries(list.map((s) => [s.id, s])) });
const liveOf = (store: Store) => presentShell({ ...initialState(), screen: { name: 'projects' } }, store, NOW).live;

afterEach(cleanup);

describe('ピンの段の中身（presentShell）', () => {
  it('留めた会話を留めた順に段へ置き、元のグループから外す。止まった会話も置く', () => {
    const live = liveOf(storeWith([session('a', { pinnedAt: 20 }), session('b'), session('z', { live: null, pinnedAt: 10 })]));
    expect(live.pins.map((r) => r.id)).toEqual(['z', 'a']);
    expect(live.pins[0]).toMatchObject({ live: null });
    expect(live.rows.map((r) => r.id)).toEqual(['b']);
    expect(live.ids).toEqual(['b']);
    expect(live.count).toBe(1);
  });
  it('留めていなければ段は空', () => {
    expect(liveOf(storeWith([session('a')])).pins).toEqual([]);
  });
  it('起動元を留めても、動いている子はグループに残り、起動元は薄い行で二重に出ない', () => {
    const live = liveOf(storeWith([session('p', { pinnedAt: 5, live: null }), session('k', { spawnedBy: 'p' })]));
    expect(live.pins.map((r) => r.id)).toEqual(['p']);
    expect(live.rows.map((r) => [r.id, r.depth ?? 0, r.dim ?? false])).toEqual([['k', 0, false]]);
  });
});

describe('メニューの 3 項目', () => {
  const t = translatorOf(initialStore());
  const menu = (over: Partial<SessionMenuProps> = {}): SessionMenuProps => ({ id: 's', name: 'n', status: null, resumeHere: null, stop: null, moveBlocked: null, ...over });
  const keys = (m: SessionMenuProps) => sessionMenuEntries(t, m).map((e) => e.key);
  it('状態の後ろに区切ってまとめる', () => {
    const list = sessionMenuEntries(t, menu());
    const at = list.findIndex((e) => e.key === 'markUnread');
    expect(list.slice(at, at + 3).map((e) => e.key)).toEqual(['markUnread', 'pin', 'duplicate']);
    expect(list[at]!.separatorBefore).toBe(true);
    expect(list[at - 1]!.key).toBe('archived');
    expect(list[at + 3]!.separatorBefore).toBe(true);
  });
  it('送る中身', () => {
    const by = Object.fromEntries(sessionMenuEntries(t, menu()).map((e) => [e.key, e]));
    expect(by.markUnread!.send).toEqual({ type: 'session.unread.mark', id: 's' });
    expect(by.pin).toMatchObject({ label: 'ピン留めする', send: { type: 'session.pin', id: 's', pinned: true } });
    expect(by.duplicate).toMatchObject({ label: '同じ設定で新しいセッション…', send: { type: 'session.duplicate', id: 's' } });
  });
  it('留めていれば外す項目になる', () => {
    expect(sessionMenuEntries(t, menu({ pinned: true })).find((e) => e.key === 'pin')).toMatchObject({ label: 'ピン留めを解除する', send: { type: 'session.pin', id: 's', pinned: false } });
  });
  it('すでに未読なら「未読に戻す」を出さない。先頭の区切りはピンへ移る', () => {
    const list = sessionMenuEntries(t, menu({ hideMarkUnread: true }));
    expect(keys(menu({ hideMarkUnread: true }))).not.toContain('markUnread');
    expect(list.find((e) => e.key === 'pin')!.separatorBefore).toBe(true);
  });
  it('Store から：未読があるとき、未読の数を出さない設定のときは隠す。pinnedAt で留めた印', () => {
    const s = session('s', { pinnedAt: 3 });
    expect(presentSessionMenu(storeWith([s]), s, t)).toMatchObject({ pinned: true, hideMarkUnread: false });
    const u = session('s', { unread: { count: 1, latest: null, at: 1 } });
    expect(presentSessionMenu(storeWith([u]), u, t)).toMatchObject({ pinned: false, hideMarkUnread: true });
    const off = { ...storeWith([session('s')]), settings: { unreadBadge: false } } as unknown as Store;
    expect(presentSessionMenu(off, session('s'), t).hideMarkUnread).toBe(true);
  });
});

describe('ピンの段（Sidebar）', () => {
  const menuOf = (id: string): SessionMenuProps => ({ id, name: `name-${id}`, status: null, resumeHere: null, stop: null, moveBlocked: null, pinned: id === 'p' });
  const row = (id: string, over: Partial<SideLiveRow> = {}): SideLiveRow => ({ id, name: `name-${id}`, live: 'busy', aside: false, reason: null, waited: null, current: false, menu: menuOf(id), ...over });
  const mount = (live: SideLiveProps) => {
    const onAction = vi.fn<(i: UiAction) => void>();
    render(<ActionRoot onAction={onAction}><Sidebar nav={[]} foot={[]} collapsed={false} live={live} /></ActionRoot>);
    return onAction;
  };
  const a = row('a');
  const withPin = (rows: SideLiveRow[] = [a]): SideLiveProps => ({ count: rows.length, ids: rows.map((r) => r.id), rows, groups: rows.length ? [{ key: '', name: 'g', open: true, waiting: 0, rows }] : [], pins: [row('p', { live: null })] });
  const pinsBox = () => document.querySelector('.side-pins') as HTMLElement | null;

  it('段は一覧の外に置き、スクロールする一覧に入れない', () => {
    mount(withPin());
    expect(within(pinsBox()!).getByText('name-p')).toBeInTheDocument();
    expect(pinsBox()!.closest('.side-live-scroll')).toBeNull();
    expect(document.querySelector('.side-live-scroll')).toHaveTextContent('name-a');
    expect(pinsBox()!.nextElementSibling).toBe(document.querySelector('.side-live-scroll'));
  });
  it('留めていなければ段を描かない', () => {
    mount({ ...withPin(), pins: [] });
    expect(pinsBox()).toBeNull();
  });
  it('動いている会話が無くても、段だけで節を出す', () => {
    mount(withPin([]));
    expect(within(pinsBox()!).getByText('name-p')).toBeInTheDocument();
  });
  it('押すと開き、右クリックで同じメニューが出て、外せる', () => {
    const onAction = mount(withPin());
    const link = within(pinsBox()!).getByText('name-p').closest('a')!;
    fireEvent.click(link);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 'p' });
    fireEvent.contextMenu(link);
    fireEvent.click(screen.getByRole('menuitem', { name: /ピン留めを解除する/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.pin', id: 'p', pinned: false });
  });
  it('段の行は掴んで並べ替えない', () => {
    const onAction = mount(withPin());
    const link = within(pinsBox()!).getByText('name-p').closest('a')!;
    fireEvent.keyDown(link, { key: 'ArrowDown', altKey: true });
    fireEvent.pointerDown(link, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(link, { pointerId: 1, clientX: 0, clientY: 40 });
    expect(link).not.toHaveAttribute('data-lift');
    expect(onAction).not.toHaveBeenCalled();
  });
});
