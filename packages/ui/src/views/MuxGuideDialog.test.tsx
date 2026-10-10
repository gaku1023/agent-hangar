import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { MuxStatus } from '../presenters/readiness.ts';
import { MuxGuideDialog } from './MuxGuideDialog.tsx';

// セッションを始めようとしたときの案内（段 6 の B2）。
const missing: MuxStatus = { name: 'psmux', windows: true, installed: false, version: null, path: null, command: 'winget install marlocarlo.psmux', checking: false, stillMissing: false };
const ui = (mux: MuxStatus, onAction = vi.fn()) => render(<ActionRoot onAction={onAction}><MuxGuideDialog mux={mux} /></ActionRoot>);

describe('MuxGuideDialog', () => {
  it('無いときは、要ることと入れるコマンドを出し、再確認とキャンセルを置く', () => {
    const onAction = vi.fn();
    ui(missing, onAction);
    expect(screen.getByRole('dialog', { name: 'セッションを開始するには psmux が必要です' })).toBeInTheDocument();
    expect(screen.getByText('Windows では psmux が tmux の代わりにセッションを保持します。PowerShell で次のコマンドを実行してください')).toBeInTheDocument();
    expect(screen.getByText('winget install marlocarlo.psmux')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /コピー/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'インストールしたので再確認' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'mux.recheck' });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('macOS では tmux の名で、brew のコマンドを出す', () => {
    ui({ ...missing, name: 'tmux', windows: false, command: 'brew install tmux' });
    expect(screen.getByRole('dialog', { name: 'セッションを開始するには tmux が必要です' })).toBeInTheDocument();
    expect(screen.getByText('brew install tmux')).toBeInTheDocument();
  });
  it('確かめている間は再確認を押せず、まだ無ければ再起動が要るかもしれないと添える', () => {
    const { unmount } = ui({ ...missing, checking: true });
    expect(screen.getByRole('button', { name: '確認中…' })).toBeDisabled();
    unmount();
    ui({ ...missing, stillMissing: true });
    expect(screen.getByText('psmux がまだ見つかりません。インストールしたあと、Hangar の再起動が必要な場合があります')).toBeInTheDocument();
  });
  it('見つかったら版を出し、開始で止めていた操作を進める', () => {
    const onAction = vi.fn();
    ui({ ...missing, installed: true, version: '3.3.1', path: 'C:\\x\\psmux.exe' }, onAction);
    expect(screen.getByRole('dialog', { name: 'psmux を確認しました' })).toBeInTheDocument();
    expect(screen.getByText('バージョン 3.3.1 が見つかりました。セッションを開始します')).toBeInTheDocument();
    expect(screen.queryByText('winget install marlocarlo.psmux')).toBeNull();
    const start = screen.getByRole('button', { name: '開始' });
    expect(start).toHaveFocus();
    fireEvent.click(start);
    expect(onAction).toHaveBeenCalledWith({ type: 'mux.guide.proceed' });
  });
});
