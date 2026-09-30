import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalHost, type TerminalHost, type TerminalLike } from '../runtime/terminals.ts';
import { TerminalHostContext, TerminalPane } from './TerminalPane.tsx';
import { LAYOUT_SETTLED, MOVING_ATTR } from './primitives/sidebarMotion.ts';

type FakeHost = TerminalHost & { mount: ReturnType<typeof vi.fn> };

function fakeHost(): FakeHost {
  return { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => null, fit: vi.fn(), focus: vi.fn(), paste: vi.fn(), subscribe: () => () => {}, dispose: vi.fn() } as FakeHost;
}

describe('TerminalPane', () => {
  it('マウント先の要素を Host に渡し、案内と状態を出す', () => {
    const host = fakeHost();
    const { rerender } = render(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" status="connected" hint="待っています" live={null} /></TerminalHostContext.Provider>);
    expect(host.mount).toHaveBeenCalledTimes(1);
    expect(host.mount.mock.calls[0]![0]).toBe('t1');
    expect((host.mount.mock.calls[0]![1] as HTMLElement).dataset.tab).toBe('t1');
    expect(screen.getByRole('status')).toHaveTextContent('待っています');
    rerender(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t2" status="closed" hint={null} live={null} /></TerminalHostContext.Provider>);
    expect(host.mount).toHaveBeenCalledTimes(2);
    expect(screen.getByText('接続していません')).toBeInTheDocument();
  });
  it('タブを替えても枠の中のターミナルは 1 つだけ', () => {
    // 前のタブの要素が残ると、見えている端末と入力先がずれる。
    const host = domHost();
    const pane = (tabId: string) => <TerminalHostContext.Provider value={host}><TerminalPane tabId={tabId} status="connected" hint={null} live={null} /></TerminalHostContext.Provider>;
    const { rerender } = render(pane('a'));
    const termsIn = () => [...document.querySelectorAll('.term-pane [data-term]')].map((n) => n.getAttribute('data-term'));
    expect(termsIn()).toEqual(['1']);
    rerender(pane('b'));
    expect(termsIn()).toEqual(['2']);
    rerender(pane('a'));
    expect(termsIn()).toEqual(['1']);
  });
  // サイドバーの開閉の間は本文の幅が毎コマ変わる。そのたびに合わせ直すと、端末の寸法をサーバへ送り続ける。
  it('サイドバーが動いている間は寸法を合わせず、止まったら一度だけ合わせる', () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} });
    const host = fakeHost();
    render(<div className="shell"><TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" status="connected" hint={null} live={null} /></TerminalHostContext.Provider></div>);
    const shell = document.querySelector<HTMLElement>('.shell')!;
    shell.setAttribute(MOVING_ATTR, '');
    observers[0]!();
    expect(host.fit).not.toHaveBeenCalled();
    shell.removeAttribute(MOVING_ATTR);
    window.dispatchEvent(new Event(LAYOUT_SETTLED));
    expect(host.fit).toHaveBeenCalledTimes(1);
    observers[0]!();
    expect(host.fit).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
  it('Host が無ければ描くだけで落ちない', () => {
    render(<TerminalPane tabId="t1" status={null} hint={null} live={null} />);
    expect(document.querySelector('.term-host')).not.toBeNull();
  });
  it('セッションの状態を縁の印にする。状態が無ければ終了として灯さない', () => {
    const host = fakeHost();
    const pane = (live: 'busy' | 'waiting' | 'idle' | null) => <TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" status="connected" hint={null} live={live} /></TerminalHostContext.Provider>;
    const { rerender, container } = render(pane('busy'));
    const mark = () => container.querySelector('.term-pane')!.getAttribute('data-live');
    expect(mark()).toBe('busy');
    rerender(pane('waiting'));
    expect(mark()).toBe('waiting');
    rerender(pane('idle'));
    expect(mark()).toBe('idle');
    rerender(pane(null));
    expect(mark()).toBe('ended');
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
        fit() {}, focus() {}, dispose() {}, setGpu() {}, paste() {},
      };
      return t;
    },
  });
}
