import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { translator, type ScheduleDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { nextLabel, presentSchedules, whenLabel } from '../presenters/schedules.ts';
import { SchedulesScreen } from './SchedulesScreen.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const t = translator('ja');
const NOW = new Date(2026, 10, 2, 8, 0).getTime();
const dto = (o: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id: 'a', prompt: '依存を点検して', spec: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, target: { kind: 'new', projectId: 'p' },
  projectId: 'p', projectName: 'alpha', sessionTitle: null, enabled: true, nextAt: new Date(2026, 10, 2, 9, 0).getTime(),
  runs: [
    { id: 'r2', plannedAt: 2, startedAt: NOW - 60_000, endedAt: null, result: 'running', sessionId: 's2', sessionTitle: '点検 2', error: null },
    { id: 'r1', plannedAt: 1, startedAt: NOW - 3_600_000, endedAt: NOW - 3_600_000, result: 'skipped', sessionId: null, sessionTitle: null, error: null },
  ], ...o,
});
const mount = (list: ScheduleDto[]) => {
  const onAction = vi.fn();
  const props = presentSchedules({ schedules: list, projects: { p: { id: 'p', name: 'alpha', status: 'active' } } as never, sessions: { s: { id: 's', projectId: 'p', name: '既存の会話A', lastTurnAt: 1 } } as never, settings: null as never }, t, NOW);
  render(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><SchedulesScreen {...props} /></ActionRoot></LanguageRoot>);
  return onAction;
};

describe('予定の言い方', () => {
  it('繰り返しと次の時刻', () => {
    expect(whenLabel(t, { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' })).toBe('平日 9:00');
    expect(whenLabel(t, { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '18:30' })).toBe('毎日 18:30');
    expect(whenLabel(t, { kind: 'weekly', days: [0, 1], time: '08:00' })).toBe('月・日 8:00');
    expect(whenLabel(t, { kind: 'every', minutes: 30 })).toBe('30 分おき');
    expect(nextLabel(t, new Date(2026, 10, 2, 9, 5).getTime(), NOW)).toBe('今日 9:05');
    expect(nextLabel(t, new Date(2026, 10, 3, 9, 5).getTime(), NOW)).toBe('明日 9:05');
    expect(nextLabel(t, null, NOW)).toBe('');
  });
});

describe('予定の画面', () => {
  it('行に指示、繰り返し、次の時刻、直近の丸を出す', () => {
    mount([dto()]);
    expect(screen.getByRole('button', { name: '依存を点検して' })).toBeInTheDocument();
    expect(screen.getByText('平日 9:00')).toBeInTheDocument();
    expect(screen.getByText('今日 9:00')).toBeInTheDocument();
    expect(document.querySelectorAll('.sch-dots .sch-dot')).toHaveLength(2);
  });

  it('予定が無ければ空の案内を出す', () => {
    mount([]);
    expect(screen.getByText(t('schedules.list.empty'))).toBeInTheDocument();
  });

  it('スイッチで止める。行は開かない', () => {
    const onAction = mount([dto()]);
    fireEvent.click(screen.getByRole('switch'));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'schedule.update', id: 'a', patch: { enabled: false } }));
    expect(screen.queryByRole('button', { name: t('schedules.action.run') })).toBeNull();
  });

  it('行を開くと履歴と操作が出て、今すぐ実行を送る', () => {
    const onAction = mount([dto()]);
    fireEvent.click(screen.getByRole('button', { name: '依存を点検して' }));
    expect(screen.getByRole('link', { name: '点検 2' })).toBeInTheDocument();
    expect(screen.getByText(t('schedules.result.skipped'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.run') }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'schedule.run', id: 'a' }));
  });

  it('削除はもう一度押して確かめる', async () => {
    const onAction = mount([dto()]);
    fireEvent.click(screen.getByRole('button', { name: '依存を点検して' }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.delete') }));
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'schedule.delete' }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.deleteConfirm') }));
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'schedule.delete', id: 'a' })));
  });

  it('作成は指示が無いと押せず、入れれば送る', () => {
    const onAction = mount([]);
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.new') }));
    const create = screen.getByRole('button', { name: t('schedules.form.create') });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.form.prompt') }), { target: { value: '見て' } });
    fireEvent.click(create);
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'schedule.create',
      input: { prompt: '見て', spec: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, target: { kind: 'new', projectId: 'p' } },
    }));
  });

  it('既存の会話へ、N 分おきで作れる。下限より短いと押せない', () => {
    const onAction = mount([]);
    fireEvent.click(screen.getByRole('button', { name: t('schedules.action.new') }));
    fireEvent.change(screen.getByRole('textbox', { name: t('schedules.form.prompt') }), { target: { value: '見て' } });
    fireEvent.click(screen.getByRole('radio', { name: t('schedules.form.kind.every') }));
    fireEvent.click(screen.getByRole('radio', { name: t('schedules.form.dest.session') }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: t('schedules.form.create') })).toBeDisabled();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.create') }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ input: { prompt: '見て', spec: { kind: 'every', minutes: 45 }, target: { kind: 'session', sessionId: 's' } } }));
  });

  it('流れ終わった 1 回だけの予定は再開できない', () => {
    mount([dto({ spec: { kind: 'once', at: NOW - 1 }, enabled: false, nextAt: null, runs: [] })]);
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});
