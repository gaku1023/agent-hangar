import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalHost } from '../runtime/terminals.ts';
import { TerminalHostContext, TerminalPane } from './TerminalPane.tsx';

type FakeHost = TerminalHost & { mount: ReturnType<typeof vi.fn> };

function fakeHost(): FakeHost {
  return { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => null, fit: vi.fn(), focus: vi.fn(), subscribe: () => () => {}, dispose: vi.fn() } as FakeHost;
}

describe('TerminalPane', () => {
  it('マウント先の要素を Host に渡し、案内と状態を出す', () => {
    const host = fakeHost();
    const { rerender } = render(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" status="connected" hint="待っています" /></TerminalHostContext.Provider>);
    expect(host.mount).toHaveBeenCalledTimes(1);
    expect(host.mount.mock.calls[0]![0]).toBe('t1');
    expect((host.mount.mock.calls[0]![1] as HTMLElement).dataset.tab).toBe('t1');
    expect(screen.getByRole('status')).toHaveTextContent('待っています');
    rerender(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t2" status="closed" hint={null} /></TerminalHostContext.Provider>);
    expect(host.mount).toHaveBeenCalledTimes(2);
    expect(screen.getByText('接続していません')).toBeInTheDocument();
  });
  it('Host が無ければ描くだけで落ちない', () => {
    render(<TerminalPane tabId="t1" status={null} hint={null} />);
    expect(document.querySelector('.term-host')).not.toBeNull();
  });
});
