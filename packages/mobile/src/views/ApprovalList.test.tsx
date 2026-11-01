// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskError } from '../ask.ts';
import { approvalRowsOf, type ApprovalRow } from '../inbox.ts';
import type { Keyring, Pairing } from '../store.ts';
import { ApprovalList } from './ApprovalList.tsx';

afterEach(cleanup);

const row = (o: Partial<ApprovalRow> = {}): ApprovalRow => ({ id: 'a1', sessionId: 's1', title: '古い試し', project: 'alpha', turns: 7, from: '片付け役', failure: null, deviceId: 'pc', alive: true, ...o });
const show = (rows: ApprovalRow[], ask: Parameters<typeof ApprovalList>[0]['ask'], onAnswered = vi.fn()) =>
  render(<ApprovalList rows={rows} pairing={{} as Pairing} keys={new Map() as unknown as Keyring} ask={ask} onAnswered={onAnswered} />);

describe('スマホの削除の承認', () => {
  it('依頼が無ければ何も描かない', () => {
    const { container } = show([], vi.fn());
    expect(container.firstChild).toBeNull();
  });
  it('題名、事実、依頼元を出す', () => {
    show([row()], vi.fn());
    expect(screen.getByText('「古い試し」を削除しますか？')).toBeTruthy();
    expect(screen.getByText('alpha・7 ターン')).toBeTruthy();
    expect(screen.getByText('片付け役 より')).toBeTruthy();
  });
  it('ゴミ箱へ移動で approve を送り、読み直す', async () => {
    const ask = vi.fn(async () => ({ approval: 'done' as const })); const onAnswered = vi.fn();
    show([row()], ask, onAnswered);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ゴミ箱へ移動' })); });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), 'approve');
    expect(onAnswered).toHaveBeenCalled();
  });
  it('残すで reject を送る', async () => {
    const ask = vi.fn(async () => ({ approval: 'done' as const }));
    show([row()], ask);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '残す' })); });
    expect(ask).toHaveBeenCalledWith(expect.anything(), 'reject');
  });
  it('消せなかったときは理由と閉じるを出す', async () => {
    const ask = vi.fn(async () => ({ approval: 'failed' as const }));
    show([row()], ask);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ゴミ箱へ移動' })); });
    expect(screen.getByText('実行中のため消せませんでした')).toBeTruthy();
    expect(screen.getByRole('button', { name: '閉じる' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ゴミ箱へ移動' })).toBeNull();
  });
  it('PC が見えないときは押せない', () => {
    show([row({ alive: false })], vi.fn());
    expect(screen.getByText('PC につながっていません')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'ゴミ箱へ移動' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '残す' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('送ってみて PC につながらなければ、消えたことにせず PC なしを出す', async () => {
    const ask = vi.fn(async () => { throw new AskError('pc-offline', 503); }); const onAnswered = vi.fn();
    show([row()], ask, onAnswered);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ゴミ箱へ移動' })); });
    expect(screen.getByText('PC につながっていません')).toBeTruthy();
    expect(onAnswered).not.toHaveBeenCalled();
  });
  it('PC から来た形の違う行は捨てる', () => {
    expect(approvalRowsOf([{ id: 1 }, null, { id: 'a', sessionId: 's', title: 't', failure: 'x', turns: 'n' }], 'pc', true)).toEqual([{ id: 'a', sessionId: 's', title: 't', project: null, turns: 0, from: null, failure: null, deviceId: 'pc', alive: true }]);
    expect(approvalRowsOf('nope', 'pc', true)).toEqual([]);
  });
});
