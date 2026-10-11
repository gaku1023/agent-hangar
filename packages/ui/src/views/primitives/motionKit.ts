import { motionEase, motionMs, motionValue, type DurationToken } from './motion.ts';

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

/** 薄れから現すだけ（一覧を一度に入れたとき、端末の最初の描画）。中身を入れ替えるとき（ホームの引き出しの群、帯の注記）は --dur-fast で短く現す。 */
export function fadeIn(el: HTMLElement, token: DurationToken = '--dur'): Animation | null {
  if (!motionOn(el)) return null;
  return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionMs(token, el), easing: motionEase('--ease-out', el) });
}

/** 薄れて消えるだけ（ホームの帯の注記）。最後の形を残し、終わったら解決する。動かないときはすぐ解決する。 */
export function fadeOut(el: HTMLElement, token: DurationToken = '--dur-fast'): Promise<void> {
  if (!motionOn(el)) return Promise.resolve();
  return el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: motionMs(token, el), easing: motionEase('--ease-in', el), fill: 'forwards' }).finished.then(() => undefined, () => undefined);
}

/**
 * 高さの補間。中身を入れ替えた箱を、前の高さ（from、px）から今の高さへ --dur で動かし、下の要素を押して滑らせる（ホームの引き出しの群の切替、帯と 1 行の入れ替え）。
 * 前の高さは入れ替える前に呼び手が測って渡す。高さが同じなら動かさない。動く間は中身をはみ出させない。
 */
export function resizeFrom(el: HTMLElement, from: number): Animation | null {
  const to = el.offsetHeight;
  if (Math.abs(to - from) < 0.5 || !motionOn(el)) return null;
  const overflow = el.style.overflow;
  el.style.overflow = 'hidden';
  const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
  const restore = () => { el.style.overflow = overflow; };
  a.finished.then(restore, restore);
  return a;
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

/**
 * 畳んで出る形。薄れながら高さ（横なら幅）を 0 にする。終わったら解決する。動かないときはすぐ解決する。
 * fade が偽なら不透明度に触れず、高さだけを畳む（先に別の形で薄れ切った札の後始末。右下の知らせ）。
 */
export function collapseOut(el: HTMLElement, axis: 'y' | 'x' = 'y', opts: { fade?: boolean } = {}): Promise<void> {
  if (!motionOn(el)) return Promise.resolve();
  const size = sizeOf(el, axis);
  const p = prop(axis);
  const edge = edgesZero(axis);
  const overflow = el.style.overflow;
  el.style.overflow = 'hidden';
  const frames: Keyframe[] = opts.fade === false
    ? [{ [p]: `${size}px` }, { [p]: '0px', ...edge }]
    : [{ [p]: `${size}px`, opacity: 1 }, { opacity: 0, offset: 0.6 }, { [p]: '0px', opacity: 0, ...edge }];
  const a = el.animate(frames, { duration: motionMs('--dur-exit', el) + motionMs('--dur-fast', el), easing: motionEase('--ease-in', el), fill: 'forwards' });
  // 終わったら要素は外されるので隠したままにする。取り消された（出る途中で戻った）ときだけ、元の指定に戻す。
  return a.finished.then(() => undefined, () => { el.style.overflow = overflow; });
}

/**
 * 横へ抜ける形。薄れながら dx（px）だけ横へ動き、最後の形を残す。--dur-exit、--ease-in で動かす。
 * 右下の知らせが出るときに使い、そのあと collapseOut の fade: false で高さを畳む。
 * 抜け切ったら真で、途中で取り消された（出る途中で戻った）ら偽で解決する。呼び手は偽なら続きの畳みを始めない。動かないときはすぐ真で解決する。
 */
export function slideAway(el: HTMLElement, dx: number): Promise<boolean> {
  if (!motionOn(el)) return Promise.resolve(true);
  return el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${dx}px)` }], { duration: motionMs('--dur-exit', el), easing: motionEase('--ease-in', el), fill: 'forwards' }).finished.then(() => true, () => false);
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
