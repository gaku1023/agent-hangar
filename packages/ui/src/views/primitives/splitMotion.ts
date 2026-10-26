import { beginLayoutMotion, endLayoutMotion } from './layoutMotion.ts';
import { motionOn } from './motionKit.ts';
import { motionEase, motionMs, motionValue } from './motion.ts';

/**
 * 画面の分割の動き（手本は docs/plans/session-split-proto.html の動きの層）。
 * 長さと曲線は motionKit と同じトークンから読み、数値を直書きしない。
 * どの関数も、動きを減らす設定（長さ 0）と Web Animations の無い環境では何もしない（要素に触れず、null か false を返す）。
 */

export type Rect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
/** 名前の札の元の姿。位置、文字の大きさ、文字。 */
export type NameSnap = { text: string; rect: Rect; font: number };

/** --ease-out（cubic-bezier(0.16, 1, 0.3, 1)）に近い指数の曲線。こまごとに補間する名前の札が使う。 */
const easeOutExpo = (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const lerp = (a: number, b: number, e: number): number => a + (b - a) * e;

const enterBlur = (el: Element) => `blur(${motionValue('--blur-in', el)})`;

/** afterHeavyFrames が動きを止めている間の印。名前の札は、これが解けてから飛び始める。 */
let held: Promise<void> | null = null;
/** こまの間隔がこれ以下に戻ったら、重いこまは過ぎたとみなす。 */
const SMOOTH_FRAME_MS = 20;
/** 重いこまが続いても、これより長くは待たせない。 */
const HOLD_MAX_MS = 250;

/**
 * run の中で作られた動きを止めておき、描き替えの重いこま（ペインの端末の作り直しなど）が過ぎてから動かす。
 * 曲線は出だしに動きが寄っているので、重いこまの間に動かすと、動きの大半が 1 こまで跳ぶ。
 * 止めている間は最初の形（閉じたペインはそのまま、残るペインは元の大きさ）で見えている。
 * getAnimations の無い環境と動きを減らす設定では、run を呼ぶだけ。
 */
export function afterHeavyFrames(run: () => void): void {
  if (typeof document.getAnimations !== 'function' || !motionOn(document.documentElement)) { run(); return; }
  const before = new Set(document.getAnimations());
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  held = gate;
  try { run(); } finally { if (held === gate) held = null; }
  // 中で終わらせた動き（settleEntrance）は数えない。止めて動かし直すと、頭からやり直す。
  const made = document.getAnimations().filter((a) => !before.has(a) && a.playState === 'running');
  for (const a of made) a.pause();
  let first = -1;
  let last = -1;
  const frame = (now: number) => {
    if (first < 0) first = now;
    const smooth = last >= 0 && now - last <= SMOOTH_FRAME_MS;
    last = now;
    if (!smooth && now - first < HOLD_MAX_MS) { requestAnimationFrame(frame); return; }
    for (const a of made) a.play();
    release();
  };
  requestAnimationFrame(frame);
}

/**
 * root の中の画面（.screen）の入場（CSS の enter）を、すぐ終わらせる。
 * 分割の形が替わると、ペインの中の画面は描き直されて入場をやり直し、不透明度 0 から出る。その間、ペインの白い地が透ける。
 * 出入りは分割の動きが受け持つので、画面の入場は重ねない。ほかの CSS の動き（端末の縁の明滅など）には触れない。
 */
export function settleEntrance(root: Element): void {
  if (typeof root.getAnimations !== 'function') return;
  for (const a of root.getAnimations({ subtree: true })) {
    const target = (a.effect as KeyframeEffect | null)?.target;
    if ((a as CSSAnimation).animationName === 'enter' && target instanceof Element && target.classList.contains('screen')) a.finish();
  }
}

/** いまの姿を NameSnap に写す。 */
export function nameSnap(el: HTMLElement): NameSnap {
  const r = el.getBoundingClientRect();
  return { text: el.textContent ?? '', rect: { left: r.left, top: r.top, width: r.width, height: r.height }, font: parseFloat(getComputedStyle(el).fontSize) || 0 };
}

/**
 * 名前の札を、元の位置から target まで、位置と文字の大きさを補間しながら飛ばす。
 * 行き先は毎こま測り直す（ペインも見出しも同時に動いているため）。飛んでいる間、target は隠す。
 * 動かないときは null。動くときは、途中で止めて後始末をする関数を返す（終われば自分で後始末する）。
 */
export function flyName(from: NameSnap, target: HTMLElement | null, done?: () => void): (() => void) | null {
  if (!target || !motionOn(target)) return null;
  const dur = motionMs('--dur', target);
  const cs = getComputedStyle(target);
  const toFont = parseFloat(cs.fontSize) || from.font;
  const c = document.createElement('div');
  c.className = 'pane-fly';
  c.textContent = from.text;
  c.style.fontSize = `${from.font}px`;
  if (cs.fontFamily) c.style.fontFamily = cs.fontFamily;
  document.body.appendChild(c);
  const hidden = target.style.visibility;
  target.style.visibility = 'hidden';
  let t0 = -1;
  let raf = 0;
  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    cancelAnimationFrame(raf);
    c.remove();
    target.style.visibility = hidden;
    done?.();
  };
  const frame = (now: number) => {
    if (over) return;
    // 測り始めは最初のこま。作った時刻から数えると、描き替えの重いこまの分だけ跳ぶ。
    if (t0 < 0) t0 = now;
    const t = Math.min(1, (now - t0) / dur);
    const e = easeOutExpo(t);
    const to = target.getBoundingClientRect();
    c.style.fontSize = `${lerp(from.font, toFont, e)}px`;
    const fromCy = from.rect.top + from.rect.height / 2;
    const toCy = to.top + to.height / 2;
    c.style.left = `${lerp(from.rect.left, to.left, e)}px`;
    c.style.top = `${lerp(fromCy, toCy, e) - c.offsetHeight / 2}px`;
    if (t < 1) raf = requestAnimationFrame(frame);
    else finish();
  };
  // 飛び始めるまで（afterHeavyFrames が止めている間）は、元の位置で待つ。
  c.style.left = `${from.rect.left}px`;
  c.style.top = `${from.rect.top}px`;
  const start = () => { if (!over) raf = requestAnimationFrame(frame); };
  if (held) void held.then(start);
  else start();
  return finish;
}

