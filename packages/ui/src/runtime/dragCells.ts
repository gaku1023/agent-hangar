import type { CopyDrag } from './termRewrite.ts';

/** ドラッグを放してから、届いた写しをそのドラッグのものとみなす間。Claude Code と tmux は放したときに写す。 */
export const DRAG_COPY_MS = 3000;

/**
 * 端末の上のドラッグの範囲（マス）を覚える（docs/design.md「英語の返答の翻訳」のターミナルの節）。
 * 押し下げと放しは、xterm が中のアプリへ渡す前の捕捉の段で見るだけで、止めない。
 * toCell は画面の位置を、桁と buffer の行の番号にする。端末の外なら null。
 */
export function trackDrag(el: EventTarget, win: EventTarget, toCell: (clientX: number, clientY: number) => { x: number; y: number } | null, now: () => number = Date.now) {
  let start: { x: number; y: number } | null = null;
  let done: { drag: CopyDrag; at: number } | null = null;
  const down = (ev: Event) => { const e = ev as MouseEvent; if (e.button === 0) { start = toCell(e.clientX, e.clientY); done = null; } };
  const up = (ev: Event) => {
    const e = ev as MouseEvent;
    if (e.button !== 0 || !start) return;
    const end = toCell(e.clientX, e.clientY);
    if (end) done = { drag: { start, end }, at: now() };
    start = null;
  };
  el.addEventListener('mousedown', down, true);
  // 放すのは端末の外のこともあるので、窓で受ける。
  win.addEventListener('mouseup', up, true);
  return {
    /** 放してから DRAG_COPY_MS 以内のドラッグ。無ければ null。 */
    recent(): CopyDrag | null {
      return done && now() - done.at <= DRAG_COPY_MS ? done.drag : null;
    },
    dispose() {
      el.removeEventListener('mousedown', down, true);
      win.removeEventListener('mouseup', up, true);
    },
  };
}
