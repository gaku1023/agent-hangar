import { useEffect, useState } from 'react';

/** 窓が見えているかを読む口。ふつうは document。試験が差し替える。 */
export type VisibilitySource = {
  visibilityState: string;
  addEventListener(type: 'visibilitychange', cb: () => void): void;
  removeEventListener(type: 'visibilitychange', cb: () => void): void;
};

const defaultSource = (): VisibilitySource | null => (typeof document === 'undefined' ? null : document);

/**
 * 相対時刻や残り秒数のために、現在時刻を intervalMs ごとに進める。
 * 窓が隠れている間（visibilityState が hidden）は時計を止め、描き直さない（2026-10-14、0.6.1）。
 * 見えたときに 1 回だけ今の時刻へ進める。最小化した窓で、30 秒ごとに画面全体を描き直さないためである。
 * active が偽の間は時計を回さない（待っていない間の残り秒数など）。回し始めたときに今の時刻へ合わせる。
 * sync が変わったときも今の時刻へ合わせ直す（残り秒数の目標の時刻が変わったときなど）。
 */
export function useNow(intervalMs: number, o: { active?: boolean; source?: VisibilitySource | null; sync?: unknown } = {}): number {
  const active = o.active ?? true;
  const source = o.source === undefined ? defaultSource() : o.source;
  const sync = o.sync;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const hidden = () => source?.visibilityState === 'hidden';
    const run = () => {
      if (timer) return;
      timer = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const halt = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (hidden()) { halt(); return; }
      setNow(Date.now());
      run();
    };
    setNow(Date.now());
    if (!hidden()) run();
    source?.addEventListener('visibilitychange', onVisibility);
    return () => {
      halt();
      source?.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, active, source, sync]);
  return now;
}
