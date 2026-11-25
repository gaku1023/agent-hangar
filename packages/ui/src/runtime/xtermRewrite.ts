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
  /** tmux に、この端末の画面を全部描き直させる。 */
  redraw(): void;
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

export function rewriteOf(term: Terminal, deps: RewriteDeps): RewriteTerm & { redraw(): void } {
  const core = (term as unknown as { _core?: { unicodeService?: { getStringCellWidth?(s: string): number } } })._core;
  const cellWidth = core?.unicodeService?.getStringCellWidth?.bind(core.unicodeService);
  return {
    get cols() { return term.cols; },
    lines() {
      const b = term.buffer.active;
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
    snapshot(line, x) {
      const row = term.buffer.active.getLine(line);
      if (!row) return '';
      let out = '';
      let last = '';
      let blank = '';
      const cell = row.getCell(0);
      if (!cell) return '';
      for (let i = x; i < term.cols; i++) {
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
        seq += `\x1b[${y + 1};${x + 1}H\x1b[0m${r.seq}\x1b[0m\x1b[K`;
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
      const d = term.registerDecoration({ marker: marker as IMarker, x: box.x, width: box.width, height: 1, layer: 'top' });
      if (!d) return null;
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
        el.style.height = `${h}px`;
      });
      // decoration は次の描画で初めて描かれる。端末が黙っている（会話が止まっている）と描画が来ないので、その行だけ描き直させる。
      const row = marker.line - term.buffer.active.viewportY;
      if (row >= 0 && row < term.rows) term.refresh(row, row);
      return d;
    },
    setCopyMap: (map) => deps.setCopyMap(map),
    redraw: () => deps.redraw(),
    onChange(cb) {
      const subs = [term.onWriteParsed(cb), term.onResize(cb), term.buffer.onBufferChange(cb)];
      return { dispose: () => { for (const s of subs) s.dispose(); } };
    },
  };
}
