import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalHost, type TerminalHost, type TerminalLike } from '../runtime/terminals.ts';
import { TerminalHostContext, TerminalPane } from './TerminalPane.tsx';
import { LAYOUT_MOVING_ATTR, LAYOUT_SETTLED } from './primitives/layoutMotion.ts';

type FakeHost = TerminalHost & { mount: ReturnType<typeof vi.fn> };

function fakeHost(): FakeHost {
  return { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => null, fit: vi.fn(), focus: vi.fn(), paste: vi.fn(), zoom: vi.fn(), fontSize: () => 13, subscribe: () => () => {}, dispose: vi.fn(), link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: false }), reconnect: vi.fn() } as FakeHost;
}

describe('TerminalPane', () => {
  it('マウント先の要素を Host に渡し、案内と状態を出す', () => {
    // 接続の様子は枠ごとに Host から読む。
    const host = { ...fakeHost(), status: (id: string) => (id === 't2' ? 'closed' as const : 'connected' as const) };
    const { rerender } = render(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" hint="待っています" live={null} /></TerminalHostContext.Provider>);
    expect(host.mount).toHaveBeenCalledTimes(1);
    expect(host.mount.mock.calls[0]![0]).toBe('t1');
    expect((host.mount.mock.calls[0]![1] as HTMLElement).dataset.tab).toBe('t1');
    expect(screen.getByRole('status')).toHaveTextContent('待っています');
    rerender(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t2" hint={null} live={null} /></TerminalHostContext.Provider>);
    expect(host.mount).toHaveBeenCalledTimes(2);
    expect(screen.getByText('接続していません')).toBeInTheDocument();
  });
  it('タブを替えても枠の中のターミナルは 1 つだけ', () => {
    // 前のタブの要素が残ると、見えている端末と入力先がずれる。
    const host = domHost();
    const pane = (tabId: string) => <TerminalHostContext.Provider value={host}><TerminalPane tabId={tabId} hint={null} live={null} /></TerminalHostContext.Provider>;
    const { rerender } = render(pane('a'));
    const termsIn = () => [...document.querySelectorAll('.term-pane [data-term]')].map((n) => n.getAttribute('data-term'));
    expect(termsIn()).toEqual(['1']);
    rerender(pane('b'));
    expect(termsIn()).toEqual(['2']);
    rerender(pane('a'));
    expect(termsIn()).toEqual(['1']);
  });
  // サイドバーの開閉の間は本文の幅が毎コマ変わる。そのたびに合わせ直すと、端末の寸法をサーバへ送り続ける。
  it('左右の欄が動いている間は寸法を合わせず、止まったら一度だけ合わせる', () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} });
    const host = fakeHost();
    render(<div className="shell"><TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" hint={null} live={null} /></TerminalHostContext.Provider></div>);
    const shell = document.querySelector<HTMLElement>('.shell')!;
    shell.setAttribute(LAYOUT_MOVING_ATTR, '');
    observers[0]!();
    expect(host.fit).not.toHaveBeenCalled();
    shell.removeAttribute(LAYOUT_MOVING_ATTR);
    window.dispatchEvent(new Event(LAYOUT_SETTLED));
    expect(host.fit).toHaveBeenCalledTimes(1);
    observers[0]!();
    expect(host.fit).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
  it('思いがけず切れたら、中央のカードで言い、次に試すまでの秒数と再接続を出す', () => {
    const reconnect = vi.fn();
    const at = Date.now() + 4200;
    const host = { ...fakeHost(), reconnect, status: () => 'closed' as const, link: () => ({ retryAt: at, dropped: true, gaveUp: false, detached: false }) };
    const { container, rerender } = render(<TerminalHostContext.Provider value={host}><TerminalPane tabId="r1" agent hint={null} live="busy" /></TerminalHostContext.Provider>);
    expect(screen.getByText('ターミナルとの接続が切れました')).toBeInTheDocument();
    expect(screen.getByText('Claude は動き続けています。5 秒後にもう一度つなぎます。')).toBeInTheDocument();
    // 板は暗く沈め、縁の灯も消す。
    expect(container.querySelector('.term-pane')).toHaveAttribute('data-off', 'true');
    fireEvent.click(screen.getByRole('button', { name: '再接続' }));
    expect(reconnect).toHaveBeenCalledWith('r1');
    // つなぎ直している間は秒ではなく、そうしていると言う。
    const trying = { ...host, status: () => 'connecting' as const, link: () => ({ retryAt: null, dropped: true, gaveUp: false, detached: false }) };
    rerender(<TerminalHostContext.Provider value={trying}><TerminalPane tabId="r1" agent hint={null} live="busy" /></TerminalHostContext.Provider>);
    expect(screen.getByText('Claude は動き続けています。つなぎ直しています。')).toBeInTheDocument();
  });
  it('切れた印が残っていても、つながっている間はカードを出さない', () => {
    // つながった瞬間に Host が知らせる前の 1 コマでも、つながっている端末を覆わない。
    const host = { ...fakeHost(), status: () => 'connected' as const, link: () => ({ retryAt: null, dropped: true, gaveUp: false, detached: true }) };
    const { container } = render(<TerminalHostContext.Provider value={host}><TerminalPane tabId="r1" agent hint={null} live="busy" /></TerminalHostContext.Provider>);
    expect(screen.queryByRole('button', { name: /再接続|つなぎ直す/ })).toBeNull();
    expect(container.querySelector('.term-pane')).not.toHaveAttribute('data-off');
  });
  it('何度試してもつながらなかったら、動き続けているとは言わず、手動の再接続に任せる', () => {
    const reconnect = vi.fn();
    const host = { ...fakeHost(), reconnect, status: () => 'closed' as const, link: () => ({ retryAt: null, dropped: true, gaveUp: true, detached: false }) };
    render(<TerminalHostContext.Provider value={host}><TerminalPane tabId="r1" agent hint={null} live="busy" /></TerminalHostContext.Provider>);
    expect(screen.getByText('つなげませんでした。')).toBeInTheDocument();
    expect(screen.queryByText(/動き続けています/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '再接続' }));
    expect(reconnect).toHaveBeenCalledWith('r1');
  });
  it('tmux から抜けて閉じたが run が生きているときは、カードに「つなぎ直す」を出す', () => {
    const reconnect = vi.fn();
    const host = { ...fakeHost(), reconnect, status: () => 'closed' as const, link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: true }) };
    const { container } = render(<TerminalHostContext.Provider value={host}><TerminalPane tabId="r1" agent hint={null} live="busy" /></TerminalHostContext.Provider>);
    expect(screen.getByText('ターミナルから切り離されました')).toBeInTheDocument();
    expect(screen.getByText('Claude は動き続けています。')).toBeInTheDocument();
    expect(container.querySelector('.term-pane')).toHaveAttribute('data-off', 'true');
    expect(screen.queryByText('接続していません')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'つなぎ直す' }));
    expect(reconnect).toHaveBeenCalledWith('r1');
  });
  it('サーバが断ったときもカードで言い、再接続を出す。最初のつなぎ中と、自分で切った後はカードを出さない', () => {
    const host = { ...fakeHost(), status: () => 'error' as const };
    const { rerender } = render(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" hint={null} live={null} /></TerminalHostContext.Provider>);
    expect(screen.getByText('ターミナルに接続できませんでした')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再接続' })).toBeInTheDocument();
    rerender(<TerminalHostContext.Provider value={{ ...host, status: () => 'connecting' as const }}><TerminalPane tabId="t1" hint={null} live={null} /></TerminalHostContext.Provider>);
    expect(screen.queryByRole('button', { name: '再接続' })).toBeNull();
    expect(screen.getByText('接続しています')).toBeInTheDocument();
  });
  it('Host が無ければ描くだけで落ちない', () => {
    render(<TerminalPane tabId="t1" hint={null} live={null} />);
    expect(document.querySelector('.term-host')).not.toBeNull();
  });
  it('セッションの状態を縁の印にする。状態が無ければ終了として灯さない', () => {
    const host = fakeHost();
    const pane = (live: 'busy' | 'waiting' | 'idle' | null) => <TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" hint={null} live={live} /></TerminalHostContext.Provider>;
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
        fit() {}, focus() {}, dispose() {}, setGpu() {}, paste() {}, setFontSize() {},
      };
      return t;
    },
  });
}
