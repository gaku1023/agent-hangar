import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalHost } from '../runtime/terminals.ts';
import type { OverlayTerm } from '../runtime/termOverlay.ts';
import { TermTranslations } from './TermTranslate.tsx';
import { TranslateContext, type TranslateApi } from './translateMsg.tsx';

const A = 'The build passed on all five jobs, and the branch is ready to merge now.';
const LINES = ['⏺ The build passed on all five jobs, and the branch is', '  ready to merge now.', '', '❯ '];

function setup(opts: { api: TranslateApi | null; cached?: string }) {
  const decos: { el: HTMLElement; disposed: boolean }[] = [];
  const term: OverlayTerm = {
    cols: 60,
    lines: () => LINES,
    mark: (line) => ({ line, isDisposed: false, dispose() {} }),
    decorate() {
      const d = { el: document.createElement('div'), disposed: false };
      document.body.appendChild(d.el);
      decos.push(d);
      return { get isDisposed() { return d.disposed; }, onRender(cb) { queueMicrotask(() => cb(d.el)); return { dispose() {} }; }, dispose() { d.disposed = true; d.el.remove(); } };
    },
    onChange: () => ({ dispose() {} }),
  };
  const host = { overlay: () => term, subscribe: () => () => {}, fontSize: () => 13 } as unknown as TerminalHost;
  const view = render(<TranslateContext.Provider value={opts.api}><TermTranslations host={host} tabId="t1" replies={[A]} /></TranslateContext.Provider>);
  return { decos, view };
}

function deferred() {
  let resolve!: (v: string | null) => void;
  const promise = new Promise<string | null>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('TermTranslations', () => {
  it('返答の行に板を付け、訳を待つ間は光を流し、届いたら訳を載せる。アイコンでその返答だけ原文に戻す', async () => {
    const wait = deferred();
    const api: TranslateApi = { cached: () => null, translate: vi.fn(() => wait.promise) };
    const { decos } = setup({ api });
    await act(async () => { await Promise.resolve(); });
    expect(decos.length).toBe(1);
    const board = decos[0]!.el.querySelector<HTMLElement>('.term-tr')!;
    expect(board.dataset.translating).toBe('true');
    expect(api.translate).toHaveBeenCalledWith(A);
    await act(async () => { wait.resolve('ビルドは 5 つのジョブすべてで通りました。'); await wait.promise; });
    expect(board.dataset.translating).toBeUndefined();
    expect(board.textContent).toContain('ビルドは 5 つのジョブすべてで通りました。');
    const toggle = board.querySelector<HTMLButtonElement>('.term-tr-toggle')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // xterm に押し下げを渡さない（tmux のマウスの操作や選択にならない）。
    const down = new MouseEvent('mousedown', { bubbles: true });
    const parent = vi.fn();
    decos[0]!.el.addEventListener('mousedown', parent);
    toggle.dispatchEvent(down);
    expect(parent).not.toHaveBeenCalled();
    await act(async () => { toggle.click(); });
    expect(board.dataset.orig).toBe('true');
    expect(board.textContent).not.toContain('ビルド');
    await act(async () => { toggle.click(); });
    expect(board.textContent).toContain('ビルド');
  });

  it('覚えている訳はすぐに載せ、頼み直さない', async () => {
    const api: TranslateApi = { cached: (t) => (t === A ? '覚えている訳です。' : null), translate: vi.fn(async () => null) };
    const { decos } = setup({ api });
    await act(async () => { await Promise.resolve(); });
    expect(decos[0]!.el.textContent).toContain('覚えている訳です。');
    expect(api.translate).not.toHaveBeenCalled();
  });

  it('訳せなかったら板に何も載せず、英語のまま見せる', async () => {
    const api: TranslateApi = { cached: () => null, translate: vi.fn(async () => null) };
    const { decos } = setup({ api });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(decos[0]!.el.querySelector('.term-tr')).toBeNull();
  });

  it('設定が切（api が null）なら板を付けない', async () => {
    const { decos } = setup({ api: null });
    await act(async () => { await Promise.resolve(); });
    expect(decos.length).toBe(0);
  });

  it('外したら板も外す', async () => {
    const api: TranslateApi = { cached: () => '訳', translate: vi.fn(async () => '訳') };
    const { decos, view } = setup({ api });
    await act(async () => { await Promise.resolve(); });
    view.unmount();
    expect(decos[0]!.disposed).toBe(true);
  });
});
