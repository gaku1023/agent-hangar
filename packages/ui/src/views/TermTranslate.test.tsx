import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalHost } from '../runtime/terminals.ts';
import type { RewriteTerm } from '../runtime/termRewrite.ts';
import { TermTranslations } from './TermTranslate.tsx';
import { TranslateContext, type TranslateApi } from './translateMsg.tsx';

const A = 'The build passed on all five jobs, and the branch is ready to merge now.';
const LINES = ['⏺ The build passed on all five jobs, and the branch is', '  ready to merge now.', '', '❯ '];

/** 行の文字だけを持つ偽物の端末。英語の本当の画面（影）は変えず、paint は見えている行の x 桁目から右を書き換える。 */
function setup(opts: { api: TranslateApi | null }) {
  let lines = [...LINES];
  const decos: { el: HTMLElement; disposed: boolean }[] = [];
  const term: RewriteTerm = {
    cols: 60,
    lines: () => LINES,
    cellsFrom: (line, x) => (lines[line] ?? '').slice(x).trimEnd(),
    cellsRange: (line, x0, x1) => (lines[line] ?? '').slice(x0, x1),
    width: (s) => Array.from(s).length,
    shades: (_line, x0, x1) => Array<string>(x1 - x0).fill(''),
    style: () => ({ sgr: '', rgb: null }),
    snapshot: (line, x) => (LINES[line] ?? '').slice(x),
    paint(x, rows) {
      lines = [...lines];
      for (const r of rows) lines[r.line] = `${(lines[r.line] ?? '').slice(0, x)}${r.seq}`.trimEnd();
      return true;
    },
    mark: (line) => ({ line, isDisposed: false, dispose() {} }),
    decorate(_marker, box) {
      // 訳を待つ段落の光は数えない（アイコンの板だけを見る）。
      if (box.glow) return { isDisposed: false, onRender() { return { dispose() {} }; }, dispose() {} };
      const d = { el: document.createElement('div'), disposed: false };
      document.body.appendChild(d.el);
      decos.push(d);
      return { get isDisposed() { return d.disposed; }, onRender(cb) { queueMicrotask(() => cb(d.el)); return { dispose() {} }; }, dispose() { d.disposed = true; d.el.remove(); } };
    },
    setCopyMap() {},
    onChange: () => ({ dispose() {} }),
  };
  const host = { rewrite: () => term, subscribe: () => () => {}, fontSize: () => 13 } as unknown as TerminalHost;
  const view = render(<TranslateContext.Provider value={opts.api}><TermTranslations host={host} tabId="t1" replies={[A]} /></TranslateContext.Provider>);
  return { decos, view, lines: () => lines };
}

function deferred() {
  let resolve!: (v: string | null) => void;
  const promise = new Promise<string | null>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('TermTranslations', () => {
  it('訳を待つ間はアイコンを押せず、届いたら返答のマスを訳で上書きする。アイコンでその返答だけ原文に戻す', async () => {
    const wait = deferred();
    const api: TranslateApi = { cached: () => null, translate: vi.fn(() => wait.promise) };
    const { decos, lines } = setup({ api });
    await act(async () => { await Promise.resolve(); });
    expect(decos.length).toBe(1);
    const toggle = () => decos.at(-1)!.el.querySelector<HTMLButtonElement>('.term-tr-toggle')!;
    expect(toggle().dataset.state).toBe('wait');
    expect(toggle().disabled).toBe(true);
    expect(api.translate).toHaveBeenCalledWith(A);
    await act(async () => { wait.resolve('ビルドは 5 つのジョブすべてで通りました。'); await wait.promise; await new Promise((r) => setTimeout(r, 0)); });
    expect(lines()[0]).toBe('⏺ ビルドは 5 つのジョブすべてで通りました。');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    // xterm に押し下げを渡さない（tmux のマウスの操作や選択にならない）。
    const parent = vi.fn();
    decos.at(-1)!.el.addEventListener('mousedown', parent);
    toggle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(parent).not.toHaveBeenCalled();
    await act(async () => { toggle().click(); });
    expect(lines()[0]).toBe('⏺ The build passed on all five jobs, and the branch is');
    expect(toggle().dataset.state).toBe('orig');
    await act(async () => { toggle().click(); });
    expect(lines()[0]).toContain('ビルド');
  });

  it('覚えている訳はすぐに書き、頼み直さない', async () => {
    const api: TranslateApi = { cached: (t) => (t === A ? '覚えている訳です。' : null), translate: vi.fn(async () => null) };
    const { lines } = setup({ api });
    await act(async () => { await Promise.resolve(); });
    expect(lines()[0]).toBe('⏺ 覚えている訳です。');
    expect(api.translate).not.toHaveBeenCalled();
  });

  it('設定が切（api が null）なら何もしない', async () => {
    const { decos, lines } = setup({ api: null });
    await act(async () => { await Promise.resolve(); });
    expect(decos.length).toBe(0);
    expect(lines()).toEqual(LINES);
  });

  it('外したら英語に戻し、アイコンも外す', async () => {
    const api: TranslateApi = { cached: () => '訳', translate: vi.fn(async () => '訳') };
    const { decos, view, lines } = setup({ api });
    await act(async () => { await Promise.resolve(); });
    expect(lines()[0]).toBe('⏺ 訳');
    view.unmount();
    expect(decos.every((d) => d.disposed)).toBe(true);
    expect(lines()[0]).toBe('⏺ The build passed on all five jobs, and the branch is');
  });
});
