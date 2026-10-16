import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { translator, type ResumeHerePlanDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { presentResumeHere } from '../presenters/resumeHere.ts';
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
