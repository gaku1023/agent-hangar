import { beginLayoutMotion, endLayoutMotion } from './layoutMotion.ts';
import { motionEase, motionMs, motionValue } from './motion.ts';

/**
 * 右の欄の開閉の動き（設計書 ②、案 A「下へ潜る」）。
 * 列の幅は minmax と px の間では補間されないので、前の形と今の形の計算値（px の並び）を測り、Web Animations で埋める。
 * 前の形は、インラインの値を一瞬だけ当てて測り、元に戻す。同じ描画の中なので、戻した形は画面に出ない。
 * 欄の中身（inner）は、動きの間だけ開いたときの幅に留め、列が狭まっても折り返さずに列の端に切られる。
 * 動いている間は data-layout-moving を付け、端末は止まってから 1 度だけ寸法を合わせる。
 */
export type PaneShape = { cols: string; gap: string };

export const PANE_SHAPE = {
  /** 実行中（.split）。開いた列は今と同じ minmax(240px, 26%)。 */
  split: { open: { cols: 'minmax(0, 1fr) minmax(240px, 26%)', gap: 'calc(var(--u) * 2)' }, closed: { cols: 'minmax(0, 1fr) 0px', gap: '0px' } },
  /** 終わった画面（.session-body）。 */
  rail: { open: { cols: 'minmax(0, 1fr) 340px', gap: 'calc(var(--u) * 3)' }, closed: { cols: 'minmax(0, 1fr) 0px', gap: '0px' } },
} as const satisfies Record<string, { open: PaneShape; closed: PaneShape }>;

const ID = 'pane-motion';

/** 箱ごとの動きの世代。 */
const generation = new WeakMap<HTMLElement, number>();

function measure(box: HTMLElement, inner: HTMLElement | null) {
  const cs = getComputedStyle(box);
  return { cols: cs.gridTemplateColumns, gap: cs.columnGap, innerW: inner?.getBoundingClientRect().width ?? 0 };
}

export function playPaneMotion(box: HTMLElement, from: PaneShape, inner: HTMLElement | null, opening: boolean): Promise<void> | null {
  const dur = motionMs('--dur', box);
  if (!dur || typeof box.animate !== 'function') return null;
  // 開閉し直したら、前の動きを捨ててから測る。残すと、途中の形を前の形として測ってしまう。
  for (const a of box.getAnimations?.({ subtree: true }) ?? []) if (a.id === ID) a.cancel();
  const to = measure(box, inner);
  const saved = { cols: box.style.gridTemplateColumns, gap: box.style.columnGap };
  box.style.gridTemplateColumns = from.cols;
  box.style.columnGap = from.gap;
  const before = measure(box, inner);
  box.style.gridTemplateColumns = saved.cols;
  box.style.columnGap = saved.gap;

  beginLayoutMotion(box);
  // 中身は開いたときの幅に留める。閉じるときは前の形、開くときは今の形がその幅である。
  const width = opening ? to.innerW : before.innerW;
  // 縦の伸び（flex）には触れない。縦に伸びる中身の高さを奪うと、目次のスクロールが先頭へ戻る。幅は min-width も留め、横に並ぶ箱（終わった画面の欄）でも縮まないようにする。
  if (inner && width > 0) { inner.style.width = `${width}px`; inner.style.minWidth = `${width}px`; }
  const easing = motionEase('--ease-out', box);
  const cols = box.animate([{ gridTemplateColumns: before.cols, columnGap: before.gap }, { gridTemplateColumns: to.cols, columnGap: to.gap }], { duration: dur, easing, id: ID });
  if (inner) {
    const blur = `blur(${motionValue('--blur-in', box)})`;
    if (opening) inner.animate([{ opacity: 0, filter: blur }, { offset: 0.35, filter: 'none' }, { opacity: 1, filter: 'none' }], { duration: dur, easing, id: ID });
    else inner.animate([{ opacity: 1 }, { opacity: 0, filter: blur }], { duration: motionMs('--dur-exit', box), easing: motionEase('--ease-in', box), fill: 'forwards', id: ID });
  }
  // 後始末は、いちばん新しい動きのものだけが行う。捨てた動きの後始末（非同期に来る）が、新しい動きの印や幅を外さないようにする。
  const gen = (generation.get(box) ?? 0) + 1;
  generation.set(box, gen);
  const done = () => {
    if (generation.get(box) !== gen) return;
    if (inner) { inner.style.width = ''; inner.style.minWidth = ''; }
    endLayoutMotion(box);
  };
  // 取り消されたときも後始末する（世代が替わっていなければ、新しい動きは無く、印が残ってしまう）。
  return cols.finished.then(done, done);
}
