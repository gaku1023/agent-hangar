import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalLike } from './terminals.ts';

/** 本物の xterm.js。テストでは TerminalLike の偽物を使うので、このファイルは main.tsx だけが読む。 */
export function createXterm(): TerminalLike {
  const css = getComputedStyle(document.documentElement);
  const term = new Terminal({ fontFamily: "'JetBrains Mono Variable', Menlo, monospace", fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme: { background: css.getPropertyValue('--term-bg').trim() || '#1c1b19', foreground: css.getPropertyValue('--term-fg').trim() || '#e8e6e1' } });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    get element() { return term.element ?? null; },
    open: (el) => term.open(el),
    write: (d) => term.write(d),
    onData: (cb) => term.onData(cb),
    onResize: (cb) => term.onResize(cb),
    fit: () => { try { fit.fit(); } catch { /* 非表示のときは寸法が取れない */ } },
    focus: () => term.focus(),
    dispose: () => term.dispose(),
  };
}
