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

/**
 * 伸び縮みの間だけ、はみ出しを隠す（overflow: hidden）。元の指定は要素ごとに 1 つだけ控え、外すのはいちばん新しい動きの後始末だけにする。
 * 畳み終えた箱は隠したまま置かれる（外される要素ではそのまま消え、FoldBox の keep やホームの引き出しでは次に伸ばすまで残る）。
 * そのときも控えは残し、次に伸ばした動きが終わったら畳む前の指定へ戻す。
 * 畳む途中で開き直すと、取り消した畳みの後始末は非同期に遅れて届く。世代を比べ、伸びている最中の hidden を外させない。
 */
const clipped = new WeakMap<HTMLElement, { overflow: string; gen: number }>();
function clip(el: HTMLElement): number {
  const prev = clipped.get(el);
  const gen = (prev?.gen ?? 0) + 1;
  clipped.set(el, { overflow: prev ? prev.overflow : el.style.overflow, gen });
  el.style.overflow = 'hidden';
  return gen;
}
/** gen の動きがまだいちばん新しければ、控えた指定へ戻す。gen を省くと世代を問わず戻す。 */
function unclip(el: HTMLElement, gen?: number): void {
  const c = clipped.get(el);
  if (!c || (gen !== undefined && c.gen !== gen)) return;
  el.style.overflow = c.overflow;
  clipped.delete(el);
}

/**
 * いまの形。高さ（横なら幅）、不透明度、その向きの余白の計算済みの値で、動きの途中なら途中の値を読む。
 * 畳む途中で開き直すとき、畳む動きを取り消す前に読んで growIn に渡すと、0 へ跳ばずにその形から伸び直す。
 */
export function shapeNow(el: HTMLElement, axis: 'y' | 'x' = 'y'): Keyframe {
  const r = el.getBoundingClientRect();
  const opacity = getComputedStyle(el).getPropertyValue('opacity') || '1';
  return { [prop(axis)]: `${axis === 'y' ? r.height : r.width}px`, opacity, ...edgesNow(el, axis) };
}

/**
 * 伸びて入る形。高さ（横なら幅）と、その向きの余白を 0 から伸ばし、下（右）の要素を押して滑らせる。伸びる間は中身をはみ出させない。
 * from（shapeNow で読んだ形）を渡すと、0 からでなくその形から伸ばす。途中からなので、ぼかしは掛けない。
 */
export function growIn(el: HTMLElement, axis: 'y' | 'x' = 'y', from?: Keyframe): Animation | null {
  if (!motionOn(el)) { unclip(el); return null; }
  const size = sizeOf(el, axis);
  const p = prop(axis);
  // 余白は動かし始める前に読む（動きの最初の形は 0 なので、あとから読むと 0 になる）。
  const edges = edgesNow(el, axis);
  const gen = clip(el);
  const start: Keyframe[] = from ? [from] : [
    { [p]: '0px', opacity: 0, filter: `blur(${motionValue('--blur-in', el)})`, ...edgesZero(axis) },
    { offset: 0.2, filter: 'none' },
  ];
  const a = el.animate([...start, { [p]: `${size}px`, opacity: 1, filter: 'none', ...edges }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
  const restore = () => unclip(el, gen);
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
  const gen = clip(el);
  const frames: Keyframe[] = opts.fade === false
    ? [{ [p]: `${size}px` }, { [p]: '0px', ...edge }]
    : [{ [p]: `${size}px`, opacity: 1 }, { opacity: 0, offset: 0.6 }, { [p]: '0px', opacity: 0, ...edge }];
  const a = el.animate(frames, { duration: motionMs('--dur-exit', el) + motionMs('--dur-fast', el), easing: motionEase('--ease-in', el), fill: 'forwards' });
  // 終わったら隠したままにする（外されるか、次に伸ばすまで隠れている）。取り消された（出る途中で戻った）ときだけ、元の指定に戻す。
  return a.finished.then(() => undefined, () => unclip(el, gen));
}

/**
 * ダイアログを引っ込める形。背景（.overlay）を薄れさせ、板（.dialog）を少し沈めて縮める。開くときの pop を逆にたどる。
 * 終わったら解決する。取り消されたとき（引っ込める途中で開き直したとき）と、動かないときも解決する。
 */
export function popOut(overlay: HTMLElement): Promise<void> {
  if (!motionOn(overlay)) return Promise.resolve();
  const opts: KeyframeAnimationOptions = { duration: motionMs('--dur-exit', overlay), easing: motionEase('--ease-in', overlay), fill: 'forwards' };
  const a = overlay.animate([{ opacity: 1 }, { opacity: 0 }], opts);
  overlay.querySelector<HTMLElement>('.dialog')?.animate([{ transform: 'none' }, { transform: 'translateY(4px) scale(0.96)' }], opts);
  return a.finished.then(() => undefined, () => undefined);
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
export function slideFrom(el: HTMLElement, before: Pick<DOMRect, 'left' | 'top'>, after: Pick<DOMRect, 'left' | 'top'>): Animation | null {
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

/**
 * 並びが替わった描画で「上がった」行の key。前と今の両方にある行だけで互いの順を比べ、前より前へ出た行を返す。
 * 足した行と消えた行は数えない（消えた行の下が詰まっただけの描画では、どれも上がっていない）。
 * ホームの一覧と引き出しは、並びを滑らせず、上がった行と新しい行に markHit だけを付ける（設計書「Home の一覧」）。
 */
export function risenKeys(before: readonly string[], after: readonly string[]): Set<string> {
  const inAfter = new Set(after);
  const inBefore = new Set(before);
  const was = new Map(before.filter((k) => inAfter.has(k)).map((k, i) => [k, i]));
  const out = new Set<string>();
  after.filter((k) => inBefore.has(k)).forEach((k, i) => { if (i < was.get(k)!) out.add(k); });
  return out;
}
