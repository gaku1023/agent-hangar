import { beginLayoutMotion, endLayoutMotion } from './layoutMotion.ts';
import { motionEase, motionMs } from './motion.ts';

/**
 * 統括の柱の開閉の動き（試作の案 A）。
 * 外側の箱（panel）だけ幅を伸び縮みさせて切り抜き、中身（inner）は動きの間だけ開いたときの幅に留める。
 * 中の文は折り返し直されず、会話の列の高さも変わらないので、スクロール位置は動かない。
 * 長さと曲線は右の欄（paneMotion.ts）と同じ --dur と --ease-out で、閉じるときも同じ曲線にする（右の欄と同時に始まり、同時に終わる）。
 * 動いている間は panel に data-layout-moving を付け、端末は止まってから 1 度だけ寸法を合わせる。
 */
const ID = 'pillar-motion';

/** 柱の動きの世代。捨てた動きの後始末が、新しい動きの固定を外さないようにする。 */
const generation = new WeakMap<HTMLElement, number>();

function play(panel: HTMLElement, inner: HTMLElement | null, from: { width: number; opacity: number }, to: { width: number; opacity: number }, pinned: number, release: boolean): Promise<void> | null {
  const dur = motionMs('--dur', panel);
  if (!dur || typeof panel.animate !== 'function') return null;
  const gen = (generation.get(panel) ?? 0) + 1;
  generation.set(panel, gen);
  if (inner && pinned > 0) { inner.style.width = `${pinned}px`; inner.style.minWidth = `${pinned}px`; inner.style.flex = 'none'; }
  beginLayoutMotion(panel);
  const a = panel.animate(
    [{ width: `${from.width}px`, opacity: from.opacity }, { width: `${to.width}px`, opacity: to.opacity }],
    { duration: dur, easing: motionEase('--ease-out', panel), fill: 'forwards', id: ID },
  );
  const done = () => {
    if (generation.get(panel) === gen) {
      // 閉じ終えた柱は外されるので、幅は留めたままにする（外す前の 1 コマで、0 幅に折り返し直さない）。
      // 開き終えたときだけ、固定と動きを外して CSS の幅に任せる（窓の大きさが変わっても追う）。
      if (release) {
        if (inner) { inner.style.width = ''; inner.style.minWidth = ''; inner.style.flex = ''; }
        a.cancel();
      }
    }
    endLayoutMotion(panel);
  };
  return a.finished.then(done, done);
}

/** 開く。開いたときの幅まで 0 から広げる。終わったら動きを外して、CSS の幅に戻す。 */
export function pillarOpen(panel: HTMLElement, inner: HTMLElement | null): Promise<void> | null {
  const w = panel.getBoundingClientRect().width;
  if (w <= 0) return null;
  return play(panel, inner, { width: 0, opacity: 0 }, { width: w, opacity: 1 }, w, true);
}

/** 閉じる。いまの幅から 0 へ畳む。終わったら解決し、畳んだ形を残す（呼び出し側が外す）。 */
export function pillarClose(panel: HTMLElement, inner: HTMLElement | null): Promise<void> | null {
  const r = panel.getBoundingClientRect();
  const pinned = inner ? Number.parseFloat(inner.style.width) || inner.getBoundingClientRect().width : r.width;
  const opacity = Number(getComputedStyle(panel).opacity) || 1;
  return play(panel, inner, { width: r.width, opacity }, { width: 0, opacity: 0 }, pinned, false);
}
