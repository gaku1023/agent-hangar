import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { wrapComposition } from './compositionWrap.ts';
import { createDesktopBridge } from './desktop.ts';
import type { TerminalLike } from './terminals.ts';
import { activateLink, createLinkGate, linkOpener, linkProvidersOf, type LinkGate } from './terminalLinks.ts';
import { clipboardProvider, createKeyHandler, guardEmptyCopy, terminalOptions } from './xtermSetup.ts';

/**
 * リンクの飾りの見張り（runtime/terminalLinks.ts）。端末が何枚あっても、修飾キーの押し下げは 1 つなので 1 つにする。
 * xterm は打鍵を自分で止めることがあるので、窓の捕捉の段で受ける。窓を離れたら押していないことにする（離したことが届かないため）。
 */
let gate: LinkGate | null = null;
function linkGate(): LinkGate {
  if (gate) return gate;
  const g = createLinkGate();
  const onKey = (held: boolean) => (e: KeyboardEvent) => { if (g.isModifierKey(e.key)) g.setHeld(held); };
  window.addEventListener('keydown', onKey(true), true);
  window.addEventListener('keyup', onKey(false), true);
  window.addEventListener('blur', () => g.setHeld(false));
  gate = g;
  return g;
}

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
  // リンク。地の文の URL（web-links）も OSC 8 のハイパーリンクも、修飾キー付きのクリックでだけ開き、http と https のほかは開かない。
  // 下線とポインタは修飾キーを押している間だけ出す。
  const desktop = createDesktopBridge(window);
  const open = linkOpener(desktop?.openLink ? { openLink: desktop.openLink } : null);
  term.options.linkHandler = { activate: (e, text) => { activateLink(e, text, open); }, allowNonHttpProtocols: false };
  term.loadAddon(new WebLinksAddon((e, uri) => { activateLink(e, uri, open); }));
  const providers = linkProvidersOf(term);
  if (providers) linkGate().wrapAll(providers);
  // Shift+Enter を送信ではなく改行にする。列は xtermSetup.ts の NEWLINE_SEQ を見よ。
  term.attachCustomKeyEventHandler(createKeyHandler((d) => term.input(d)));
  // DOM の描画はブロック文字と罫線もフォントで描くので、行間に隙間が出て Claude のロゴが崩れる。WebGL はセルいっぱいに自前で描く。
  let gl: WebglAddon | null = null;
  const dropGpu = () => { const a = gl; gl = null; a?.dispose(); };
  // 変換中の文字の見張り（compositionWrap.ts）を、ターミナルと同じ寿命で止める。
  let stopWrap = () => {};
  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    get element() { return term.element ?? null; },
    open(el) {
      term.open(el);
      // xterm が copy の処理を付けるのは open の中なので、その後ろに付ける。要素ごと捨てられるので外さない。
      if (term.element) guardEmptyCopy(term.element);
      // 変換中の文字をターミナルの右端で折り返し、下端を超える分は上へずらす（compositionWrap.ts）。捨てるときに止める。
      if (term.element) { stopWrap(); stopWrap = wrapComposition(term.element); }
    },
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
    dispose: () => { gl = null; stopWrap(); term.dispose(); },
  };
}
