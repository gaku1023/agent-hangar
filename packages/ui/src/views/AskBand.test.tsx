import { act, fireEvent, render, screen } from '@testing-library/react';
import type { UiAction } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { LocalAskBandProps } from '../presenters/localAsk.ts';
import type { AskCardModel } from '../presenters/peerChat.ts';
import { AskBand, ASK_SETTLE_MS } from './AskBand.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const row = (over: Partial<AskCardModel> = {}): AskCardModel => ({
  askId: 'a1', askKind: 'permission', title: '許可', header: null, input: 'ls -la',
  options: [{ key: 'once', label: '1 回だけ許可', description: 'この実行だけを許可します。' }, { key: 'deny', label: '許可せず中断' }], multi: false, allowText: false,
  secret: false, textKind: null, min: null, max: null, answered: null, hostOnly: null, pending: false, locked: false, ...over,
});
const band = (over: Partial<AskCardModel> = {}): LocalAskBandProps => ({ sessionId: 's1', row: row(over) });

function mount(ask: LocalAskBandProps | null) {
  const onAction = vi.fn<(i: UiAction) => void>();
  const ui = (a: LocalAskBandProps | null) => <LanguageRoot language="ja"><ActionRoot onAction={onAction}><AskBand ask={a} /></ActionRoot></LanguageRoot>;
  const r = render(ui(ask));
  return { onAction, ...r, update: (a: LocalAskBandProps | null) => r.rerender(ui(a)) };
}

describe('AskBand（本文の真上の札）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('札が無ければ何も描かない', () => {
    expect(mount(null).container.querySelector('.ask-band')).toBeNull();
  });

  it('選択肢を押すと、会話の id と札の id と鍵で ask.answer を送る', () => {
    const { onAction } = mount(band());
    fireEvent.click(screen.getByRole('button', { name: /1 回だけ許可/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'ask.answer', sessionId: 's1', askId: 'a1', keys: ['once'] });
  });

  it('自由入力の文は text に載せる', () => {
    const { onAction } = mount(band({ askKind: 'question', options: [], allowText: true }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'はい' } });
    fireEvent.click(screen.getByRole('button', { name: '答える' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'ask.answer', sessionId: 's1', askId: 'a1', keys: [], text: 'はい' });
  });

  it('答えられない札は「ターミナルを開く」だけで、押すとターミナルのセッションを開く', () => {
    const { onAction } = mount(band({ hostOnly: '答えられません', options: [] }));
    expect(screen.queryByRole('button', { name: /1 回だけ許可/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ターミナルを開く' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 's1', focus: 'terminal' });
  });

  it('答えの記録を出したら、しばらくして ask.settle を送る', () => {
    const { onAction } = mount(band({ answered: 'Mac で 1 回だけ許可' }));
    expect(screen.getByText('Mac で 1 回だけ許可')).toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(ASK_SETTLE_MS); });
    expect(onAction).toHaveBeenCalledWith({ type: 'ask.settle', sessionId: 's1' });
  });

  it('答えの記録が出る前に札が替われば、片付けの時計を止める', () => {
    const { onAction, update } = mount(band({ answered: 'x' }));
    update(band({ askId: 'a2' }));
    act(() => { vi.advanceTimersByTime(ASK_SETTLE_MS * 2); });
    expect(onAction).not.toHaveBeenCalled();
  });
});
