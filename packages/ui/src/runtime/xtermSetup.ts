/**
 * xterm の設定と打鍵の扱いのうち、本物の xterm が無くても確かめられる部分。
 * xterm.ts はここから引いて組み立てる。
 */
import type { IClipboardProvider } from '@xterm/addon-clipboard';
import type { ITerminalOptions } from '@xterm/xterm';
import { FONT_SIZE } from './terminals.ts';
import { isMacClient } from '../keys.ts';

/**
 * Shift+Enter で送る列。
 * Claude Code は ESC CR（Option+Enter と同じ列）を改行として読み、送信しない。
 * /terminal-setup が VS Code に入れる Shift+Enter の割り当ても同じ列である。
 * tmux は extended-keys の設定によらずこの列をそのまま中の claude へ渡す。
 * CSI u の形（ESC [13;2u）は tmux が素の CR に潰すので使わない。
 */
export const NEWLINE_SEQ = '\x1b\r';

type KeyEventLike = Pick<KeyboardEvent, 'type' | 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing' | 'keyCode' | 'preventDefault'>;

// 画面を開いている PC が macOS かは、キーの表と同じ判定を使う。
export { isMacClient };

/**
 * xterm の attachCustomKeyEventHandler に渡す関数を作る。
 * false を返した打鍵は xterm が処理しない。
 * xterm 6 は Shift+Enter でも CR を送り、Claude Code では送信になってしまうので、改行の列に差し替える。
 */
export function createKeyHandler(input: (data: string) => void, mac: boolean = isMacClient()): (e: KeyEventLike) => boolean {
  return (e) => {
    // xterm は Ctrl+V を ^V（0x16）として中のアプリへ送り、ブラウザの貼り付けを止める。
    // macOS の貼り付けは ⌘V なので困らないが、Windows と Linux では Ctrl+V で貼り付けられなくなる。
    // xterm に渡さなければブラウザが paste のイベントを起こし、xterm がそれを貼り付けとして受ける。既定の動きは止めない。
    if (!mac && e.type === 'keydown' && (e.key === 'v' || e.key === 'V') && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return false;
    if (e.key !== 'Enter' || !e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return true;
    // 変換中の Enter は IME の確定である。keyCode 229 は IME が打鍵を受け取っている印。
    if (e.isComposing || e.keyCode === 229) return true;
    // keyup は何も送らない。止めると xterm がフォーカスの戻しとカーソルの形の更新を飛ばす。
    if (e.type === 'keyup') return true;
    if (e.type === 'keydown') {
      e.preventDefault();
      input(NEWLINE_SEQ);
    }
    // keypress も止める。通すと xterm が keypress の側で CR を送る。
    return false;
  };
}

/** xterm に渡す設定。色はテーマの CSS 変数から読んだものを受け取る。 */
export function terminalOptions(theme: { background: string; foreground: string }): ITerminalOptions {
  return {
    fontFamily: "'JetBrains Mono Variable', Menlo, monospace",
    fontSize: FONT_SIZE.default,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    // unicode の切り替えは proposed API の扱いなので allowProposedApi が要る。
    allowProposedApi: true,
    theme,
    // tmux の mouse on や Claude Code がマウスを取っていると、ドラッグは中の側へ渡り、xterm の選択にならない。
    // Option を押している間だけ xterm の選択にする。選んだものは ⌘C で写せる。
    macOptionClickForcesSelection: true,
    // Option のクリックでカーソルを動かす機能は矢印キーを送る。
    // Claude Code の入力欄では ↑ ↓ が履歴の呼び出しになり、選ぶつもりの短いクリックで書きかけの指示が入れ替わるので切る。
    altClickMovesCursor: false,
    // Option は Meta にしない。JIS 配列のバックスラッシュ（Option+¥）や Option で打つ記号が入らなくなる。
    // Option+Enter はこの設定によらず ESC CR を送るので、改行はそのまま効く。
    macOptionIsMeta: false,
  };
}

/**
 * OSC 52 を受けてクリップボードに書く提供者。@xterm/addon-clipboard に渡す。
 * addon の既定の提供者は選択先が c のものしか書かないが、tmux のコピーモードは選択先を空にして送る（`ESC ] 52 ; ; <base64>`）。
 * macOS のクリップボードは 1 つなので、選択先は問わずに書く。
 */
export function clipboardProvider(write: (text: string) => Promise<void>): IClipboardProvider {
  return {
    // 読み出しには応じない。応じると、端末の中で動くどのプログラムでも利用者のクリップボードを読めてしまう。
    readText: () => '',
    writeText(_selection: string, text: string) {
      // 空の中身は消去の要求か、壊れた base64 を addon が空にしたものである。利用者が写したものを消さない。
      if (!text) return;
      // 書き込みは待たずに投げる。
      // xterm は OSC の処理が Promise を返すと、それが片付くまで後ろの出力の解析を止めるので、書き込みが保留になると端末の出力まで止まる。
      // WebKit は、直前 5 秒の間に頁の中で打鍵かクリックが無いと書き込みを断る（transient activation）。断られても端末の処理は止めない。
      // 書く口が同期で投げる（navigator.clipboard が無いなど）ときも同じく捨てる。
      try { void write(text).catch(() => { /* 書けなかった写しは捨てる */ }); } catch { /* 同上 */ }
    },
  };
}
