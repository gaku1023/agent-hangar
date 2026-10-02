import { motionEase, motionMs } from './motion.ts';
import { beginLayoutMotion, endLayoutMotion, LAYOUT_SETTLED } from './layoutMotion.ts';

/**
 * サイドバーの開閉の動き（M4「なめらかな受け渡し」と「ハンガーの揺れ」）。
 * 開閉で .shell の data-sidebar が替わった直後に呼ぶ。
 * 前の形と今の形の配置を同じ描画の中で測り（前の形は印を一瞬戻して測る）、差を Web Animations で埋める。
 * 幅、項目の箱、アイコン、項目名、開閉のボタンを同じ長さと曲線で動かすので、文字やアイコンが飛ばない。
 * ロゴはヘッダにあって開閉では動かないが、図のハンガーは帯の動きに引かれて、起動画面と同じ振り子で揺れて止まる。
 * reduced motion では --dur が 0 になり、動かさない。
 */

/** 動いている間 .shell に付ける印。サイドバーの CSS（吹き出しを消すなど）が使う。端末への知らせは data-layout-moving。 */
export const MOVING_ATTR = 'data-sidebar-moving';
/** 動きが止まったことを知らせる window の出来事（layoutMotion と同じもの）。 */
export { LAYOUT_SETTLED };
/** この動きが作った Animation の印。途中で開閉し直したら、前の動きをこれで探して捨てる。 */
const ID = 'sidebar-motion';

// 振り子。角速度と減衰は起動画面と同じ（設計書「起動画面」）。振れ幅は図が小さいぶん控えめにする。
const SWING_DEG = 7;
const OMEGA = 6.3;
const DAMPING = 2.4;
/** 振れ幅がこれを下回ったら止まったとみなす。 */
const REST_DEG = 0.1;
const SWING_STEPS = 40;

/** 揺れが止まるまでの長さ。振れ幅が REST_DEG まで減衰する時刻である。 */
export function swingMs(): number {
  return (Math.log(SWING_DEG / REST_DEG) / DAMPING) * 1000;
}

/** 減衰する振り子の角度の並び。dir は引かれた向き（閉じると右、開くと左）。 */
export function swingKeyframes(dir: 1 | -1): Keyframe[] {
  const total = swingMs() / 1000;
  const out: Keyframe[] = [];
  for (let i = 0; i <= SWING_STEPS; i++) {
    const t = (i / SWING_STEPS) * total;
    const a = dir * SWING_DEG * Math.exp(-DAMPING * t) * Math.sin(OMEGA * t);
    out.push({ transform: `rotate(${a.toFixed(2)}deg)`, offset: i / SWING_STEPS });
  }
  return out;
}

type Box = { x: number; y: number; w: number; h: number };
/** 位置は帯の左上から測る。帯の動きと中身の動きを分けて数えるためである。 */
const boxIn = (el: Element, side: DOMRect | undefined): Box => {
  const r = el.getBoundingClientRect();
  return { x: r.left - (side?.left ?? 0), y: r.top - (side?.top ?? 0), w: r.width, h: r.height };
};
/** b の中での a の位置の、前の形と今の形の差。 */
const shift = (a: Box, ab: Box, b: Box, bb: Box) => `translate(${(a.x - ab.x) - (b.x - bb.x)}px, ${(a.y - ab.y) - (b.y - bb.y)}px)`;

/** 測る要素。項目ごとに箱とアイコンと項目名を持つ。 */
type Parts = { side: HTMLElement | null; mark: HTMLElement | null; items: { box: HTMLElement; icon: Element | null; label: HTMLElement | null; edge: boolean }[] };
type Snap = { cols: string; col1: string; sideW: number; items: { box: Box; radius: string; icon: Box | null; label: Box | null }[] };

function parts(shell: HTMLElement): Parts {
  return {
    side: shell.querySelector<HTMLElement>('.sidebar'),
    mark: shell.querySelector<HTMLElement>('.header .brand-mark'),
    // 開閉のボタンも、項目と同じく箱とアイコンを移す（ホームの行の右端から帯の一番上へ）。項目の後ろに並べる。
    // ボタンは帯の右端に寄せて置く（edge）。横は帯の右端に付いて動かし、ホームの項目名の上を横切らないようにする。
    items: [
      ...[...shell.querySelectorAll<HTMLElement>('.sidebar .nav-item')].map((el) => ({ box: el, icon: el.querySelector('svg'), label: el.querySelector<HTMLElement>('.nav-label'), edge: false })),
      ...[...shell.querySelectorAll<HTMLElement>('.sidebar .sidebar-toggle')].map((el) => ({ box: el, icon: el.querySelector('svg'), label: null, edge: true })),
    ],
  };
}

