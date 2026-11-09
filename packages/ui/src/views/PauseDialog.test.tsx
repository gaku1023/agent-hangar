import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { PauseProps } from '../presenters/pause.ts';
import { PauseDialog } from './PauseDialog.tsx';

const props = (over: Partial<PauseProps> = {}): PauseProps => ({
  sessionId: 's1', sessionName: 'Worker の CPU 超過', from: 'menu', draft: '', candidateNote: null, initialReturnOn: '2026-10-02', initialReturnTime: '', candidateReturnTime: null, today: '2026-10-01', wake: null,
  choices: [
    { key: 'none', label: '日付なし', returnOn: null },
    { key: 'today', label: '今日の夕方', returnOn: '2026-10-01' }, { key: 'tomorrow', label: '明日', returnOn: '2026-10-02' },
    { key: 'monday', label: '月曜', returnOn: '2026-10-05' }, { key: 'nextWeek', label: '来週', returnOn: '2026-10-08' },
    { key: 'pick', label: '日付を選択…', returnOn: null },
  ],
  ...over,
});
const mount = (p: PauseProps = props(), onAction = vi.fn()) => {
  const r = render(<ActionRoot onAction={onAction}><PauseDialog {...p} /></ActionRoot>);
  return { onAction, unmount: r.unmount };
};
const radio = (name: RegExp) => screen.getByRole('radio', { name });
const submit = () => screen.getByRole('button', { name: 'Paused にする' });

