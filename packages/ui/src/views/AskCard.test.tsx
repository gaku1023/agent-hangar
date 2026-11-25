import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AskCardModel } from '../presenters/peerChat.ts';
import { AskCard } from './AskCard.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const model = (over: Partial<AskCardModel> = {}): AskCardModel => ({
  askId: 'a1', askKind: 'question', title: '質問', header: null, input: null,
  options: [], multi: false, allowText: true, secret: false, textKind: null, min: null, max: null,
  answered: null, hostOnly: null, pending: false, locked: false, ...over,
});
function mount(row: AskCardModel, extra: { onOpenTerminal?: () => void } = {}) {
  const onAnswer = vi.fn();
  const r = render(<LanguageRoot language="ja"><AskCard row={row} onAnswer={onAnswer} {...extra} /></LanguageRoot>);
  return { onAnswer, ...r, update: (next: AskCardModel) => r.rerender(<LanguageRoot language="ja"><AskCard row={next} onAnswer={onAnswer} {...extra} /></LanguageRoot>) };
}

describe('AskCard（札の部品）', () => {
  it('header は問いの上に出す', () => {
    const { container } = mount(model({ header: 'API キー', input: 'キーを入れてください' }));
    const head = container.querySelector('.pchat-ask-header')!;
    expect(head).toHaveTextContent('API キー');
    expect(head.compareDocumentPosition(container.querySelector('.pchat-ask-input')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('header が無ければ見出しの行を出さない', () => {
    expect(mount(model()).container.querySelector('.pchat-ask-header')).toBeNull();
  });

  it('secret の欄は password にして、答えは text で送る', () => {
    const { onAnswer } = mount(model({ secret: true }));
    const input = screen.getByLabelText('他の答えを書く') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    fireEvent.change(input, { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByRole('button', { name: '答える' }));
    expect(onAnswer).toHaveBeenCalledWith('a1', [], 'sk-1');
  });

  it('secret でない欄は text のまま', () => {
    mount(model());
    expect((screen.getByLabelText('他の答えを書く') as HTMLInputElement).type).toBe('text');
  });

  it('integer の欄は、合わない入力では送れない（Enter でも送れない）', () => {
    const { onAnswer } = mount(model({ textKind: 'integer', min: 1, max: 5 }));
    const input = screen.getByLabelText('他の答えを書く') as HTMLInputElement;
    const send = screen.getByRole('button', { name: '答える' });
    for (const bad of ['abc', '2.5', '0', '6']) {
      fireEvent.change(input, { target: { value: bad } });
      expect(send, bad).toBeDisabled();
      expect(input, bad).toHaveAttribute('aria-invalid', 'true');
      fireEvent.keyDown(input, { key: 'Enter' });
    }
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '3' } });
    expect(send).toBeEnabled();
    expect(input).not.toHaveAttribute('aria-invalid');
    fireEvent.click(send);
    expect(onAnswer).toHaveBeenCalledWith('a1', [], '3');
  });

  it('number の欄は小数を通し、範囲の外は送れない', () => {
    mount(model({ textKind: 'number', min: 0, max: 1 }));
    const input = screen.getByLabelText('他の答えを書く');
    fireEvent.change(input, { target: { value: '0.25' } });
    expect(screen.getByRole('button', { name: '答える' })).toBeEnabled();
    fireEvent.change(input, { target: { value: '1.5' } });
    expect(screen.getByRole('button', { name: '答える' })).toBeDisabled();
  });

  it('答えられない札は、openTerminal を渡すと選択肢を出さず「端末を開く」ボタンを出す', () => {
    const onOpenTerminal = vi.fn();
    const { container } = mount(model({ askKind: 'permission', options: [{ key: 'once', label: '1 回だけ許可' }], allowText: false, hostOnly: '案内' }), { onOpenTerminal });
    expect(container.querySelector('.pchat-opt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '端末を開く' }));
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.pchat-ask-hostonly')).toBeNull();
  });

  it('答えられない札は、openTerminal が無ければ今の案内の一行のまま', () => {
    const { container } = mount(model({ allowText: false, hostOnly: 'Mac の画面で答えると進みます' }));
    expect(container.querySelector('.pchat-ask-hostonly')).toHaveTextContent('Mac の画面で答えると進みます');
    expect(screen.queryByRole('button', { name: '端末を開く' })).toBeNull();
  });

  it('答えると選択肢が閉じ、答えの記録が出る', async () => {
    const { container, update } = mount(model({ askKind: 'permission', options: [{ key: 'once', label: '1 回だけ許可', description: 'この実行だけ' }], allowText: false }));
    expect(container.querySelector('.pchat-opt-desc')).toHaveTextContent('この実行だけ');
    update(model({ askKind: 'permission', options: [{ key: 'once', label: '1 回だけ許可' }], allowText: false, answered: 'Mac で許可' }));
    expect(container.querySelector('.pchat-ans')).toHaveTextContent('Mac で許可');
    expect(container.querySelector('.pchat-ask')).toHaveAttribute('data-done', 'true');
    await waitFor(() => expect(container.querySelector('.pchat-opt')).toBeNull());
  });
});
