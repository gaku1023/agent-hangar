import { motionEase, motionMs } from './motion.ts';

/**
 * サイドバーの開閉の動き（M4「なめらかな受け渡し」と「ハンガーの揺れ」）。
 * 開閉で .shell の data-sidebar が替わった直後に呼ぶ。
 * 前の形と今の形の配置を同じ描画の中で測り（前の形は印を一瞬戻して測る）、差を Web Animations で埋める。
 * 幅、項目の箱、アイコン、項目名、図、名前（Hangar_）を同じ長さと曲線で動かすので、文字やアイコンが飛ばない。
 * 図のハンガーは、動きに引かれて起動画面と同じ振り子で揺れて止まる。
 * reduced motion では --dur が 0 になり、動かさない。
 */

/** 動いている間 .shell に付ける印。端末はこの間の寸法合わせを止める（TerminalPane）。 */
export const MOVING_ATTR = 'data-sidebar-moving';
/** 動きが止まったことを知らせる window の出来事。端末はここで一度だけ寸法を合わせる。 */
export const LAYOUT_SETTLED = 'hangar:layout-settled';
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
type Parts = { side: HTMLElement | null; brand: HTMLElement | null; mark: HTMLElement | null; items: { box: HTMLElement; icon: Element | null; label: HTMLElement | null; edge: boolean }[] };
type Snap = { cols: string; sideW: number; brand: Box | null; items: { box: Box; radius: string; icon: Box | null; label: Box | null }[] };

function parts(shell: HTMLElement): Parts {
  return {
    side: shell.querySelector<HTMLElement>('.sidebar'),
    brand: shell.querySelector<HTMLElement>('.brand'),
    mark: shell.querySelector<HTMLElement>('.brand-mark'),
    // 開閉のボタンも、項目と同じく箱とアイコンを移す（ワードマークの右から帯の一番上へ）。項目の後ろに並べる。
    // ボタンは帯の右端に寄せて置く（edge）。横は帯の右端に付いて動かし、ワードマークの文字の上を横切らないようにする。
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
    sideW: side?.width ?? 0,
    brand: p.brand && boxIn(p.brand, side),
    items: p.items.map((it) => ({ box: boxIn(it.box, side), radius: getComputedStyle(it.box).borderRadius, icon: it.icon && boxIn(it.icon, side), label: it.label && boxIn(it.label, side) })),
  };
}

function settle(shell: HTMLElement): void {
  shell.removeAttribute(MOVING_ATTR);
  window.dispatchEvent(new Event(LAYOUT_SETTLED));
}

export function playSidebarMotion(shell: HTMLElement): void {
  const dur = motionMs('--dur', shell);
  if (!dur || typeof shell.animate !== 'function') { settle(shell); return; }
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
  // 幅。本文は格子の 2 列目なので、列の幅を動かせば付いてくる。ヘッダは窓の横いっぱいに渡り、動かない。
  const cols = shell.animate([{ gridTemplateColumns: F.cols }, { gridTemplateColumns: L.cols }], opts);
  cols.finished.then(() => settle(shell), () => {});

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

  // 図と名前（Hangar_）。閉じるときは、帯に乗ったまま薄れながら、細くなる帯に切られて消える。
  // 開くときは、項目と一緒に帯の上から下りてきて現れ（項目と同じだけずらすので重ならない）、図のハンガーが引かれて振り子で揺れて止まる（composite: add、回転の中心はフックの辺り）。
  if (p.brand && F.brand && L.brand) {
    if (collapsed) {
      const t = `translate(${F.brand.x - L.brand.x}px, ${F.brand.y - L.brand.y}px)`;
      p.brand.animate([{ transform: t, opacity: 1, ...shown }, { transform: t, opacity: 0, offset: 0.5, ...shown }, { transform: t, opacity: 0, ...shown }], opts);
    } else {
      const a = F.items[0], b = L.items[0]; // 最初のナビの項目
      const dy = a && b ? a.box.y - b.box.y : 0;
      p.brand.animate([{ transform: `translateY(${dy}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], opts);
      p.mark?.animate(swingKeyframes(-1), { duration: swingMs(), composite: 'add', id: ID });
    }
  }
}
