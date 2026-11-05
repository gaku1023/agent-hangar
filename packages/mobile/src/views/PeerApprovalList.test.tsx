// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskError } from '../ask.ts';
import { peerApprovalRowsOf, type PeerApprovalRow } from '../inbox.ts';
import type { Keyring, Pairing } from '../store.ts';
import { PeerApprovalList } from './PeerApprovalList.tsx';

afterEach(cleanup);

const NOW = 1_000_000;
const row = (o: Partial<PeerApprovalRow> = {}): PeerApprovalRow => ({ id: 'r1', from: 'ログイン修正', device: 'laptop', project: 'docs-site', ask: '目次の見出しを直して', expiresAt: NOW + 60_000, deviceId: 'pc', alive: true, ...o });
const show = (rows: PeerApprovalRow[], ask: Parameters<typeof PeerApprovalList>[0]['ask'], onAnswered = vi.fn()) =>
  render(<PeerApprovalList rows={rows} now={NOW} pairing={{} as Pairing} keys={new Map() as unknown as Keyring} ask={ask} onAnswered={onAnswered} />);

describe('スマホの起動の承認（別の PC）', () => {
  it('承認待ちが無ければ何も描かない。期限を過ぎた行も出さない', () => {
    expect(show([], vi.fn()).container.firstChild).toBeNull();
    cleanup();
    expect(show([row({ expiresAt: NOW })], vi.fn()).container.firstChild).toBeNull();
  });
  it('会話、PC、プロジェクト、頼みの先頭を出す。プロジェクトが無ければクイック', () => {
    show([row(), row({ id: 'r2', project: null, from: null })], vi.fn());
    expect(screen.getByText('ログイン修正 → laptop docs-site')).toBeTruthy();
    expect(screen.getByText('laptop クイック')).toBeTruthy();
    expect(screen.getAllByText('「目次の見出しを直して」')).toHaveLength(2);
  });
  it('承認で peer-approval の approve を送り、読み直す', async () => {
    const ask = vi.fn(async () => ({ approval: 'done' as const })); const onAnswered = vi.fn();
    show([row()], ask, onAnswered);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '承認' })); });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1', deviceId: 'pc' }), 'approve');
    expect(onAnswered).toHaveBeenCalled();
  });
  it('断るで reject を送る', async () => {
    const ask = vi.fn(async () => ({ approval: 'done' as const }));
    show([row()], ask);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '断る' })); });
    expect(ask).toHaveBeenCalledWith(expect.anything(), 'reject');
  });
  it('送れなかったときは理由を出して残す', async () => {
    const ask = vi.fn(async () => ({ approval: 'failed' as const }));
    show([row()], ask);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '承認' })); });
    expect(screen.getByText('送れませんでした')).toBeTruthy();
  });
  it('PC が見えないときは押せない。送ってみて通じなければ消えたことにしない', async () => {
    show([row({ alive: false })], vi.fn());
    expect(screen.getByText('PC につながっていません')).toBeTruthy();
    expect((screen.getByRole('button', { name: '承認' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const ask = vi.fn(async () => { throw new AskError('pc-offline', 503); }); const onAnswered = vi.fn();
    show([row()], ask, onAnswered);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '承認' })); });
    expect(screen.getByText('PC につながっていません')).toBeTruthy();
    expect(onAnswered).not.toHaveBeenCalled();
  });
  it('PC から来た形の違う行は捨てる', () => {
    const rows = peerApprovalRowsOf([{ id: 'ok', device: 'laptop', expiresAt: 5, ask: 'x' }, { id: 3 }, null, { id: 'x', device: 'a', expiresAt: 'soon' }], 'pc', true);
    expect(rows).toEqual([{ id: 'ok', device: 'laptop', expiresAt: 5, ask: 'x', from: null, project: null, deviceId: 'pc', alive: true }]);
    expect(peerApprovalRowsOf('nope', 'pc', true)).toEqual([]);
  });
});
