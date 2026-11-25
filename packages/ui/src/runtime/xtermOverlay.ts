import type { IMarker, Terminal } from '@xterm/xterm';
import type { OverlayTerm } from './termOverlay.ts';

/** 探す行の数の上限。下から数える。スクロールバックの古い行は返答の板の対象にしない。 */
const OVERLAY_LINES = 1000;

/**
 * 訳の板を付けるための口（runtime/termOverlay.ts）。
 * hangar の Claude のタブは tmux に attach しているので、xterm は代わりの画面（alt buffer）を使う。
 * xterm は代わりの画面では decoration を隠し（display: none）、位置も合わせ直さない。
 * そこで、描かれるたびに、画面の中にある板は出して、位置と寸法をセルの大きさから当て直す。
 */
export function overlayOf(term: Terminal): OverlayTerm {
  const cell = () => {
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || term.rows === 0 || term.cols === 0) return null;
    return { w: screen.clientWidth / term.cols, h: screen.clientHeight / term.rows };
  };
  return {
    get cols() { return term.cols; },
    lines() {
      const b = term.buffer.active;
      const from = Math.max(0, b.length - OVERLAY_LINES);
      const out: string[] = new Array<string>(b.length).fill('', 0, from);
      for (let i = from; i < b.length; i++) out[i] = b.getLine(i)?.translateToString(true) ?? '';
      return out;
    },
    mark(line) {
      const b = term.buffer.active;
      return term.registerMarker(line - (b.baseY + b.cursorY)) ?? null;
    },
    decorate(marker, box) {
      const d = term.registerDecoration({ marker: marker as IMarker, x: box.x, width: box.width, height: box.height, layer: 'top' });
      if (!d) return null;
      d.onRender((el) => {
        if (term.buffer.active.type !== 'alternate') return;
        const row = d.marker.line - term.buffer.active.viewportY;
        const c = cell();
        if (!c || row < 0 || row >= term.rows) return;
        el.style.display = 'block';
        el.style.top = `${row * c.h}px`;
        el.style.left = `${box.x * c.w}px`;
        el.style.width = `${Math.round(box.width * c.w)}px`;
        el.style.height = `${box.height * c.h}px`;
      });
      return d;
    },
    onChange(cb) {
      const subs = [term.onWriteParsed(cb), term.onResize(cb), term.buffer.onBufferChange(cb)];
      return { dispose: () => { for (const s of subs) s.dispose(); } };
    },
  };
}
