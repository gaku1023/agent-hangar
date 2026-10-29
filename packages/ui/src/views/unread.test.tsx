import { fireEvent, render, screen, within } from '@testing-library/react';
import { translator, type UiAction } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { presentHomeBand } from '../presenters/home.ts';
import type { SideLiveGroup, SideLiveProps, SideLiveRow } from '../presenters/shell.ts';
import type { SessionMenuProps } from '../presenters/sessionMenu.ts';
import { HomeBand } from './HomeBand.tsx';
import { LanguageRoot } from './primitives/language.tsx';
import { Sidebar } from './Sidebar.tsx';

const ja = translator('ja');

const menuOf = (id: string): SessionMenuProps => ({ id, name: `name-${id}`, status: null, resumeHere: null, stop: { runId: `r-${id}`, working: true, aside: false, shellTabs: 0 }, moveBlocked: null });
const row = (id: string, over: Partial<SideLiveRow> = {}): SideLiveRow => ({ id, name: `name-${id}`, live: 'busy', aside: false, reason: null, waited: null, current: false, menu: menuOf(id), ...over });
const live = (rows: SideLiveRow[]): SideLiveProps => {
  const g: SideLiveGroup = { key: 'web', name: 'web', open: true, waiting: 0, rows };
  return { count: rows.length, ids: rows.map((r) => r.id), rows, groups: [g] };
};
const mountSidebar = (props: SideLiveProps, nav: { count: number; waiting?: number; unread?: number } = { count: 0 }) => render(
  <LanguageRoot language="ja"><ActionRoot onAction={vi.fn()}><Sidebar nav={[{ route: { name: 'home' }, label: 'ホーム', current: false, ...nav }]} foot={[]} collapsed={false} live={props} /></ActionRoot></LanguageRoot>,
);

describe('サイドバーの未読', () => {
  it('未読のある行は名前を太くする印を持ち、名前の右に数の丸を出す。読み上げは「未読 N 件」。無い行には出さない', () => {
    const { container } = mountSidebar(live([row('a', { unread: 2 }), row('b')]));
    const a = container.querySelector<HTMLElement>('.side-live-row[data-id="a"]')!;
    expect(a).toHaveAttribute('data-unread', 'true');
    const n = a.querySelector('.side-live-unread')!;
    expect(n).toHaveTextContent('2');
    expect(n.querySelector('.sr-only')).toHaveTextContent('未読 2 件');
    // 名前のすぐ後ろ（エージェントの札や待ちの語より手前）に置く。
    expect(a.querySelector('.side-live-name')!.nextElementSibling).toBe(n);
    const b = container.querySelector('.side-live-row[data-id="b"]')!;
    expect(b).not.toHaveAttribute('data-unread');
    expect(b.querySelector('.side-live-unread')).toBeNull();
  });
  it('エージェントの札のある行では、丸は札の手前に置く', () => {
    const { container } = mountSidebar(live([row('a', { unread: 1, agent: 'codex' })]));
    const a = container.querySelector('.side-live-row')!;
    const kids = [...a.children].map((c) => c.className.split(' ')[0]);
    expect(kids.indexOf('side-live-unread')).toBeGreaterThan(-1);
    expect(kids.indexOf('side-live-unread')).toBeLessThan(kids.indexOf('side-live-agent'));
  });
  it('グループの見出しの右に、動いている会話の数を出さない', () => {
    const { container } = mountSidebar(live([row('a'), row('b')]));
    expect(container.querySelector('.side-live-grp-h')).toHaveTextContent(/^web$/);
  });
  it('ホームの項目の丸は、入力待ちと未読を分けて読み上げる', () => {
    mountSidebar(live([]), { count: 3, waiting: 1, unread: 2 });
    const link = screen.getByRole('link', { name: 'ホーム、入力待ち 1、未読 2 件' });
    expect(within(link).getByText('3')).toBeInTheDocument();
  });
});

describe('ホームの帯の「未読」', () => {
  const card = { id: 'u1', name: '依存を更新する', projectName: 'web-shop', live: 'busy' as const, aside: false, latest: '調査が終わりました', ago: '2 分前', count: 2 };
  const none = { attention: [], returning: [], running: [], confirm: [] };
  function mount(unread: (typeof card)[]) {
    const onAction = vi.fn<(i: UiAction) => void>();
    render(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><HomeBand {...presentHomeBand({ ...none, running: [{ id: 'x', name: 'x', live: 'busy', aside: false, elapsed: '5分', meta: 'alpha', intent: null, activity: null, note: '作業中', idleFor: null, contextPercent: 1, contextLabel: '1%' }], unread }, ja)} /></ActionRoot></LanguageRoot>);
    return { onAction };
  }
  it('札は「未読 N」で、押すと引き出しに知らせの文と数を並べ、行を押すとそのセッションを開く', () => {
    const { onAction } = mount([card]);
    const chip = screen.getByRole('button', { name: /未読/ });
    expect(chip).toHaveTextContent('2');
    expect(screen.queryByRole('region', { name: '未読' })).toBeNull();
    fireEvent.click(chip);
    const drawer = screen.getByRole('region', { name: '未読' });
    expect(drawer).toHaveTextContent('調査が終わりました');
    expect(drawer).toHaveTextContent('web-shop');
    expect(drawer.querySelector('.c-end [data-tone="unread"]')).toHaveTextContent('2');
    fireEvent.click(within(drawer).getByRole('button', { name: '依存を更新する' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 'u1' });
  });
  it('未読が 0 なら 0 の見た目で、押せず、引き出しは出ない', () => {
    mount([]);
    const chip = screen.getByText('未読').closest('.count-chip')!;
    expect(chip).toHaveAttribute('data-zero', 'true');
    expect(chip.tagName).toBe('SPAN');
    expect(screen.queryByRole('region', { name: '未読' })).toBeNull();
  });
});
