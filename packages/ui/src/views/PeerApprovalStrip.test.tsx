import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { translator, type PeerApprovalDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { presentPeerApprovals } from '../presenters/peerApprovals.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { PeerApprovalStrip } from './PeerApprovalStrip.tsx';

const dto = (o: Partial<PeerApprovalDto> = {}): PeerApprovalDto => ({ id: 'r1', from: 'ログイン修正', device: 'laptop', project: 'docs-site', scratch: false, ask: '目次の見出しを直して', expiresAt: Date.now() + 600_000, state: 'pending', ...o });
const t = translator('ja');
const mount = (list: PeerApprovalDto[], onAction = vi.fn()) => {
  const r = render(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><PeerApprovalStrip rows={presentPeerApprovals({ peerApprovals: list }, t)} /></ActionRoot></LanguageRoot>);
  return { onAction, ...r };
};

describe('別の PC への起動の承認の帯', () => {
  it('承認待ちが無ければ何も描かない', () => {
    expect(mount([]).container.querySelector('.peer-approvals')).toBeNull();
  });
  it('1 行目に 会話、PC 名の札、プロジェクト、2 行目に頼みの先頭、拒否と承認、下端の線を出す', () => {
    const { container } = mount([dto()]);
    expect(screen.getByText('ログイン修正')).toBeInTheDocument();
    expect(container.querySelector('.peer-approval-pc')).toHaveTextContent('laptop');
    expect(screen.getByText('docs-site')).toBeInTheDocument();
    expect(screen.getByText('「目次の見出しを直して」')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒否' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '承認' })).toBeInTheDocument();
    expect(container.querySelector('.peer-approval-bar')).not.toBeNull();
  });
  it('クイックセッションはプロジェクトの代わりに「クイック」を出す。会話が分からなければ矢印も出さない', () => {
    const { container } = mount([dto({ project: null, scratch: true, from: null })]);
    expect(screen.getByText('クイック')).toBeInTheDocument();
    expect(container.querySelector('.peer-approval-who')).toBeNull();
  });
  it('入力の焦点を奪わない', () => {
    mount([dto()]);
    expect(document.activeElement).toBe(document.body);
  });
  it('承認で答えを送り、続けて押せないようにする', () => {
    const { onAction } = mount([dto()]);
    fireEvent.click(screen.getByRole('button', { name: '承認' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'peerApproval.answer', id: 'r1', answer: 'approve' });
    expect(screen.getByRole('button', { name: '拒否' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '拒否' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
  it('拒否で拒否を送る', () => {
    const { onAction } = mount([dto()]);
    fireEvent.click(screen.getByRole('button', { name: '拒否' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'peerApproval.answer', id: 'r1', answer: 'reject' });
  });
  it.each([['approved', '承認しました'], ['denied', '拒否しました'], ['timeout', '時間切れ'], ['failed', '送れませんでした']] as const)('%s は結果に入れ替わり、ボタンと線を外す', (state, text) => {
    const { container } = mount([dto({ state })]);
    expect(screen.getByRole('status')).toHaveTextContent(text);
    expect(screen.queryByRole('button', { name: '承認' })).toBeNull();
    expect(container.querySelector('.peer-approval-bar')).toBeNull();
    expect(container.querySelector('.peer-approval')).toHaveAttribute('data-state', state);
  });
  it('線の長さは残りの時間で決める', () => {
    const { container } = mount([dto({ expiresAt: Date.now() + 120_000 })]);
    const ms = parseInt((container.querySelector('.peer-approval-bar') as HTMLElement).style.getPropertyValue('--drain'), 10);
    expect(ms).toBeGreaterThan(110_000);
    expect(ms).toBeLessThanOrEqual(120_000);
  });
});