describe('PauseDialog（B1）', () => {
  it('札を押すか 1〜5 で戻る日を選び、理由を添えて Paused にする', () => {
    const { onAction } = mount();
    expect(radio(/^明日/)).toHaveAttribute('aria-checked', 'true');
    // 開いたときのフォーカスは選んである札にあるので、数字がそのまま効く。
    expect(document.activeElement).toBe(radio(/^明日/));
    fireEvent.keyDown(document.activeElement!, { key: '4' });
    expect(radio(/^来週/)).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(radio(/^月曜/));
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '  本番の数字を見る ' } });
    fireEvent.click(submit());
    expect(onAction).toHaveBeenCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-05', note: '本番の数字を見る' });
  });
  // Review Focus 5：欄で打った数字は欄の文字。変換中の Enter は変換の確定。
  it('理由の欄で打った数字は札を切り替えず、変換中の Enter では送らない', () => {
    const { onAction } = mount();
    const input = screen.getByLabelText('理由');
    act(() => input.focus());
    fireEvent.keyDown(input, { key: '1' });
    expect(radio(/^明日/)).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(input, { target: { value: '確認' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-02', note: '確認' });
  });
  it('「日付を選択…」は日付の欄を出し、日を入れるまで送れない', () => {
    const { onAction } = mount();
    fireEvent.click(radio(/^日付を選択/));
    expect(submit()).toBeDisabled();
    const date = screen.getByLabelText('リマインダーの日付');
    expect(date).toHaveAttribute('min', '2026-10-01');
    fireEvent.change(date, { target: { value: '2026-10-20' } });
    expect(submit()).toBeEnabled();
    fireEvent.click(submit());
    expect(onAction).toHaveBeenCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-20' });
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
    expect(first.onAction).toHaveBeenLastCalledWith({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-05' });
    first.unmount();
    const second = mount(p);
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '月曜に CPU を見る' } });
    fireEvent.click(submit());
    expect(second.onAction).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-02', note: '月曜に CPU を見る' });
  });
  // Review Focus 4：字数は文字単位で数える。
  it('理由は文字単位で数え、絵文字の 200 字は送れて 201 字は送れない', () => {
    mount();
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '😀'.repeat(200) } });
    expect(screen.getByText('200 / 200 文字')).toBeInTheDocument();
    expect(submit()).toBeEnabled();
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '😀'.repeat(201) } });
    expect(submit()).toBeDisabled();
  });
  // 日付なし（2026-10-13）。札の並びの頭の枠だけの札で、打鍵は 0。選ぶと時刻の欄は押せなくなり、日も時刻も送らない。
  it('「日付なし」は 0 でも選べ、時刻の欄を押せなくして、日と時刻を付けずに送る。ほかの札の打鍵は変わらない', () => {
    const { onAction } = mount(props({ initialReturnTime: '10:00' }));
    fireEvent.keyDown(document.activeElement!, { key: '1' });
    expect(radio(/^今日の夕方/)).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(document.activeElement!, { key: '0' });
    expect(radio(/^日付なし/)).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('リマインダーの時刻（任意）')).toBeDisabled();
    expect(screen.getByText('日付なしの場合、ホームの「今日」には表示されません。一覧の Paused で確認できます')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: 'レビューの返事を待つ' } });
    fireEvent.click(submit());
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', note: 'レビューの返事を待つ' });
  });
  it('日付なしで開けば「日付なし」を選んでおき、日付なしの提案は変えずに送れば確定にする。日のある提案を日付なしにしたら手で選んだことにする', () => {
    const none = mount(props({ from: 'candidate', initialReturnOn: null, draft: '返事を待つ', candidateNote: '返事を待つ' }));
    expect(radio(/^日付なし/)).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(submit());
    expect(none.onAction).toHaveBeenLastCalledWith({ type: 'session.state.confirm', id: 's1' });
    none.unmount();
    const dated = mount(props({ from: 'candidate', draft: '返事を待つ', candidateNote: '返事を待つ' }));
    fireEvent.click(radio(/^日付なし/));
    fireEvent.click(submit());
    expect(dated.onAction).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', note: '返事を待つ' });
  });
  it('Esc と「キャンセル」で閉じる', () => {
    const { onAction } = mount();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.pause.close' });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  // #563 A4：提案は文のカードに「外す」。自分で選ぶときは点線の「＋」から。
  describe('起こす条件（A4）', () => {
    const SUGGESTED = { repo: 'acme/app', pr: 567, when: 'ci_done' } as const;
    const wake = (over: Partial<NonNullable<PauseProps['wake']>> = {}) => ({ suggested: SUGGESTED, repo: 'acme/app', pr: 567, ...over });
    const candidate = (w: PauseProps['wake']) => props({ from: 'candidate', draft: '直したら起こす', candidateNote: '直したら起こす', wake: w });

    it('shows the suggested wake card with remove', () => {
      mount(candidate(wake()));
      expect(screen.getByText('PR #567 の CI が終わったら')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '外す' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '＋ イベントで起こす' })).toBeNull();
    });
    it('keeping the suggestion sends wakeOn explicitly (confirm)', () => {
      const { onAction } = mount(candidate(wake()));
      fireEvent.click(submit());
      expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-02', wakeOn: SUGGESTED });
    });
    it('remove then confirm sends wakeOn null', () => {
      const { onAction } = mount(candidate(wake()));
      fireEvent.click(screen.getByRole('button', { name: '外す' }));
      fireEvent.click(submit());
      expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-02', wakeOn: null });
    });
    it('a removed card leaves the dashed add button behind', () => {
      mount(candidate(wake()));
      fireEvent.click(screen.getByRole('button', { name: '外す' }));
      expect(screen.queryByText('PR #567 の CI が終わったら')).toBeNull();
      expect(screen.getByRole('button', { name: '＋ イベントで起こす' })).toBeInTheDocument();
    });
    it('the card follows the condition chosen on it (w1 to w4)', () => {
      const { onAction } = mount(candidate(wake()));
      fireEvent.click(screen.getByRole('radio', { name: 'CI 失敗' }));
      expect(screen.getByText('PR #567 の CI が失敗したら')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('radio', { name: 'レビュー' }));
      expect(screen.getByText('PR #567 にレビューが付いたら')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('radio', { name: 'マージ' }));
      expect(screen.getByText('PR #567 がマージされたら')).toBeInTheDocument();
      fireEvent.click(submit());
      expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ wakeOn: { ...SUGGESTED, when: 'merged' } }));
    });
    it('plus opens pr and condition picker when nothing suggested', () => {
      const { onAction } = mount(props({ wake: wake({ suggested: null, repo: 'acme/app', pr: 570 }) }));
      expect(screen.queryByRole('radio', { name: 'CI 失敗' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '＋ イベントで起こす' }));
      expect(screen.getByLabelText('repo')).toHaveValue('acme/app');
      expect(screen.getByLabelText('PR')).toHaveValue('570');
      expect(screen.getByText('PR #570 の CI が終わったら')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('PR'), { target: { value: '571' } });
      fireEvent.click(screen.getByRole('radio', { name: 'マージ' }));
      fireEvent.click(submit());
      expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-02', wakeOn: { repo: 'acme/app', pr: 571, when: 'merged' } });
    });
    it('a picked card that is not a valid repo and PR blocks sending, and removing it unblocks', () => {
      mount(props({ wake: wake({ suggested: null, repo: '', pr: null }) }));
      fireEvent.click(screen.getByRole('button', { name: '＋ イベントで起こす' }));
      expect(submit()).toBeDisabled();
      fireEvent.change(screen.getByLabelText('repo'), { target: { value: 'acme/app' } });
      fireEvent.change(screen.getByLabelText('PR'), { target: { value: '12' } });
      expect(submit()).toBeEnabled();
      fireEvent.change(screen.getByLabelText('PR'), { target: { value: '0' } });
      expect(submit()).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: '外す' }));
      expect(submit()).toBeEnabled();
    });
    it('sends wakeOn null on set when the suggestion was removed', () => {
      const { onAction } = mount(props({ wake: wake() }));
      fireEvent.click(screen.getByRole('button', { name: '外す' }));
      fireEvent.click(submit());
      expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-02', wakeOn: null });
    });
    it('hidden without cloud', () => {
      const { onAction } = mount(candidate(null));
      expect(screen.queryByRole('button', { name: '＋ イベントで起こす' })).toBeNull();
      expect(screen.queryByRole('button', { name: '外す' })).toBeNull();
      fireEvent.click(submit());
      expect(onAction.mock.calls.at(-1)![0]).not.toHaveProperty('wakeOn');
    });
  });
});
