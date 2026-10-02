import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeMotionTokens } from '../test/motion.ts';
import { createTerminalHost, type TerminalHost, type TerminalLike } from '../runtime/terminals.ts';
import { TerminalHostContext, TerminalPane } from './TerminalPane.tsx';
import { LAYOUT_MOVING_ATTR, LAYOUT_SETTLED } from './primitives/layoutMotion.ts';

type FakeHost = TerminalHost & { mount: ReturnType<typeof vi.fn> };

function fakeHost(): FakeHost {
  return { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => null, fit: vi.fn(), focus: vi.fn(), paste: vi.fn(), zoom: vi.fn(), fontSize: () => 13, painted: () => true, subscribe: () => () => {}, dispose: vi.fn(), link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: false }), reconnect: vi.fn() } as FakeHost;
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
  it('最初のデータが届くまで、端末の面は data-painted="false" で透明にしておく', () => {
    const host = { ...fakeHost(), painted: () => false };
    render(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" hint={null} live={null} /></TerminalHostContext.Provider>);
    expect(document.querySelector('.term-host')).toHaveAttribute('data-painted', 'false');
  });
  it('描けているタブには data-painted を付けない', () => {
    render(<TerminalHostContext.Provider value={fakeHost()}><TerminalPane tabId="t1" hint={null} live={null} /></TerminalHostContext.Provider>);
    expect(document.querySelector('.term-host')).not.toHaveAttribute('data-painted');
  });
  it('案内が消えたら、動かない環境ではすぐ外す', () => {
    const host = fakeHost();
    const { rerender } = render(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" hint="待っています" live={null} /></TerminalHostContext.Provider>);
    rerender(<TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" hint={null} live={null} /></TerminalHostContext.Provider>);
    expect(screen.queryByRole('status')).toBeNull();
  });
  describe('帯の出入り（動く環境）', () => {
    let restore = () => {};
    afterEach(() => { restore(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations; });
    const install = () => {
      restore = fakeMotionTokens(undefined, { everywhere: true });
      let resolve!: () => void;
      const finished = new Promise<void>((r) => { resolve = r; });
      const calls: Keyframe[][] = [];
      (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (f: Keyframe[]) { calls.push(f); return { finished, cancel: vi.fn() }; };
      return { resolve, calls };
    };
    const pane = (host: TerminalHost, hint: string | null, transcript: { when: string; onLatest: () => void } | null = null) => <TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" agent hint={hint} live={null} transcript={transcript} /></TerminalHostContext.Provider>;
    it('案内が消えるときは、畳み終わるまで描き続け、その間は寸法を合わせず、終わったら外す', async () => {
      const { resolve, calls } = install();
      const host = fakeHost();
      const { rerender } = render(pane(host, '待っています'));
      rerender(pane(host, null));
      expect(calls).toHaveLength(1);
      expect(screen.getByText('待っています')).toBeInTheDocument();
      // 出ている間は読み上げの通知にしない。
      expect(screen.queryByRole('status')).toBeNull();
      expect(document.querySelector('.term-pane')).toHaveAttribute(LAYOUT_MOVING_ATTR);
      await act(async () => { resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(screen.queryByText('待っています')).toBeNull();
      expect(document.querySelector('.term-pane')).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
    });
    it('出る途中で案内が戻ったら、取り消された畳みの後始末では印が外れず、伸び直しが終わってから外れる', async () => {
      restore = fakeMotionTokens(undefined, { everywhere: true });
      const anims: { resolve: () => void; reject: () => void }[] = [];
      const live: { cancel: () => void }[] = [];
      (HTMLElement.prototype as unknown as { animate: unknown }).animate = function () {
        let resolve!: () => void; let reject!: () => void;
        const finished = new Promise<void>((res, rej) => { resolve = res; reject = () => rej(new Error('cancelled')); });
        const i = anims.push({ resolve, reject }) - 1;
        const a = { finished, cancel: () => anims[i]!.reject() };
        live.push(a);
        return a;
      };
      // usePresence は戻ったときに部分木の動きを取り消す。jsdom に getAnimations は無いので、作った動きを返す。
      (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = () => live;
      const host = fakeHost();
      const { rerender } = render(pane(host, '待っています'));
      rerender(pane(host, null));
      rerender(pane(host, '待っています'));
      // 畳みが取り消され、伸び直しが始まっている。
      expect(anims).toHaveLength(2);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(document.querySelector('.term-pane')).toHaveAttribute(LAYOUT_MOVING_ATTR);
      await act(async () => { anims[1]!.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(document.querySelector('.term-pane')).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
    });
    it('transcript の帯が消えるときは、畳む間も「いつのターンか」を読み続ける', async () => {
      const { resolve } = install();
      const host = fakeHost();
      const { rerender } = render(pane(host, null, { when: '10:30', onLatest: () => {} }));
      rerender(pane(host, null, null));
      const band = document.querySelector('.term-band')!;
      expect(band).toHaveTextContent('10:30 のターン');
      expect(band).toHaveAttribute('aria-hidden', 'true');
      await act(async () => { resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(document.querySelector('.term-band')).toBeNull();
    });
    it('案内が後から出るときは伸ばして入れ、最初の描画では動かさない', () => {
      const { calls } = install();
      const host = fakeHost();
      const first = render(pane(host, '待っています'));
      expect(calls).toHaveLength(0);
      first.unmount();
      const { rerender } = render(pane(host, null));
      rerender(pane(host, '待っています'));
      expect(calls).toHaveLength(1);
      expect(document.querySelector('.term-pane')).toHaveAttribute(LAYOUT_MOVING_ATTR);
    });
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
