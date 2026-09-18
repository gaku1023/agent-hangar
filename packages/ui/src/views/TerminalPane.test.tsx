import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalHost, type TerminalHost, type TerminalLike } from '../runtime/terminals.ts';
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
  it('タブを替えても枠の中のターミナルは 1 つだけ', () => {
    // 前のタブの要素が残ると、見えている端末と入力先がずれる。
    const host = domHost();
    const pane = (tabId: string) => <TerminalHostContext.Provider value={host}><TerminalPane tabId={tabId} status="connected" hint={null} /></TerminalHostContext.Provider>;
    const { rerender } = render(pane('a'));
    const termsIn = () => [...document.querySelectorAll('.term-pane [data-term]')].map((n) => n.getAttribute('data-term'));
    expect(termsIn()).toEqual(['1']);
    rerender(pane('b'));
    expect(termsIn()).toEqual(['2']);
    rerender(pane('a'));
    expect(termsIn()).toEqual(['1']);
  });
  it('Host が無ければ描くだけで落ちない', () => {
    render(<TerminalPane tabId="t1" status={null} hint={null} />);
    expect(document.querySelector('.term-host')).not.toBeNull();
  });
});

/** 実 DOM に要素を足す xterm の偽物を持つ本物の Host。data-term で何番目の端末かが分かる。 */
function domHost(): TerminalHost {
  let n = 0;
  return createTerminalHost({
    wsUrl: () => 'ws://x',
    wsFactory: () => ({ close() {} }) as unknown as WebSocket,
    createTerminal: () => {
      const node = document.createElement('div');
      node.dataset.term = String(++n);
      const t: TerminalLike = {
        cols: 80, rows: 24, element: null,
        open(el) { el.appendChild(node); t.element = node; },
        write() {}, onData: () => ({ dispose() {} }), onResize: () => ({ dispose() {} }),
        fit() {}, focus() {}, dispose() {},
      };
      return t;
    },
  });
}
