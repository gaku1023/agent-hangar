/**
 * ロゴの原図を SVG の文字列で作る。
 * 端末の窓を掛けたハンガーが、右奥へ向かって 4 本重なり、奥ほど霞む。
 * 値の正本は docs/superpowers/specs/2026-09-29-ui-refresh-design.md の「原図」の表である。
 * ファイルは scripts/write-brand.ts がこの関数から書き出し、logo.test.ts が一致を確かめる。
 */

const INK = '#1c1b2e';
const BLUE = '#4a63e8';
const HAZE = '#e2e7ff';
const CHEVRON = '#e8e6e1';
const LIGHTS = ['#ff6a55', '#ffc34d', '#3fb58a'] as const;
/** 手前の札から順のカーソルの色。杏（作業中）、赤（入力待ち）、灰（休み）、杏。 */
export const CURSORS = ['#ffb86b', '#e5533d', '#b5b2c4', '#ffb86b'] as const;

const COUNT = 4;
const SHRINK = 0.85;
const STEP_X = 0.13;
const STEP_Y = 0.035;
const HAZE_MAX = 0.86;
/** 札 1 本の局所座標での幅と高さ（送りの割合の基準）と、描いた形の外枠。 */
const W = 62;
const H = 72;
const BOX = { x0: -31, y0: -3, x1: 31, y1: 69 };

export type Slot = { x: number; y: number; s: number; t: number };

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** 色 a を色 b へ割合 t だけ寄せる。 */
export const mix = (a: string, b: string, t: number): string => {
  const [x, y] = [rgb(a), rgb(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('');
};
/** 座標の数値を、小数 3 桁までの短い文字にする。出力を毎回同じにするため。 */
const num = (v: number) => String(Number(v.toFixed(3)));

/** 札の並び。0 が手前で、奥へ行くほど右上へずれ、小さくなり、霞む。 */
export function slots(count: number): Slot[] {
  const out: Slot[] = [];
  let x = 0, y = 0, s = 1;
  for (let i = 0; i < count; i++) {
    out.push({ x, y, s, t: count === 1 ? 0 : (i / (count - 1)) * HAZE_MAX });
    x += STEP_X * W * s;
    y -= STEP_Y * H * s;
    s *= SHRINK;
  }
  return out;
}

/** 並んだ札の外枠を、100 × 100 の中の幅 w、高さ h の枠へ、中心 (cx, cy) で収める倍率と位置。 */
function fit(sl: Slot[], w: number, h: number, cx: number, cy: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of sl) {
    x0 = Math.min(x0, p.x + BOX.x0 * p.s);
    y0 = Math.min(y0, p.y + BOX.y0 * p.s);
    x1 = Math.max(x1, p.x + BOX.x1 * p.s);
    y1 = Math.max(y1, p.y + BOX.y1 * p.s);
  }
  const sc = Math.min(w / (x1 - x0), h / (y1 - y0));
  return { sc, tx: cx - (sc * (x0 + x1)) / 2, ty: cy - (sc * (y0 + y1)) / 2 };
}

export type LogoOptions = { front?: boolean };

/** 原図は幅 70、高さ 66 の枠に、先頭 1 本の図（16px 用）は幅と高さ 80 の枠に収める。 */
export function layout(opts: LogoOptions = {}) {
  const sl = slots(opts.front ? 1 : COUNT);
  return { slots: sl, ...(opts.front ? fit(sl, 80, 80, 50, 50) : fit(sl, 70, 66, 50, 51)) };
}

/** 札 1 本。t は霞の割合、cursor はカーソルの色。局所座標でフックの首が (0, 10) に来る。 */
function hanger(t: number, cursor: string): string {
  const c = (color: string, k = 1) => mix(color, HAZE, t * k);
  return [
    `<path d="M0 10v-4a4.2 4.2 0 1 0-4.2-4.2" fill="none" stroke="${c(INK)}" stroke-width="2.8" stroke-linecap="round"/>`,
    `<rect x="-30" y="29" width="60" height="40" rx="5" fill="${c(INK)}"/>`,
    `<path d="M0 10L-31 31H31Z" fill="none" stroke="${c(BLUE)}" stroke-width="4" stroke-linejoin="round"/>`,
    ...LIGHTS.map((l, i) => `<circle cx="${num(-23 + i * 6.5)}" cy="37" r="2" fill="${c(l)}"/>`),
    `<path d="M-23 46l7 5.5-7 5.5" fill="none" stroke="${c(CHEVRON, 0.6)}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<rect x="-12" y="55" width="13" height="4" rx="2" fill="${mix(cursor, HAZE, t * 0.45)}"/>`,
  ].join('');
}

/** 図の中身。defs は竿のグラデーション（先頭 1 本の図には無い）、body は 100 × 100 の座標の <g>。 */
export function logoParts(opts: LogoOptions = {}): { defs: string; body: string } {
  const L = layout(opts);
  const sl = L.slots;
  let defs = '', rail = '';
  if (sl.length > 1) {
    const a = sl[0]!, b = sl[sl.length - 1]!;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, ext = 14;
    const x1 = a.x - ux * ext, y1 = a.y - uy * ext - 1, x2 = b.x + ux * ext, y2 = b.y + uy * ext - 1;
    defs = `<linearGradient id="hangar-rail" gradientUnits="userSpaceOnUse" x1="${num(x1)}" y1="0" x2="${num(x2)}" y2="0"><stop offset="0" stop-color="${INK}"/><stop offset="0.25" stop-color="${INK}"/><stop offset="1" stop-color="${HAZE}"/></linearGradient>`;
    rail = `<path d="M${num(x1)} ${num(y1)}L${num(x2)} ${num(y2)}" stroke="url(#hangar-rail)" stroke-width="2.6" stroke-linecap="round"/>`;
  }
  // 奥の札から描き、手前の札を上に重ねる。
  const hangers = sl
    .map((p, i) => ({ p, i }))
    .reverse()
    .map(({ p, i }) => `<g data-hanger="${i}" transform="translate(${num(p.x)} ${num(p.y)}) scale(${num(p.s)})">${hanger(p.t, CURSORS[i]!)}</g>`)
    .join('');
  return { defs, body: `<g transform="translate(${num(L.tx)} ${num(L.ty)}) scale(${num(L.sc)})">${rail}${hangers}</g>` };
}

/** 100 × 100 の SVG の文字列。 */
export function logoSvg(opts: LogoOptions = {}): string {
  const { defs, body } = logoParts(opts);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>\n`;
}

/** 書き出すファイル。path はリポジトリの根からの相対パス。 */
export const BRAND_FILES: { path: string; make: () => string }[] = [
  { path: 'packages/ui/src/brand/logo.svg', make: () => logoSvg() },
  { path: 'packages/ui/src/brand/logo-front.svg', make: () => logoSvg({ front: true }) },
  { path: 'apps/desktop/loading/logo.svg', make: () => logoSvg() },
];