/**
 * 見出しの部品を、--stagger ずつずらして出す。dy が正なら下から、負なら上から。first は最初の部品を遅らせる段の数。
 * 一言と操作は下から（--stagger ずつ）、ペインの見出しの部品は上から出る。
 */
export function riseParts(els: readonly Element[], opts: { dy?: number; first?: number } = {}): (Animation | null)[] {
  if (els.length === 0) return [];
  const root = els[0]!;
  if (!motionOn(root)) return els.map(() => null);
  const dy = opts.dy ?? 4;
  const step = motionMs('--stagger', root);
  const base = (opts.first ?? 0) * step;
  const blur = `blur(${motionValue('--blur-in', root)})`;
  return els.map((el, i) => el.animate([{ opacity: 0, transform: `translateY(${dy}px)`, filter: blur }, { offset: 0.2, filter: 'none' }, { opacity: 1, transform: 'none', filter: 'none' }],
    { duration: motionMs('--dur', el), delay: base + i * step, easing: motionEase('--ease-out', el), fill: 'backwards' }));
}

/** 動きの間だけ、host の下の端末に寸法を合わせさせない（layoutMotion）。動きが無ければ何もしない。 */
export function holdLayout(host: HTMLElement, anims: readonly (Animation | null | undefined)[]): void {
  const live = anims.filter((a): a is Animation => !!a);
  if (live.length === 0) return;
  beginLayoutMotion(host);
  const end = () => endLayoutMotion(host);
  void Promise.allSettled(live.map((a) => a.finished)).then(end, end);
}

