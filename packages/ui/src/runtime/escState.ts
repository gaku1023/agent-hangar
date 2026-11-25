/**
 * 端末へ流した出力が、エスケープの列の途中で切れているかを見張る（docs/design.md「英語の返答の翻訳」のターミナルの節）。
 * 訳の上書き（runtime/termRewrite.ts）は、自分の列を出力の流れに差し込む。
 * 前の出力が列の途中で切れているときに差し込むと、xterm はそれを列の続きとして読み、画面が壊れる。
 * そこで、出力の最後が地の状態（列の外）のときだけ差し込む。
 */
type State = 'ground' | 'esc' | 'escInter' | 'csi' | 'str' | 'strEsc';

export function createEscState() {
  let st: State = 'ground';
  return {
    feed(d: string) {
      for (let i = 0; i < d.length; i++) {
        const c = d.charCodeAt(i);
        switch (st) {
          case 'ground':
            if (c === 0x1b) st = 'esc';
            else if (c === 0x9b) st = 'csi';
            else if (c === 0x9d || c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) st = 'str';
            break;
          case 'esc':
            if (c === 0x5b) st = 'csi';
            else if (c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) st = 'str';
            else if (c >= 0x20 && c <= 0x2f) st = 'escInter';
            else if (c === 0x1b) st = 'esc';
            else st = 'ground';
            break;
          case 'escInter':
            if (c >= 0x30 && c <= 0x7e) st = 'ground';
            else if (c === 0x1b) st = 'esc';
            break;
          case 'csi':
            if (c >= 0x40 && c <= 0x7e) st = 'ground';
            else if (c === 0x1b) st = 'esc';
            else if (c === 0x18 || c === 0x1a) st = 'ground';
            break;
          case 'str':
            if (c === 0x07 || c === 0x9c) st = 'ground';
            else if (c === 0x1b) st = 'strEsc';
            else if (c === 0x18 || c === 0x1a) st = 'ground';
            break;
          case 'strEsc':
            // ESC \ は ST。ほかの文字なら、xterm と同じく文字列を打ち切り、ESC から始まる新しい列として読み直す。
            if (c === 0x5c) st = 'ground';
            else { st = 'esc'; i--; }
            break;
        }
      }
    },
    ground: () => st === 'ground',
  };
}
