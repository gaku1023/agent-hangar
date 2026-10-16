import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import { presentToasts, type ToastsProps } from '../presenters/toasts.ts';
import { initialStore } from '../store/store.ts';
import { ToastStack } from './ToastStack.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const arrived = (id: string, over: Partial<ProjectDto> = {}): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: null, resolved: false, lastActivityAt: null, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1, unresolved: { kind: 'elsewhere', previousPath: `/o/${id}`, deviceName: 'Mac mini' }, ...over });
const storeOf = (list: ProjectDto[]) => ({ ...initialStore(), projects: Object.fromEntries(list.map((p) => [p.id, p])) });

const props = (over: Partial<ToastsProps> = {}): ToastsProps => ({ toasts: [], waiting: [], more: 0, blocked: false, arrived: null, update: null, whatsNew: null, ...over });
function mount(p: ToastsProps, language: 'ja' | 'en' = 'ja') {
  const onAction = vi.fn();
  render(<LanguageRoot language={language}><ActionRoot onAction={onAction}><ToastStack {...p} /></ActionRoot></LanguageRoot>);
  return { onAction };
}

describe('presentToasts の他の PC から届いたプロジェクト（2.11.5）', () => {
  it('覚えてある id のうち、いまも届いたままのものを数えて 1 枚にする', () => {
    const state = { ...initialState(), arrivedProjects: ['a', 'b', 'c'] };
    expect(presentToasts(state, storeOf([arrived('a'), arrived('b'), arrived('c')]), 0).arrived).toEqual({ count: 3 });
    // 場所を決めたもの、Archived にしたもの、消えたものは数えない。
    const store = storeOf([arrived('a'), { ...arrived('b'), path: '/w/b', resolved: true, unresolved: null }, arrived('c', { status: 'archived' })]);
    expect(presentToasts(state, store, 0).arrived).toEqual({ count: 1 });
  });
  it('数が 0 になったら札を出さない。覚えが無くても出さない', () => {
    expect(presentToasts({ ...initialState(), arrivedProjects: ['gone'] }, storeOf([]), 0).arrived).toBeNull();
    expect(presentToasts(initialState(), storeOf([arrived('a')]), 0).arrived).toBeNull();
  });
});

describe('他の PC から届いたプロジェクトの札', () => {
  it('件数の入った 1 文と、「プロジェクトで表示」「あとで決める」の 2 つのボタンを出す', () => {
    mount(props({ arrived: { count: 3 } }));
    const card = screen.getByRole('status');
    expect(card).toHaveTextContent('他の PC からプロジェクト 3 件を受信しました。この PC にはディレクトリがありません');
    expect(screen.getByRole('button', { name: 'プロジェクトで表示' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'あとで決める' })).toBeInTheDocument();
  });

  it('「プロジェクトで表示」と「あとで決める」は、それぞれの UiAction を発行する', () => {
    const { onAction } = mount(props({ arrived: { count: 3 } }));
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクトで表示' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'projects.arrived.view' });
    fireEvent.click(screen.getByRole('button', { name: 'あとで決める' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'projects.arrived.dismiss' });
  });

  it('時間では消えない（利用者が決めるまで残る）。件数が無ければ札を出さない', () => {
    vi.useFakeTimers();
    mount(props({ arrived: { count: 2 } }));
    vi.advanceTimersByTime(60_000);
    expect(screen.getByRole('button', { name: 'あとで決める' })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('ダイアログが開いている間は「プロジェクトで表示」を押せない。「あとで決める」は押せる', () => {
    const { onAction } = mount(props({ arrived: { count: 1 }, blocked: true }));
    expect(screen.getByRole('button', { name: 'プロジェクトで表示' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'あとで決める' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'projects.arrived.dismiss' });
  });

  it('English では語が替わる', () => {
    mount(props({ arrived: { count: 3 } }), 'en');
    expect(screen.getByText('3 projects arrived from another computer. Their folders are not on this computer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View in Projects' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decide later' })).toBeInTheDocument();
  });
});
