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
import { createEscState, groundCut } from './escState.ts';
import { rewriteOf, type RewriteDeps } from './xtermRewrite.ts';
import { trackDrag } from './dragCells.ts';
import type { HangarLink } from './hangarLink.ts';
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

/**
 * 本物の xterm.js。テストでは TerminalLike の偽物を使うので、このファイルは main.tsx だけが読む。
 * hangar は、hangar 自身のリンク（hangarLink.ts）を押されたときの行き先で、いまのペインでその会話を開く。
 */
/** 列の途中で切れた出力の残りを、続きを待たずに渡すまでの間。 */
const CARRY_MS = 50;

export function createXterm(hangar?: (link: HangarLink) => void): TerminalLike {
  const css = getComputedStyle(document.documentElement);
  const term = new Terminal(terminalOptions({ background: css.getPropertyValue('--term-bg').trim() || '#1c1b2e', foreground: css.getPropertyValue('--term-fg').trim() || '#e8e6f0' }));
  const fit = new FitAddon();
  term.loadAddon(fit);
  // 既定の Unicode 6 では絵文字を 1 桁に数え、Claude Code の数え方とずれて後ろの文字が重なる。
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  // 中のアプリや tmux のコピーモードが OSC 52 で写したものを、手元のクリップボードに書く。
  // navigator.clipboard は安全な文脈（127.0.0.1 は含まれる）にしか無いので、無ければ書かずに捨てる。
  // 訳の上書き（termRewrite.ts）が付いている間は、ドラッグで写した英語を、画面に見えている訳に取り直してから書く。
  let copyMap: Parameters<RewriteDeps['setCopyMap']>[0] = null;
  let drag: ReturnType<typeof trackDrag> | null = null;
  const copied = (text: string) => (copyMap ? copyMap(text, drag?.recent() ?? null) : text);
  term.loadAddon(new ClipboardAddon(undefined, clipboardProvider((text) => navigator.clipboard.writeText(copied(text)))));
  // 訳の上書きが、出力の列の途中や読み終わる前に差し込まないための見張り（xtermRewrite.ts）。
  const esc = createEscState();
  let pending = 0;
  // 影の端末。同じ出力を、訳を書かずにそのまま読ませる。英語の本当の画面を持ち、訳の上書きが探す元と書き戻す元にする（termRewrite.ts）。
  // 開かない（描かない）ので軽い。寸法は見える端末に合わせる。
  const truth = new Terminal({ ...terminalOptions({ background: '#000', foreground: '#fff' }), cols: term.cols, rows: term.rows });
  truth.loadAddon(new Unicode11Addon());
  truth.unicode.activeVersion = '11';
  term.onResize(({ cols, rows }) => { try { truth.resize(cols, rows); } catch { /* 捨てたあと */ } });
  let carry = '';
  let carryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 出力を読み終えたときに、描かれる前に呼ぶもの（訳の上書き）。 */
  const afterWrite = new Set<() => void>();
  const truthCore = (truth as unknown as { _core?: { writeSync?(d: string): void } })._core;
  // リンク。地の文の URL（web-links）も OSC 8 のハイパーリンクも、修飾キー付きのクリックでだけ開き、http と https のほかは開かない。
  // 下線とポインタは修飾キーを押している間だけ出す。
  const desktop = createDesktopBridge(window);
  const open = linkOpener(desktop?.openLink ? { openLink: desktop.openLink } : null);
  term.options.linkHandler = { activate: (e, text) => { activateLink(e, text, open, undefined, hangar); }, allowNonHttpProtocols: false };
  term.loadAddon(new WebLinksAddon((e, uri) => { activateLink(e, uri, open, undefined, hangar); }));
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
      // ドラッグの範囲を覚える。写しを画面に見えている訳に取り直すため（termRewrite.ts の mapCopy）。
      if (term.element) {
        drag?.dispose();
        const screen = term.element.querySelector<HTMLElement>('.xterm-screen');
        drag = trackDrag(term.element, window, (cx, cy) => {
          const r = screen?.getBoundingClientRect();
          if (!r || r.width === 0 || r.height === 0) return null;
          const x = Math.min(term.cols - 1, Math.max(0, Math.floor(((cx - r.left) / r.width) * term.cols)));
          const y = Math.min(term.rows - 1, Math.max(0, Math.floor(((cy - r.top) / r.height) * term.rows)));
          return { x, y: term.buffer.active.viewportY + y };
        });
      }
    },
    write: (raw, cb) => {
      // 列の途中で切れた出力は、切れ目から後ろを次の出力とつないで渡す。
      // 端末に渡す出力がいつも列の外で終わるので、読み終えたその場で訳を書ける（列の続きを待つ間に英語が描かれない）。
      if (carryTimer) { clearTimeout(carryTimer); carryTimer = null; }
      const all = carry + raw;
      const cut = groundCut(all);
      const d = all.slice(0, cut);
      carry = all.slice(cut);
      // 続きが来ないときのために、少し待っても残っていればそのまま渡す。
      if (carry) carryTimer = setTimeout(() => { carryTimer = null; const rest = carry; carry = ''; if (rest) { esc.feed(rest); if (truthCore?.writeSync) truthCore.writeSync(rest); else truth.write(rest); pending++; term.write(rest, () => { pending--; }); } }, CARRY_MS);
      if (!d) { cb?.(); return; }
      esc.feed(d);
      pending++;
      // 影には同じ出力を先に読ませ終える（見える端末を読み終えたときに、英語の本当の画面がそろっているように）。
      if (truthCore?.writeSync) truthCore.writeSync(d); else truth.write(d);
      // 読み終えたときの呼び出しは、xterm が描く（次の描画の枠）より前に来る。ここで訳を書けば、英語が描かれずに済む。
      term.write(d, () => { pending--; if (pending === 0) for (const f of afterWrite) f(); cb?.(); });
    },
    onData: (cb) => term.onData(cb),
    onResize: (cb) => term.onResize(cb),
    fit: () => { try { fit.fit(); } catch { /* 非表示のときは寸法が取れない */ } },
    focus: () => term.focus(),
    paste: (d) => term.paste(d),
    input: (d) => term.input(d),
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
    dispose: () => { gl = null; stopWrap(); drag?.dispose(); drag = null; afterWrite.clear(); truth.dispose(); term.dispose(); },
    rewrite: () => (term.element ? rewriteOf(term, { ground: () => esc.ground(), pending: () => pending, setCopyMap: (m) => { copyMap = m; }, truth, afterWrite: (f) => { afterWrite.add(f); return { dispose: () => { afterWrite.delete(f); } }; } }) : null),
  };
}
