import type { IBufferCell, IMarker, Terminal } from '@xterm/xterm';
import type { RewriteTerm } from './termRewrite.ts';

/**
 * 訳の上書き（runtime/termRewrite.ts）のための、本物の xterm の口。
 * 書き換えは、出力の流れに自分の列を差し込んで行う（カーソルと文字の飾りは DECSC/DECRC で保って戻し、右端の折り返しは止めておく）。
 * 差し込んでよいのは、xterm に渡した出力が全部読み終わっていて、最後がエスケープの列の途中でないときだけにする。
 * 読み終わっていない出力が画面をずらすと、ずれた先の行を書き換えてしまうためである。
 */
export type RewriteDeps = {
  /** xterm に渡した出力の最後が、エスケープの列の外か（runtime/escState.ts）。 */
  ground(): boolean;
  /** xterm に渡して、まだ読み終わっていない書き込みの数。 */
  pending(): number;
  /** OSC 52 の写しを通す口を差し替える。 */
  setCopyMap(map: Parameters<RewriteTerm['setCopyMap']>[0]): void;
  /** 同じ出力を訳を書かずに読んだ影の端末（英語の本当の画面）。 */
  truth: Terminal;
  /** 出力を読み終えたとき、描かれる前に呼ぶものを足す。 */
  afterWrite(f: () => void): { dispose(): void };
};

/** セルの文字の飾りを SGR の引数にする。 */
function sgrOf(c: IBufferCell): string {
  const a: (string | number)[] = [0];
  if (c.isBold()) a.push(1);
  if (c.isDim()) a.push(2);
  if (c.isItalic()) a.push(3);
  if (c.isUnderline()) a.push(4);
  if (c.isBlink()) a.push(5);
  if (c.isInverse()) a.push(7);
  if (c.isInvisible()) a.push(8);
  if (c.isStrikethrough()) a.push(9);
  if (c.isFgRGB()) { const v = c.getFgColor(); a.push(`38;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`); }
  else if (c.isFgPalette()) a.push(`38;5;${c.getFgColor()}`);
  if (c.isBgRGB()) { const v = c.getBgColor(); a.push(`48;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`); }
  else if (c.isBgPalette()) a.push(`48;5;${c.getBgColor()}`);
  return a.join(';');
}

/** セルの選択の色（背景の色と反転）を SGR の引数にする。無ければ空。 */
function shadeOf(c: IBufferCell): string {
  const a: string[] = [];
  if (c.isInverse()) a.push('7');
  if (c.isBgRGB()) { const v = c.getBgColor(); a.push(`48;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`); }
  else if (c.isBgPalette()) a.push(`48;5;${c.getBgColor()}`);
  return a.join(';');
}

