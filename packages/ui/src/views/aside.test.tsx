import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import type { TerminalHost } from '../runtime/terminals.ts';
import { TerminalHostContext, TerminalPane } from './TerminalPane.tsx';

function fakeHost(): TerminalHost {
  return { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => null, fit: vi.fn(), focus: vi.fn(), paste: vi.fn(), zoom: vi.fn(), fontSize: () => 13, painted: () => true, subscribe: () => () => {}, dispose: vi.fn(), link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: false }), reconnect: vi.fn() } as unknown as TerminalHost;
}

// 本体は入力を受け付けていて、裏の作業だけが動いているときの見せ方。
describe('裏だけ動いている', () => {
  it('点は作業中の印のまま裏だけの印を足し、「バックグラウンドで作業中」と読み上げる', () => {
    const { container } = render(<StatusDot status="busy" aside />);
    const dot = container.querySelector('.dot')!;
    expect(dot).toHaveAttribute('data-status', 'busy');
    expect(dot).toHaveAttribute('data-aside', 'true');
    expect(screen.getByLabelText('バックグラウンドで作業中')).toHaveAttribute('title', 'バックグラウンドで作業中');
  });
  it('裏の印があっても、作業中でなければ足さない', () => {
    const { container } = render(<StatusDot status="waiting" aside />);
    expect(container.querySelector('.dot')).not.toHaveAttribute('data-aside');
    expect(screen.getByLabelText('入力待ち')).toBeInTheDocument();
  });
  it('端末の縁は裏だけの灯にする', () => {
    const { container } = render(<TerminalHostContext.Provider value={fakeHost()}><TerminalPane tabId="t1" hint={null} live="busy" aside /></TerminalHostContext.Provider>);
    expect(container.querySelector('.term-pane')).toHaveAttribute('data-live', 'aside');
  });
  it('停止の確認は、裏の作業も消えることを言う', () => {
    render(<ActionRoot onAction={() => {}}><ConfirmDialog confirm={{ kind: 'killRun', runId: 'r1', working: true, aside: true, shellTabs: 0 }} /></ActionRoot>);
    expect(screen.getByText('バックグラウンドで作業中です。停止すると、その作業も終了します。')).toBeInTheDocument();
  });
});
