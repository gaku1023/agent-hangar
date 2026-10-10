import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { PauseProps } from '../presenters/pause.ts';
import { PauseDialog } from './PauseDialog.tsx';

const props = (over: Partial<PauseProps> = {}): PauseProps => ({
  sessionId: 's1', sessionName: 'Worker の CPU 超過', from: 'menu', draft: '', candidateNote: null, initialReturnOn: '2026-10-02', initialReturnTime: '', candidateReturnTime: null, today: '2026-10-01',
  choices: [
    { key: 'today', label: '今日の夕方', returnOn: '2026-10-01' }, { key: 'tomorrow', label: '明日', returnOn: '2026-10-02' },
    { key: 'monday', label: '月曜', returnOn: '2026-10-05' }, { key: 'nextWeek', label: '来週', returnOn: '2026-10-08' },
    { key: 'pick', label: '日付を選択…', returnOn: null },
  ],
  ...over,
});
const mount = (p: PauseProps = props(), onIntent = vi.fn()) => {
  const r = render(<IntentRoot onIntent={onIntent}><PauseDialog {...p} /></IntentRoot>);
  return { onIntent, unmount: r.unmount };
};
const radio = (name: RegExp) => screen.getByRole('radio', { name });
const submit = () => screen.getByRole('button', { name: 'Paused にする' });

describe('PauseDialog（B1）', () => {
  it('札を押すか 1〜5 で戻る日を選び、理由を添えて Paused にする', () => {
    const { onIntent } = mount();
    expect(radio(/^明日/)).toHaveAttribute('aria-checked', 'true');
    // 開いたときのフォーカスは選んである札にあるので、数字がそのまま効く。
    expect(document.activeElement).toBe(radio(/^明日/));
    fireEvent.keyDown(document.activeElement!, { key: '4' });
    expect(radio(/^来週/)).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(radio(/^月曜/));
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '  本番の数字を見る ' } });
    fireEvent.click(submit());
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-05', note: '本番の数字を見る' });
  });
  // Review Focus 5：欄で打った数字は欄の文字。変換中の Enter は変換の確定。
  it('理由の欄で打った数字は札を切り替えず、変換中の Enter では送らない', () => {
    const { onIntent } = mount();
    const input = screen.getByLabelText('理由');
    act(() => input.focus());
    fireEvent.keyDown(input, { key: '1' });
    expect(radio(/^明日/)).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(input, { target: { value: '確認' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-02', note: '確認' });
  });
  it('「日付を選択…」は日付の欄を出し、日を入れるまで送れない', () => {
    const { onIntent } = mount();
    fireEvent.click(radio(/^日付を選択/));
    expect(submit()).toBeDisabled();
    const date = screen.getByLabelText('リマインダーの日付');
    expect(date).toHaveAttribute('min', '2026-10-01');
    fireEvent.change(date, { target: { value: '2026-10-20' } });
    expect(submit()).toBeEnabled();
    fireEvent.click(submit());
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-20' });
  });
  it('札に無い日で開いたら「日付を選択…」にその日を入れておく', () => {
    mount(props({ initialReturnOn: '2026-10-20' }));
    expect(radio(/^日付を選択/)).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('リマインダーの日付')).toHaveValue('2026-10-20');
  });
  it('提案から開くと根拠が下書きに入り、変えずに送れば提案の確定に日を添える。変えたら手で選んだことにする', () => {
    const p = props({ from: 'candidate', draft: '明日の朝、CPU の数字を確かめる', candidateNote: '明日の朝、CPU の数字を確かめる' });
    const first = mount(p);
    expect(screen.getByText('提案')).toBeInTheDocument();
    expect(screen.getByLabelText('理由')).toHaveValue('明日の朝、CPU の数字を確かめる');
    fireEvent.click(radio(/^月曜/));
    fireEvent.click(submit());
    expect(first.onIntent).toHaveBeenLastCalledWith({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-05' });
    first.unmount();
    const second = mount(p);
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '月曜に CPU を見る' } });
    fireEvent.click(submit());
    expect(second.onIntent).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-02', note: '月曜に CPU を見る' });
  });
  // Review Focus 4：字数は文字単位で数える。
  it('理由は文字単位で数え、絵文字の 200 字は送れて 201 字は送れない', () => {
    mount();
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '😀'.repeat(200) } });
    expect(screen.getByText('200 / 200 字')).toBeInTheDocument();
    expect(submit()).toBeEnabled();
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '😀'.repeat(201) } });
    expect(submit()).toBeDisabled();
  });
  it('Esc と「キャンセル」で閉じる', () => {
    const { onIntent } = mount();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.pause.close' });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onIntent).toHaveBeenCalledTimes(2);
  });
});
