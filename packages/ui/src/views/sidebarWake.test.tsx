import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import { presentShell, type SideLiveProps, type SideLiveRow } from '../presenters/shell.ts';
import type { SessionMenuProps } from '../presenters/sessionMenu.ts';
import { initialStore } from '../store/store.ts';
import { Sidebar } from './Sidebar.tsx';

const NOW = 1_800_000_000_000;
const menuOf = (id: string): SessionMenuProps => ({ id, name: `name-${id}`, status: null, resumeHere: null, stop: { runId: `r-${id}`, working: true, aside: false, shellTabs: 0 }, moveBlocked: null });
const row = (id: string, over: Partial<SideLiveRow> = {}): SideLiveRow => ({ id, name: `name-${id}`, live: 'busy', aside: false, reason: null, waited: null, current: false, menu: menuOf(id), ...over });
const live = (rows: SideLiveRow[]): SideLiveProps => ({ count: rows.length, ids: rows.map((r) => r.id), rows, groups: [{ key: 'web', name: 'web', open: true, waiting: 0, rows }], pins: [] });
const view = (rows: SideLiveRow[], onAction = vi.fn()) => <ActionRoot onAction={onAction}><Sidebar nav={[]} foot={[]} collapsed={false} live={live(rows)} /></ActionRoot>;
const linkOf = (id: string) => screen.getByRole('link', { name: new RegExp(`name-${id}`) });
afterEach(cleanup);

const session = (id: string): SessionDto => ({ id, provider: 'claude-code', providerSessionId: `u-${id}`, projectId: null, name: `name-${id}`, cwd: '/w', firstPrompt: null, aiTitle: null, startedAt: NOW - 1000, lastActivityAt: NOW, live: 'busy' } as SessionDto);

describe('起こした行の光り（presentShell）', () => {
  const store = { ...initialStore(), bootstrapped: true, sessions: { a: session('a'), b: session('b') } };
  const rowsOf = (glow: { id: string; at: number }[], now = NOW) => presentShell({ ...initialState(), wakeGlow: glow }, store, now).live.rows;
  it('できごとで起こした会話の行にだけ印を付ける', () => {
    expect(rowsOf([{ id: 'b', at: NOW - 500 }]).map((r) => [r.id, r.wake])).toEqual([['a', undefined], ['b', true]]);
  });
  it('起こしてから長く経った印は使わない（行が出ないまま残った印が、あとの普通の再開で光らないように）', () => {
    expect(rowsOf([{ id: 'b', at: NOW - 61_000 }]).every((r) => !r.wake)).toBe(true);
  });
});

describe('起こした行の光り（Sidebar）', () => {
  it('a woken session row gets the wake highlight once', () => {
    const onAction = vi.fn();
    const { rerender } = render(view([row('a')], onAction));
    expect(linkOf('a')).not.toHaveAttribute('data-hit');
    // 起こされた会話の行が Active に入る。印の付いた行が光り、光ったと知らせて印を下げる。
    rerender(view([row('a'), row('b', { wake: true })], onAction));
    expect(linkOf('b')).toHaveAttribute('data-hit');
    expect(linkOf('a')).not.toHaveAttribute('data-hit');
    expect(onAction.mock.calls.filter((c) => c[0].type === 'wakeGlow.seen')).toEqual([[{ type: 'wakeGlow.seen', id: 'b' }]]);
    // 印が下がったあとに同じ行が描き直されても、もう光らせず、知らせも出さない。
    linkOf('b').removeAttribute('data-hit');
    rerender(view([row('a'), row('b', { live: 'waiting' })], onAction));
    expect(linkOf('b')).not.toHaveAttribute('data-hit');
    expect(onAction.mock.calls.filter((c) => c[0].type === 'wakeGlow.seen')).toHaveLength(1);
  });
  it('印が付いたまま描き直されても、同じ行を 2 度は光らせない', () => {
    const onAction = vi.fn();
    const { rerender } = render(view([row('b', { wake: true })], onAction));
    expect(onAction.mock.calls.filter((c) => c[0].type === 'wakeGlow.seen')).toHaveLength(1);
    linkOf('b').removeAttribute('data-hit');
    rerender(view([row('b', { wake: true, live: 'idle' })], onAction));
    expect(linkOf('b')).not.toHaveAttribute('data-hit');
    expect(onAction.mock.calls.filter((c) => c[0].type === 'wakeGlow.seen')).toHaveLength(1);
  });
});