/** 元の位置と大きさから今の形へ（FLIP）。動いたときだけ true。動く間は前へ出す。 */
export function flipFrom(el: HTMLElement, from: Rect, to: Rect, lift = true): boolean {
  if (!motionOn(el) || !to.width || !to.height) return false;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return false;
  const z = el.style.zIndex;
  if (lift) el.style.zIndex = '5';
  const a = el.animate([{ transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transformOrigin: '0 0', transform: 'none' }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
  const restore = () => { el.style.zIndex = z; };
  a.finished.then(restore, restore);
  return true;
}

/**
 * 元の矩形から今の形へ広がる。flipFrom と違って中身を伸ばさない（端末の文字が歪まない）。
 * 元の左上へ位置だけ戻し、はみ出す分（今の方が大きい分）を右と下で切り抜いて、どちらも 0 へ戻す。
 * 動かないときは null。
 */
export function growFrom(el: HTMLElement, from: Rect, to: Rect): Animation | null {
  if (!motionOn(el) || !to.width || !to.height) return null;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const cutX = Math.max(0, to.width - from.width);
  const cutY = Math.max(0, to.height - from.height);
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && cutX < 1 && cutY < 1) return null;
  const r = getComputedStyle(el).borderTopLeftRadius;
  const round = r && r !== '0px' ? ` round ${r}` : '';
  return el.animate([{ transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(0px ${cutX}px ${cutY}px 0px${round})` }, { transform: 'none', clipPath: `inset(0px 0px 0px 0px${round})` }],
    { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
}

/** 新しいペイン（や中身が替わったペイン）が、ぼかしと縮小から出る。delay は ms。light なら縮みを浅くする（最大化を戻したとき、あとから出るペイン）。 */
export function paneEnter(el: HTMLElement, opts: { delay?: number; light?: boolean } = {}): Animation | null {
  if (!motionOn(el)) return null;
  return el.animate([{ opacity: 0, filter: enterBlur(el), transform: `scale(${opts.light ? 0.99 : 0.985})` }, { offset: 0.2, filter: 'none' }, { opacity: 1, filter: 'none', transform: 'none' }],
    { duration: motionMs('--dur', el), delay: opts.delay ?? 0, easing: motionEase('--ease-out', el), fill: 'backwards' });
}

/** 光らせる（枠が一瞬濃くなって薄れる）。長さは --dur と --dur-exit の和（試作の 700ms）。 */
export function flashPane(el: HTMLElement): Animation | null {
  if (!motionOn(el)) return null;
  return el.animate([{ boxShadow: '0 0 0 3px var(--accent-hi)' }, { offset: 0.4, boxShadow: '0 0 0 3px var(--accent-hi)' }, { boxShadow: '0 0 0 0 transparent' }],
    { duration: motionMs('--dur', el) + motionMs('--dur-exit', el), easing: motionEase('--ease-out', el) });
}

/**
 * ドロップの予告の枠の、最初の 1 回。左上から滑らせず、その場で拡大しながら出す。
 * 位置の transition を一瞬だけ切って（次のこまで）から、枠の座標が置かれた場所で縮みから戻す。
 */
export function previewIn(el: HTMLElement): Animation | null {
  if (!motionOn(el)) return null;
  el.style.transition = 'none';
  void el.offsetWidth;
  const restore = () => { el.style.transition = ''; };
  requestAnimationFrame(restore);
  return el.animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
}

/**
 * ドラッグの札の終わり。ok なら入る場所（to の中心）へ縮みながら吸い込まれ、やめたなら元の行（to の左上）へ戻る。to が無ければ、その場で薄れる。
 * 札の座標は、いまの位置を fixed の left と top に書いてから動かす。終わったら解決する。動かないときはすぐ解決する。
 */
export function landGhost(el: HTMLElement, to: Rect | null, ok: boolean): Promise<void> {
  if (!motionOn(el)) return Promise.resolve();
  const r = el.getBoundingClientRect();
  const dest = !to ? { x: r.left, y: r.top, s: 1 } : ok ? { x: to.left + to.width / 2 - r.width / 2, y: to.top + to.height / 2 - r.height / 2, s: 0.8 } : { x: to.left, y: to.top, s: 1 };
  el.style.animation = 'none';
  el.style.transform = 'none';
  el.style.left = `${r.left}px`;
  el.style.top = `${r.top}px`;
  const a = el.animate([{ left: `${r.left}px`, top: `${r.top}px`, opacity: 1, transform: 'scale(1)' }, { left: `${dest.x}px`, top: `${dest.y}px`, opacity: 0, transform: `scale(${dest.s})` }],
    ok ? { duration: motionMs('--dur-exit', el), easing: motionEase('--ease-in', el), fill: 'forwards' } : { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el), fill: 'forwards' });
  return a.finished.then(() => undefined, () => undefined);
}

/**
 * 外れる前に測った要素を、元の位置に fixed で戻す（閉じるペインと、畳まれる大きな見出しの片付け）。
 * below があれば、その直前に差し込んで z-index を付けない。同じ重なりの中で DOM の順に描かれるので、below の下に敷かれる。
 */
function ghostAt(el: HTMLElement, rect: Rect, below?: Element | null): void {
  el.style.position = 'fixed';
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  el.style.margin = '0';
  el.style.pointerEvents = 'none';
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('inert', '');
  if (below?.parentNode) below.parentNode.insertBefore(el, below);
  else {
    el.style.zIndex = '60';
    document.body.appendChild(el);
  }
  // 差し戻すと、中の画面の入場が頭からやり直す（不透明度 0 になり、白い地だけが見える）。
  settleEntrance(el);
}

/**
 * 閉じるペインが薄れる。閉じたペインの要素（外れたあと）を元の位置に戻し、below（残るもの）の下に敷く。
 * 残るものが growFrom で広がって上を覆うので、薄れるのは不透明度だけで短く、出だしを速くする。
 * ぼかしと縮みは、ペインほどの面を毎こま描き直させ、出だしの重いこま（端末の作り直し）と重なってカクつくので使わない。
 */
export function leavePane(el: HTMLElement, rect: Rect, below?: Element | null): Promise<void> {
  // まだ文書にある要素は、React がほかのペインの描画に使い回している。動かして外すと、生きているペインが消える。
  if (el.isConnected || !motionOn(document.documentElement) || typeof el.animate !== 'function') return Promise.resolve();
  ghostAt(el, rect, below);
  const a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: motionMs('--dur-exit', el), easing: motionEase('--ease-out', el), fill: 'forwards' });
  const gone = () => el.remove();
  return a.finished.then(gone, gone);
}

/** 1 つ → 分割で、外れた大きな見出しが、高さ 0 へ畳まれる。 */
export function collapseHead(el: HTMLElement, rect: Rect): Promise<void> {
  if (!motionOn(document.documentElement) || typeof el.animate !== 'function') return Promise.resolve();
  ghostAt(el, rect);
  el.style.overflow = 'hidden';
  const a = el.animate([{ height: `${rect.height}px`, opacity: 1 }, { opacity: 0, offset: 0.5 }, { height: '0px', opacity: 0 }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el), fill: 'forwards' });
  const gone = () => el.remove();
  return a.finished.then(gone, gone);
}

/** 上の余白を from px から 0 へ。畳まれる大きな見出しの分だけ、下の本体を押し下げておいて、見出しと同じ拍で戻す。 */
export function settleTop(el: HTMLElement, from: number): Animation | null {
  if (!motionOn(el) || from <= 0) return null;
  return el.animate([{ marginTop: `${from}px` }, { marginTop: '0px' }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
}

/** 中身が替わった大きな見出しの名前を、下から出し直す。 */
export function retitle(title: HTMLElement | null): Animation | null {
  if (!title || !motionOn(title)) return null;
  return riseParts([title])[0] ?? null;
}
