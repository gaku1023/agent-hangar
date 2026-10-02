import { motionEase, motionMs, motionValue } from './motion.ts';

/**
 * 出入りの形（設計書「共通の約束」）。長さと曲線はトークンから読み、数値を直書きしない。
 * 入る形はぼかしを 0.2 で晴らし切る（base.css の @keyframes enter と同じ理由で、WebKit が細いぼかしを 1px に丸めるため）。
 * jsdom のように Web Animations を持たない環境と、reduced motion（長さ 0）では何もしない。
 */
export function motionOn(el: Element = document.documentElement): boolean {
  return typeof (el as HTMLElement).animate === 'function' && motionMs('--dur', el) > 0;
}

const enterFrames = (el: Element): Keyframe[] => [
  { opacity: 0, transform: `translateY(${motionValue('--rise', el)})`, filter: `blur(${motionValue('--blur-in', el)})` },
  { offset: 0.2, filter: 'none' },
  { opacity: 1, transform: 'none', filter: 'none' },
];

/** 入る形。delay は ms で、トークンから読んだ値を渡す。 */
export function riseIn(el: HTMLElement, delay = 0): Animation | null {
  if (!motionOn(el)) return null;
  return el.animate(enterFrames(el), { duration: motionMs('--dur', el), delay, easing: motionEase('--ease-out', el), fill: 'backwards' });
}

/** 薄れから現すだけ（一覧を一度に入れたとき、端末の最初の描画）。 */
export function fadeIn(el: HTMLElement): Animation | null {
  if (!motionOn(el)) return null;
  return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
}

const sizeOf = (el: HTMLElement, axis: 'y' | 'x') => (axis === 'y' ? el.offsetHeight : el.offsetWidth);
const prop = (axis: 'y' | 'x') => (axis === 'y' ? 'height' : 'width');
/** その向きの余白（padding と margin）。border-box では高さが padding より小さくならないので、伸び縮みでは余白も一緒に動かす。 */
const EDGES = {
  y: { paddingTop: 'padding-top', paddingBottom: 'padding-bottom', marginTop: 'margin-top', marginBottom: 'margin-bottom' },
  x: { paddingLeft: 'padding-left', paddingRight: 'padding-right', marginLeft: 'margin-left', marginRight: 'margin-right' },
} as const;
/** 余白を全部 0 にした形。 */
const edgesZero = (axis: 'y' | 'x'): Keyframe => Object.fromEntries(Object.keys(EDGES[axis]).map((k) => [k, '0px']));
/** 今の余白（計算済みの値）。 */
const edgesNow = (el: HTMLElement, axis: 'y' | 'x'): Keyframe => {
  const cs = getComputedStyle(el);
  return Object.fromEntries(Object.entries(EDGES[axis]).map(([k, css]) => [k, cs.getPropertyValue(css) || '0px']));
};

/** 伸びて入る形。高さ（横なら幅）と、その向きの余白を 0 から伸ばし、下（右）の要素を押して滑らせる。伸びる間は中身をはみ出させない。 */
export function growIn(el: HTMLElement, axis: 'y' | 'x' = 'y'): Animation | null {
  if (!motionOn(el)) return null;
  const size = sizeOf(el, axis);
  const p = prop(axis);
  // 余白は動かし始める前に読む（動きの最初の形は 0 なので、あとから読むと 0 になる）。
  const edges = edgesNow(el, axis);
  const overflow = el.style.overflow;
  el.style.overflow = 'hidden';
  const a = el.animate([
    { [p]: '0px', opacity: 0, filter: `blur(${motionValue('--blur-in', el)})`, ...edgesZero(axis) },
    { offset: 0.2, filter: 'none' },
    { [p]: `${size}px`, opacity: 1, filter: 'none', ...edges },
  ], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
  const restore = () => { el.style.overflow = overflow; };
  a.finished.then(restore, restore);
  return a;
}

/** 畳んで出る形。薄れながら高さ（横なら幅）を 0 にする。終わったら解決する。動かないときはすぐ解決する。 */
export function collapseOut(el: HTMLElement, axis: 'y' | 'x' = 'y'): Promise<void> {
  if (!motionOn(el)) return Promise.resolve();
  const size = sizeOf(el, axis);
  const p = prop(axis);
  const edge = edgesZero(axis);
  const overflow = el.style.overflow;
  el.style.overflow = 'hidden';
  const a = el.animate([
    { [p]: `${size}px`, opacity: 1 },
    { opacity: 0, offset: 0.6 },
    { [p]: '0px', opacity: 0, ...edge },
  ], { duration: motionMs('--dur-exit', el) + motionMs('--dur-fast', el), easing: motionEase('--ease-in', el), fill: 'forwards' });
  // 終わったら要素は外されるので隠したままにする。取り消された（出る途中で戻った）ときだけ、元の指定に戻す。
  return a.finished.then(() => undefined, () => { el.style.overflow = overflow; });
}

/** 並びの FLIP。前の位置から今の位置へ滑らせる。 */
export function slideFrom(el: HTMLElement, before: DOMRect, after: DOMRect): Animation | null {
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  if ((dx === 0 && dy === 0) || !motionOn(el)) return null;
  return el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
}

/** 印が替わる瞬間に 1 度だけ膨らむ（StatusDot と同じ形）。 */
export function popMark(el: HTMLElement): Animation | null {
  if (!motionOn(el)) return null;
  return el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
}

/** 地を淡い黄から薄れさせる（base.css の [data-hit]）。長さは CSS のトークンが持つ。 */
export function markHit(el: HTMLElement): void {
  el.setAttribute('data-hit', '');
  el.addEventListener('animationend', () => el.removeAttribute('data-hit'), { once: true });
}