function snap(shell: HTMLElement, p: Parts): Snap {
  const side = p.side?.getBoundingClientRect();
  return {
    cols: getComputedStyle(shell).gridTemplateColumns,
    col1: getComputedStyle(shell).getPropertyValue('--col1').trim(),
    sideW: side?.width ?? 0,
    items: p.items.map((it) => ({ box: boxIn(it.box, side), radius: getComputedStyle(it.box).borderRadius, icon: it.icon && boxIn(it.icon, side), label: it.label && boxIn(it.label, side) })),
  };
}

function settle(shell: HTMLElement): void {
  shell.removeAttribute(MOVING_ATTR);
  endLayoutMotion(shell);
}

/** 動かさないときも、止まったことは知らせる。数えるので、begin と対にして呼ぶ。 */
function settleNow(shell: HTMLElement): void {
  beginLayoutMotion(shell);
  settle(shell);
}

export function playSidebarMotion(shell: HTMLElement): void {
  const dur = motionMs('--dur', shell);
  if (!dur || typeof shell.animate !== 'function') { settleNow(shell); return; }
  const easing = motionEase('--ease-out', shell);
  // 開閉し直したら、前の動きを捨ててから測る。残したままだと、途中の形を前の形として測ってしまう。
  for (const a of shell.getAnimations({ subtree: true })) if (a.id === ID) a.cancel();
  const collapsed = shell.dataset.sidebar === 'collapsed';
  const p = parts(shell);
  // 前の形：印を一瞬だけ戻して測る。同じ描画の中なので、戻した形は画面に出ない。
  if (collapsed) delete shell.dataset.sidebar; else shell.dataset.sidebar = 'collapsed';
  const F = snap(shell, p);
  if (collapsed) shell.dataset.sidebar = 'collapsed'; else delete shell.dataset.sidebar;
  const L = snap(shell, p);

  const opts: KeyframeAnimationOptions = { duration: dur, easing, id: ID };
  shell.setAttribute(MOVING_ATTR, '');
  beginLayoutMotion(shell);
  // 幅。本文は格子の 2 列目、ヘッダは subgrid で同じ列を使うので、列の幅を動かせばどちらも付いてくる。
  // 本文と検索欄の左の余白（--gutter-l）は左の列の幅（--col1、base.css で登録してある）から決まるので、--col1 も同じ長さで動かす。
  // 列の幅そのものも並べて動かすのは、登録したカスタムプロパティの補間が効かない環境でも、開閉の動きだけは残すためである。
  const cols = shell.animate([{ gridTemplateColumns: F.cols, '--col1': F.col1 }, { gridTemplateColumns: L.cols, '--col1': L.col1 }], opts);
  // 取り消された動き（開閉し直した）は、数だけ返す。印（MOVING_ATTR）は、すぐ後に始まる新しい動きのものなので外さない。
  cols.finished.then(() => settle(shell), () => endLayoutMotion(shell));

  // 項目の箱は位置と大きさと角の丸みを移し、中のアイコンは、箱の動きを打ち消したうえで自分の場所の差を移す。
  const shown = { visibility: 'visible' } as const;
  p.items.forEach((it, i) => {
    const a = F.items[i]!, b = L.items[i]!;
    // 右端に寄せた箱は、帯の幅に付いて横へ動くので、帯の右端からの位置の差だけを埋める。
    const dx = it.edge ? (a.box.x + a.box.w - F.sideW) - (b.box.x + b.box.w - L.sideW) : a.box.x - b.box.x;
    it.box.animate([
      { transform: `translate(${dx}px, ${a.box.y - b.box.y}px)`, width: `${a.box.w}px`, height: `${a.box.h}px`, borderRadius: a.radius },
      { transform: 'none', width: `${b.box.w}px`, height: `${b.box.h}px`, borderRadius: b.radius },
    ], opts);
    if (it.icon && a.icon && b.icon) it.icon.animate([{ transform: shift(a.icon, a.box, b.icon, b.box) }, { transform: 'none' }], opts);
    // 項目名は、閉じるときはその場で早めに薄れて帯に切られ、開くときは帯が広がってから現れる。閉じた帯では吹き出しとして隠れている。
    if (it.label && a.label && b.label) {
      if (collapsed) {
        const t = shift(a.label, a.box, b.label, b.box);
        it.label.animate([{ transform: t, opacity: 1, ...shown }, { transform: t, opacity: 0, offset: 0.35, ...shown }, { transform: t, opacity: 0, ...shown }], opts);
      } else {
        it.label.animate([{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 0, offset: 0.35 }, { opacity: 1, transform: 'none' }], opts);
      }
    }
  });

  // 図のハンガーは、帯の動きに引かれて振り子で揺れて止まる。閉じると右へ、開くと左へ引かれる（composite: add、回転の中心はフックの辺り）。
  p.mark?.animate(swingKeyframes(collapsed ? 1 : -1), { duration: swingMs(), composite: 'add', id: ID });
}
