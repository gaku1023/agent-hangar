import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { initialState, transition } from '../mediator/transition.ts';
import { presentShell, type SideLiveProps } from '../presenters/shell.ts';
import { initialStore } from '../store/store.ts';
import { Sidebar } from './Sidebar.tsx';

afterEach(cleanup);

const live: SideLiveProps = { count: 0, ids: [], rows: [], groups: [], pins: [] };
const home = { label: 'ホーム', route: { name: 'home' as const }, current: true, count: 0 };
const view = (history: { back: boolean; forward: boolean }, onAction = vi.fn(), collapsed = false) => (
  <ActionRoot onAction={onAction}><Sidebar nav={[home]} foot={[]} collapsed={collapsed} live={live} history={history} /></ActionRoot>
);

describe('サイドバーの戻る・進む（案 3：開閉の隣にいつも出し、行けないほうは薄く）', () => {
  it('ホームの行の、開閉のボタンの手前に戻る・進むを並べる', () => {
    const { container } = render(view({ back: true, forward: false }));
    const row = container.querySelector('.nav-row') as HTMLElement;
    const names = [...row.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['戻る', '進む', 'サイドバーを閉じる']);
  });

  it('行けないほうも消さずに出し、押せなくする', () => {
    render(view({ back: false, forward: false }));
    expect(screen.getByRole('button', { name: '戻る' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: '進む' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('押すと nav.back・nav.forward を出す。行けないほうは何も出さない', () => {
    const onAction = vi.fn();
    render(view({ back: true, forward: false }, onAction));
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.back' });
    fireEvent.click(screen.getByRole('button', { name: '進む' }));
    expect(onAction).not.toHaveBeenCalledWith({ type: 'nav.forward' });
    expect(screen.getByRole('button', { name: '戻る' })).not.toHaveAttribute('aria-disabled');
  });

  it('畳んだ帯でも同じ 2 つを出す', () => {
    render(view({ back: true, forward: true }, vi.fn(), true));
    expect(screen.getByRole('button', { name: '戻る' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '進む' })).toBeInTheDocument();
  });
});

describe('戻れる・進めるの状態（hash.changed に添える）', () => {
  it('はじめは両方とも行けない', () => {
    expect(initialState().history).toEqual({ back: false, forward: false });
  });
  it('runtime の知らせをそのまま状態に入れ、サイドバーへ渡す', () => {
    const { state } = transition(initialState(), initialStore(), { kind: 'runtime', event: { type: 'hash.changed', route: { name: 'projects' }, moved: 1, history: { back: true, forward: false } } });
    expect(state.history).toEqual({ back: true, forward: false });
    expect(presentShell(state, initialStore(), 0).history).toEqual({ back: true, forward: false });
  });
});
