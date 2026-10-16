import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TAKEOVER_TIMEOUT_MS, translator, type ResumeHerePlanDto, type TakeoverDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { presentResumeHere, presentTakeover } from '../presenters/resumeHere.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';

const NOW = new Date(2026, 9, 16, 12, 0).getTime();
const plan = (lock: ResumeHerePlanDto['lock']): ResumeHerePlanDto => ({
  sessionId: 's1',
  from: { deviceName: 'pc-b', platform: 'win32', path: 'D:\\src\\notes-app', lastAt: NOW - 3_600_000 },
  to: { deviceName: 'pc-a', platform: 'darwin', path: '/Users/me/src/notes-app' },
  replace: null,
  lock,
});
const mount = (p: ResumeHerePlanDto) => {
  const onAction = vi.fn();
  render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={{ kind: 'resumeHere', sessionId: 's1', plan: p }} resumeHere={presentResumeHere(translator('ja'), p, '/Users/me', NOW)} /></ActionRoot>);
  return onAction;
};

describe('ほかの PC で動いている会話を引き継ぐ確認', () => {
  it('takeover の 1 枚は赤みの帯を出し、承諾で session.takeover.start（force: false）を送る', () => {
    const onAction = mount(plan({ deviceName: 'pc-b', stale: false, working: false, heartbeatAt: NOW - 10_000 }));
    expect(screen.getByRole('dialog', { name: 'ほかの PC で実行中の会話を、この PC で引き継ぎますか' })).toBeInTheDocument();
    const note = screen.getByRole('note', { name: /pc-b で実行中です/ });
    expect(note).toHaveTextContent('引き継ぐと、pc-b の claude を停止してから、この PC で再開します。');
    // 黄の帯は残る。
    expect(screen.getAllByRole('note')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '停止して引き継ぐ' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.takeover.start', id: 's1', force: false });
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.resumeHere' }));
  });
  it('作業中の相手は作業中の帯を出す', () => {
    mount(plan({ deviceName: 'pc-b', stale: false, working: true, heartbeatAt: NOW - 10_000 }));
    expect(screen.getByRole('note', { name: /pc-b で作業中です/ })).toHaveTextContent('停止するとそのターンは途中で切れます。');
  });
  it('stale の 1 枚は赤みの帯なしで、最後の応答を出し、承諾は force: true', () => {
    const onAction = mount(plan({ deviceName: 'pc-b', stale: true, working: false, heartbeatAt: NOW - 5 * 60_000 }));
    expect(screen.getByRole('dialog', { name: 'pc-b が応答していません。この PC で引き継ぎますか' })).toHaveTextContent('最後の応答：5 分前');
    expect(screen.getAllByRole('note')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'このまま引き継ぐ' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.takeover.start', id: 's1', force: true });
  });
  it('ロックが無ければ今までどおり session.resumeHere を送る', () => {
    const onAction = mount(plan(null));
    fireEvent.click(screen.getByRole('button', { name: 'この PC で再開' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.resumeHere', id: 's1' });
  });
});

describe('引き継ぎの待ちと返事がないとき', () => {
  const START = 1_700_000_000_000;
  const p = plan({ deviceName: 'pc-b', stale: false, working: false, heartbeatAt: START });
  const dto = (stage: TakeoverDto['stage']): TakeoverDto => ({ sessionId: 's1', deviceName: 'pc-b', stage, startedAt: START, deadline: START + TAKEOVER_TIMEOUT_MS });
  const mountTakeover = (stage: TakeoverDto['stage'] | null) => {
    const onAction = vi.fn();
    const d = stage === null ? null : dto(stage);
    render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={{ kind: 'takeover', sessionId: 's1', plan: p, takeover: d }} takeover={presentTakeover(translator('ja'), p, d)} /></ActionRoot>);
    return onAction;
  };
  afterEach(() => { vi.useRealTimers(); });

  it('待っている間は 4 つの段と、経過秒、細い線、取り消すだけのボタンを出す', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(START + 12_000);
    const onAction = mountTakeover('waiting');
    expect(screen.getByRole('dialog', { name: 'pc-b から引き継いでいます' })).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['done', 'active', 'todo', 'todo']);
    expect(items[1]).toHaveTextContent('pc-b が停止するのを待っています');
    expect(items[1]).toHaveTextContent('12 秒');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(Math.round((12_000 / TAKEOVER_TIMEOUT_MS) * 100)));
    expect(screen.getByText('pc-b の Hangar がクラウドを見に来るまで、最大 30 秒ほどかかります。')).toBeInTheDocument();
    expect(screen.getAllByRole('button').filter((b) => b.textContent === '取り消す')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'もう少し待つ' })).toBeNull();
    // 1 秒ごとに描き直す。
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(screen.getAllByRole('listitem')[1]).toHaveTextContent('15 秒');
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.takeover.cancel', id: 's1' });
  });
  it('頼む前の応答待ち（null）も、1 段目が進行中の同じ 1 枚', () => {
    mountTakeover(null);
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('data-state'))).toEqual(['active', 'todo', 'todo', 'todo']);
  });
  it('待っている間の Esc と外側のクリックは、閉じずに取り下げを送る', () => {
    const onAction = mountTakeover('waiting');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.takeover.cancel', id: 's1' });
    expect(onAction).not.toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('返事がない 1 枚は 3 つのボタンを出し、それぞれの UiAction を送る', () => {
    const onAction = mountTakeover('timeout');
    expect(screen.getByRole('dialog', { name: 'pc-b から返事がありません' })).toBeInTheDocument();
    expect(screen.getByRole('note', { name: 'このまま引き継ぐと、会話が分かれることがあります' })).toHaveTextContent('次に pc-b で Hangar が起動したときに停止します。');
    expect(screen.queryByRole('listitem')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));
    fireEvent.click(screen.getByRole('button', { name: 'もう少し待つ' }));
    fireEvent.click(screen.getByRole('button', { name: 'このまま引き継ぐ' }));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([
      { type: 'session.takeover.cancel', id: 's1' },
      { type: 'session.takeover.extend', id: 's1' },
      { type: 'session.takeover.start', id: 's1', force: true },
    ]);
  });
  it('返事がない 1 枚の Esc も取り下げを送る', () => {
    const onAction = mountTakeover('timeout');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.takeover.cancel', id: 's1' });
  });
});
