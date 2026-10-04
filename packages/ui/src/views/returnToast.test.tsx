import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionDto } from '@agent-hangar/shared';
import { IntentRoot } from '../intent/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import { presentToasts, type ToastsProps } from '../presenters/toasts.ts';
import { initialStore } from '../store/store.ts';
import { ToastStack } from './ToastStack.tsx';

/** 戻る時刻を過ぎた知らせの札。 */
const session = (id: string, note: string | null, returnTime: string | null = '13:30'): SessionDto => ({ id, name: '会話 ' + id, lastActivityAt: 1, state: { status: 'paused', note, returnOn: '2026-10-05', returnTime, setBy: 'user', setAt: 1, candidate: null } } as unknown as SessionDto);
const storeOf = (...list: SessionDto[]) => ({ ...initialStore(), bootstrapped: true, sessions: Object.fromEntries(list.map((s) => [s.id, s])) });

describe('presentToasts の戻る時刻の札', () => {
  it('積まれたセッションを、名前・時刻・理由の札にする。古いものが先', () => {
    const state = { ...initialState(), returnToasts: ['a', 'b'] };
    const p = presentToasts(state, storeOf(session('a', 'timer の初回を見る'), session('b', null, '21:50')), 0);
    expect(p.returning).toEqual([
      { sessionId: 'a', name: '会話 a', time: '13:30', reason: 'timer の初回を見る' },
      { sessionId: 'b', name: '会話 b', time: '21:50', reason: null },
    ]);
  });
  it('ストアに無いセッションと、時刻の無くなったセッションは出さない', () => {
    const state = { ...initialState(), returnToasts: ['gone', 'a'] };
    expect(presentToasts(state, storeOf(session('a', 'n', null)), 0).returning).toEqual([]);
  });
});

describe('ToastStack の戻る時刻の札', () => {
  const props = (over: Partial<ToastsProps> = {}): ToastsProps => ({ toasts: [], waiting: [], returning: [], more: 0, offerNotify: false, blocked: false, ...over });
  const card = { sessionId: 'a', name: '会話 a', time: '13:30', reason: 'timer の初回を見る' };
  it('見出しに名前と時刻、本文に理由を出し、押すとそのセッションを開く', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><ToastStack {...props({ returning: [card] })} /></IntentRoot>);
    const el = container.querySelector('.notice[data-kind="return"]')!;
    expect(el.querySelector('.notice-label')).toHaveTextContent('戻る時刻');
    expect(el.querySelector('.notice-who')).toHaveTextContent('会話 a');
    expect(el.querySelector('.notice-end')).toHaveTextContent('13:30');
    expect(el.querySelector('.notice-title')).toHaveTextContent('timer の初回を見る');
    fireEvent.click(screen.getByRole('button', { name: '会話 a を開く：timer の初回を見る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 'a' });
  });
  it('閉じるボタンで札だけを下げ、セッションは開かない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ToastStack {...props({ returning: [card] })} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '会話 a の知らせを閉じる' }));
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'return.toast.dismiss', id: 'a' });
  });
  it('理由が無ければ名前を本文に上げる。ダイアログが開いている間は開けない', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><ToastStack {...props({ returning: [{ ...card, reason: null }], blocked: true })} /></IntentRoot>);
    expect(container.querySelector('.notice-title')).toHaveTextContent('会話 a');
    expect(container.querySelector('.notice-who')).toBeNull();
    expect(screen.getByRole('button', { name: '会話 a を開く' })).toBeDisabled();
  });
});
