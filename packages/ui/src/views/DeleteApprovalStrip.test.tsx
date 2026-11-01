import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DeleteApprovalDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { presentDeleteApprovals } from '../presenters/deleteApprovals.ts';
import { translator } from '@agent-hangar/shared';
import { DeleteApprovalStrip } from './DeleteApprovalStrip.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const dto = (o: Partial<DeleteApprovalDto> = {}): DeleteApprovalDto => ({ id: 'a1', sessionId: 's1', title: '古い試し', project: 'alpha', turns: 7, from: '片付け役', requestedAt: 1, failure: null, ...o });
const t = translator('ja');
const mount = (list: DeleteApprovalDto[], onAction = vi.fn()) => {
  const r = render(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><DeleteApprovalStrip rows={presentDeleteApprovals({ deleteApprovals: list }, t)} /></ActionRoot></LanguageRoot>);
  return { onAction, ...r };
};

describe('削除の承認の帯', () => {
  it('依頼が無ければ何も描かない', () => {
    expect(mount([]).container.querySelector('.del-approvals')).toBeNull();
  });
  it('題名、事実、依頼元と、残すとゴミ箱へ移動を出す', () => {
    mount([dto()]);
    expect(screen.getByText('「古い試し」を削除しますか？')).toBeInTheDocument();
    expect(screen.getByText('alpha・7 ターン')).toBeInTheDocument();
    expect(screen.getByText('片付け役 より')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '残す' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ゴミ箱へ移動' })).toBeInTheDocument();
  });
  it('プロジェクトと依頼元が無くても崩れない', () => {
    mount([dto({ project: null, from: null })]);
    expect(screen.getByText('7 ターン')).toBeInTheDocument();
    expect(screen.queryByText(/より/)).toBeNull();
  });
  it('入力の焦点を奪わない', () => {
    mount([dto()]);
    expect(document.activeElement).toBe(document.body);
  });
  it('ゴミ箱へ移動で承認を送り、移動中に替わる', () => {
    const { onAction } = mount([dto()]);
    fireEvent.click(screen.getByRole('button', { name: 'ゴミ箱へ移動' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'deleteApproval.answer', id: 'a1', answer: 'approve' });
    expect(screen.getByText('ゴミ箱へ移動中…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ゴミ箱へ移動' })).toBeNull();
  });
  it('残すで断りを送る', () => {
    const { onAction } = mount([dto()]);
    fireEvent.click(screen.getByRole('button', { name: '残す' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'deleteApproval.answer', id: 'a1', answer: 'reject' });
  });
  it('消せなかった行は理由と閉じるだけを出す', () => {
    const { onAction } = mount([dto({ failure: 'running' })]);
    expect(screen.getByText('実行中のため消せませんでした')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ゴミ箱へ移動' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'deleteApproval.answer', id: 'a1', answer: 'dismiss' });
  });
});
