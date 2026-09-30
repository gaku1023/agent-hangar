import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalLike } from './terminals.ts';
import { clipboardProvider, createKeyHandler, terminalOptions } from './xtermSetup.ts';

/** 本物の xterm.js。テストでは TerminalLike の偽物を使うので、このファイルは main.tsx だけが読む。 */
export function createXterm(): TerminalLike {
  const css = getComputedStyle(document.documentElement);
  const term = new Terminal(terminalOptions({ background: css.getPropertyValue('--term-bg').trim() || '#1c1b2e', foreground: css.getPropertyValue('--term-fg').trim() || '#e8e6f0' }));
  const fit = new FitAddon();
  term.loadAddon(fit);
  // 既定の Unicode 6 では絵文字を 1 桁に数え、Claude Code の数え方とずれて後ろの文字が重なる。
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  // 中のアプリや tmux のコピーモードが OSC 52 で写したものを、手元のクリップボードに書く。
  // navigator.clipboard は安全な文脈（127.0.0.1 は含まれる）にしか無いので、無ければ書かずに捨てる。
  term.loadAddon(new ClipboardAddon(undefined, clipboardProvider((text) => navigator.clipboard.writeText(text))));
  // Shift+Enter を送信ではなく改行にする。列は xtermSetup.ts の NEWLINE_SEQ を見よ。
  term.attachCustomKeyEventHandler(createKeyHandler((d) => term.input(d)));
  // DOM の描画はブロック文字と罫線もフォントで描くので、行間に隙間が出て Claude のロゴが崩れる。WebGL はセルいっぱいに自前で描く。
  let gl: WebglAddon | null = null;
  const dropGpu = () => { const a = gl; gl = null; a?.dispose(); };
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
    paste: (d) => term.paste(d),
    // WebGL の描画は設定の変更を受けて文字の寸法を測り直す。
    setFontSize(px) { if (term.options.fontSize !== px) term.options.fontSize = px; },
    setGpu(on) {
      if (!on) { dropGpu(); return; }
      if (gl || !term.element) return;
      try {
        const a = new WebglAddon();
        // 文脈を失ったら DOM の描画に戻す。次に mount したときに付け直す。
        a.onContextLoss(() => { if (gl === a) dropGpu(); });
        term.loadAddon(a);
        gl = a;
      } catch { /* WebGL2 が使えない環境では DOM の描画のまま */ }
    },
    dispose: () => { gl = null; term.dispose(); },
  };
}
