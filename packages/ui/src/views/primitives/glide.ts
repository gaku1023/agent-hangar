import { motionEase, motionMs } from './motion.ts';

/**
 * CSS の cubic-bezier(x1, y1, x2, y2) を、時間の割合（0〜1）から進み具合への関数にする。
 * linear と読めない曲線は、時間の割合をそのまま返す。
 */
export function easeFn(css: string): (t: number) => number {
  const m = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(css.trim());
  if (!m) return (t) => Math.min(Math.max(t, 0), 1);
  const [x1, y1, x2, y2] = m.slice(1).map(Number) as [number, number, number, number];
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // x(s) = t となる s を二分法で探す。x は s について増えるだけなので、24 回で十分に細かい。
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < t) lo = mid; else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

export type Glide = { toBottom(): void; stop(): void };

type GlideDeps = {
  frame?: (cb: () => void) => number;
  cancel?: (id: number) => void;
  now?: () => number;
  /** 長さと曲線。省けば --dur と --ease-out を器から読む。 */
  timing?: () => { ms: number; ease: (t: number) => number };
};

/**
 * 器を下端へ滑らかに寄せる。
 * WebKit の滑らかなスクロール（scrollIntoView や scrollTo の smooth）は、途中で scrollTop を書き換えても止まらず、
 * その書き換えを古い位置で上書きする（instant の scrollTo でも止まらない）。
 * 本文の追従は行の高さを測り直すたびに下端へ跳び直すので、ブラウザに任せると上へ引き戻され、
 * それを利用者が戻したと読んで追従が切れ、古い下端で止まっていた。
 * ここでは 1 フレームずつ自分で動かし、跳ぶ側が先に stop() で止める。
 * 寄せ先は毎フレームその時の下端を読み直すので、動いている間に行が伸びても末尾を外さない。
 */
export function createGlide(el: HTMLElement, deps: GlideDeps = {}): Glide {
  const frame = deps.frame ?? ((cb) => requestAnimationFrame(cb));
  const cancel = deps.cancel ?? ((id) => cancelAnimationFrame(id));
  const now = deps.now ?? (() => performance.now());
  const timing = deps.timing ?? (() => ({ ms: motionMs('--dur', el), ease: easeFn(motionEase('--ease-out', el)) }));
  let id: number | null = null;
  const stop = () => {
    if (id !== null) cancel(id);
    id = null;
  };
  const bottom = () => Math.max(el.scrollHeight - el.clientHeight, 0);
  return {
    stop,
    toBottom() {
      stop();
      const { ms, ease } = timing();
      if (ms <= 0) { el.scrollTop = bottom(); return; }
      const from = el.scrollTop;
      const t0 = now();
      let last = from;
      const step = () => {
        id = null;
        // 前のフレームで置いた位置より上にあるなら、利用者が戻した。追うのは任せて、ここで手を引く。
        if (el.scrollTop < last - 1) return;
        const t = Math.min((now() - t0) / ms, 1);
        el.scrollTop = from + (bottom() - from) * ease(t);
        last = el.scrollTop;
        if (t < 1) id = frame(step);
      };
      id = frame(step);
    },
  };
}
