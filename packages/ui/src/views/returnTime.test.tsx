import { translator } from '@agent-hangar/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { presentHomeBand, type ReturnCard } from '../presenters/home.ts';
import type { PauseProps } from '../presenters/pause.ts';
import type { SessionRowProps } from '../presenters/row.ts';
import { HomeScreen } from './HomeScreen.tsx';
import { PauseDialog } from './PauseDialog.tsx';
import { SessionRows } from './SessionRows.tsx';

/** 戻る時刻（HH:MM）つきの Paused の見た目と入力。 */
const sr = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: '名前 ' + id, oneLiner: '要約 ' + id, projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-05 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });

describe('行の戻る時刻', () => {
  it('時刻を日の後ろに出し、塗るのは時刻を過ぎてからにする', () => {
    render(<ActionRoot onAction={vi.fn()}><SessionRows rows={[
      sr('a', { state: 'paused', returnOn: '2026-10-05', returnTime: '21:50', overdueDays: 0, returnDue: false }),
      sr('b', { state: 'paused', returnOn: '2026-10-05', returnTime: '11:30', overdueDays: 0, returnDue: true, returnPastMin: 30 }),
      sr('c', { state: 'paused', returnOn: '2026-10-06', returnTime: '13:30', overdueDays: null, returnDue: false }),
      sr('d', { state: 'paused', returnOn: '2026-10-05', returnTime: null, overdueDays: 0, returnDue: true }),
    ]} height={400} variant="project" /></ActionRoot>);
    // 当日でも時刻の前は、先の日と同じ文字だけの札にする。
    expect(screen.getByText('今日 21:50')).not.toHaveAttribute('data-due');
    // 時刻を過ぎたら、過ぎた長さを言う。時刻はポインタを乗せると読める。
    expect(screen.getByText('30 分過ぎ')).toHaveAttribute('data-due', 'true');
    expect(screen.getByText('30 分過ぎ')).toHaveAttribute('title', 'リマインダーの時刻 今日 11:30 · 最後の活動 3 分前');
    expect(screen.getByText('10/6 13:30')).not.toHaveAttribute('data-due');
    // 列が狭いので曜日は省き、ポインタを乗せると言い切る。
    expect(screen.getByText('10/6 13:30')).toHaveAttribute('title', 'リマインダーの時刻 10/6（火）13:30 · 最後の活動 3 分前');
    expect(screen.getByText('今日')).toHaveAttribute('data-due', 'true');
    // 時刻つきの札は、ポインタを乗せると戻る時点を言い切る。
    expect(screen.getByText('今日 21:50')).toHaveAttribute('title', 'リマインダーの時刻 今日 21:50 · 最後の活動 3 分前');
    expect(screen.getByText('今日')).toHaveAttribute('title', 'リマインダーの日付 · 最後の活動 3 分前');
  });
});

describe('ホームの帯の今日戻るの行の時刻', () => {
  const ja = translator('ja');
  const ret = (id: string, returnTime: string | null, due: boolean): ReturnCard => ({ id, name: `戻る ${id}`, projectName: 'agent-hangar', reason: `${id} を見る`, returnOn: '2026-10-05', returnTime, overdueDays: 0, due, pastMin: due && returnTime ? 30 : null });
  it('時刻を出し、時刻の前のものは塗らない', () => {
    const band = presentHomeBand({ attention: [], returning: [ret('timer', '11:30', true), ret('night', '21:50', false), ret('allday', null, true)], running: [], confirm: [] }, ja);
    const props = { band, idle: false, searching: false, list: { text: '', filter: {}, projects: [], rows: [], total: 0, loading: false, mode: 'all' as const, conditions: [], tabs: [], tab: 'all' as const, pager: null, statusColumn: true, tokens: [], hints: [], allCount: 0 }, allCount: 0, loadMore: null, note: null };
    const { container } = render(<ActionRoot onAction={vi.fn()}><HomeScreen {...props} /></ActionRoot>);
    const when = [...container.querySelectorAll('.drawer .return-when')];
    expect(when.map((w) => [w.textContent, w.getAttribute('data-due')])).toEqual([['30 分過ぎ', 'true'], ['今日 21:50', null], ['今日', 'true']]);
  });
});

describe('PauseDialog の時刻', () => {
  const props = (over: Partial<PauseProps> = {}): PauseProps => ({
    sessionId: 's1', sessionName: 'timer の確認', from: 'menu', draft: '', candidateNote: null, initialReturnOn: '2026-10-02', initialReturnTime: '', candidateReturnTime: null, today: '2026-10-01',
    choices: [
      { key: 'today', label: '今日の夕方', returnOn: '2026-10-01' }, { key: 'tomorrow', label: '明日', returnOn: '2026-10-02' },
      { key: 'monday', label: '月曜', returnOn: '2026-10-05' }, { key: 'nextWeek', label: '来週', returnOn: '2026-10-08' },
      { key: 'pick', label: '日付を選択…', returnOn: null },
    ],
    ...over,
  });
  const mount = (p: PauseProps) => {
    const onAction = vi.fn();
    const r = render(<ActionRoot onAction={onAction}><PauseDialog {...p} /></ActionRoot>);
    return { onAction, unmount: r.unmount };
  };
  const submit = () => screen.getByRole('button', { name: 'Paused にする' });
  const time = () => screen.getByLabelText('リマインダーの時刻（任意）');

  it('時刻の欄は空で始まり、入れると戻る時刻として送る。空のままなら送らない', () => {
    const { onAction } = mount(props());
    expect(time()).toHaveValue('');
    expect(time()).toHaveAttribute('type', 'time');
    fireEvent.click(submit());
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-02' });
    fireEvent.change(time(), { target: { value: '13:30' } });
    fireEvent.click(submit());
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-02', returnTime: '13:30' });
  });
  it('時刻の欄で打った数字は札を切り替えない', () => {
    mount(props());
    fireEvent.keyDown(time(), { key: '4' });
    expect(screen.getByRole('radio', { name: /^明日/ })).toHaveAttribute('aria-checked', 'true');
  });
  it('今の時刻を入れて開き、消せば時刻なしに戻せる', () => {
    const { onAction } = mount(props({ initialReturnTime: '21:50' }));
    expect(time()).toHaveValue('21:50');
    fireEvent.change(time(), { target: { value: '' } });
    fireEvent.click(submit());
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-02' });
  });
  it('提案から開いて理由を変えずに送ると、確定に日と時刻を添える', () => {
    const p = props({ from: 'candidate', draft: 'timer を見る', candidateNote: 'timer を見る', initialReturnTime: '09:00', candidateReturnTime: '09:00' });
    const { onAction } = mount(p);
    fireEvent.click(submit());
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-02', returnTime: '09:00' });
    fireEvent.change(time(), { target: { value: '' } });
    fireEvent.click(submit());
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-02' });
  });
});