export function rewriteOf(term: Terminal, deps: RewriteDeps): RewriteTerm {
  const core = (term as unknown as { _core?: { unicodeService?: { getStringCellWidth?(s: string): number } } })._core;
  const cellWidth = core?.unicodeService?.getStringCellWidth?.bind(core.unicodeService);
  return {
    get cols() { return term.cols; },
    lines() {
      const b = deps.truth.buffer.active;
      const out: string[] = new Array<string>(b.length);
      for (let i = 0; i < b.length; i++) out[i] = b.getLine(i)?.translateToString(true) ?? '';
      return out;
    },
    cellsFrom(line, x) {
      return term.buffer.active.getLine(line)?.translateToString(true, x) ?? '';
    },
    cellsRange(line, x0, x1) {
      return term.buffer.active.getLine(line)?.translateToString(false, x0, x1) ?? '';
    },
    width(s) {
      if (cellWidth) return cellWidth(s);
      // 内側の口が無い版では、東アジアの全角を 2 桁とみなす。外れても、折り返しを止めて書くので次の行へはみ出さない。
      return Array.from(s).reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(ch) ? 2 : 1), 0);
    },
    shades(line, x0, x1, from) {
      const out = Array<string>(Math.max(0, x1 - x0)).fill('');
      const row = (from === 'truth' ? deps.truth : term).buffer.active.getLine(line);
      const cell = row?.getCell(0);
      if (!row || !cell) return out;
      let prev = '';
      for (let x = x0; x < x1; x++) {
        const c = row.getCell(x, cell);
        if (!c) continue;
        // 全角の右半分（幅 0 のセル）は、左の桁の色にそろえる。
        const sh = c.getWidth() === 0 ? prev : shadeOf(c);
        out[x - x0] = sh;
        prev = sh;
      }
      return out;
    },
    snapshot(line, x) {
      const row = deps.truth.buffer.active.getLine(line);
      if (!row) return '';
      let out = '';
      let last = '';
      let blank = '';
      const cell = row.getCell(0);
      if (!cell) return '';
      for (let i = x; i < deps.truth.cols; i++) {
        const c = row.getCell(i, cell);
        if (!c || c.getWidth() === 0) continue;
        const sgr = sgrOf(c);
        const ch = c.getChars() || ' ';
        // 地の飾りの空白は後ろに文字が続くときだけ書く（行の残りは paint が消す）。
        if (ch === ' ' && sgr === '0') { blank += ' '; continue; }
        if (blank) { if (last !== '0') { out += '\x1b[0m'; last = '0'; } out += blank; blank = ''; }
        if (sgr !== last) { out += `\x1b[${sgr}m`; last = sgr; }
        out += ch;
      }
      return out;
    },
    paint(x, rows) {
      if (deps.pending() > 0 || !deps.ground()) return false;
      const b = term.buffer.active;
      let seq = '';
      for (const r of rows) {
        const y = r.line - b.viewportY;
        if (y < 0 || y >= term.rows) continue;
        // keep があれば、札（keep.from から keep.to の手前）は残し、札より右を消す。seq は札の手前までに収めてある。
        seq += `\x1b[${y + 1};${x + 1}H\x1b[0m${r.seq}\x1b[0m${r.keep ? `\x1b[${y + 1};${r.keep.to + 1}H` : ''}\x1b[K`;
      }
      if (!seq) return false;
      const wrap = term.modes.wraparoundMode;
      term.write(`\x1b7\x1b[?7l${seq}${wrap ? '\x1b[?7h' : ''}\x1b8`);
      return true;
    },
    mark(line) {
      const b = term.buffer.active;
      return term.registerMarker(line - (b.baseY + b.cursorY)) ?? null;
    },
    decorate(marker, box) {
      const height = box.height ?? 1;
      const d = term.registerDecoration({ marker: marker as IMarker, x: box.x, width: box.width, height, layer: 'top' });
      if (!d) return null;
      // 訳を待つ段落の光（styles の .term-tr-glow）。押せないので、選択やクリックはその下の端末へ通す。
      if (box.glow) d.onRender((el) => { el.classList.add('term-tr-glow'); });
      // xterm は代わりの画面（tmux に attach した Claude のタブ）では decoration を隠し、位置も合わせ直さない。
      // そこで、描かれるたびに、画面の中にあるものは出して、位置と寸法をセルの大きさから当て直す。
      d.onRender((el) => {
        if (term.buffer.active.type !== 'alternate') return;
        const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
        if (!screen || term.rows === 0 || term.cols === 0) return;
        const w = screen.clientWidth / term.cols;
        const h = screen.clientHeight / term.rows;
        const row = d.marker.line - term.buffer.active.viewportY;
        if (row < 0 || row >= term.rows) return;
        el.style.display = 'block';
        el.style.top = `${row * h}px`;
        el.style.left = `${box.x * w}px`;
        el.style.width = `${Math.round(box.width * w)}px`;
        el.style.height = `${height * h}px`;
      });
      // decoration は次の描画で初めて描かれる。端末が黙っている（会話が止まっている）と描画が来ないので、その行だけ描き直させる。
      const row = marker.line - term.buffer.active.viewportY;
      if (row >= 0 && row < term.rows) term.refresh(row, row);
      return d;
    },
    setCopyMap: (map) => deps.setCopyMap(map),
    onChange(cb) {
      const subs = [deps.afterWrite(cb), term.onResize(cb), term.buffer.onBufferChange(cb)];
      return { dispose: () => { for (const s of subs) s.dispose(); } };
    },
  };
}
