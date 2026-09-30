/**
 * 動きのトークン（styles/tokens.css）を JS から読む。
 * 長さと曲線は CSS と同じ値を使い、JS に数値を直書きしない。
 * reduced motion では tokens.css が長さを 0 にするので、ここも 0 を返す。
 */
export type DurationToken = '--dur-fast' | '--dur' | '--dur-exit';
export type MotionToken = DurationToken | '--ease-out' | '--ease-in' | '--rise' | '--blur-in';

/** トークンの計算済みの値。読めなければ空文字。 */
export function motionValue(token: MotionToken, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(token).trim();
}

/**
 * 「420ms」「0.25s」「.42s」をミリ秒の数にする。読めない値は 0 にし、動かさない側へ倒す。
 * build の CSS の圧縮は 420ms を .42s に書き換えるので、先頭の 0 を省いた書き方も読む。
 */
export function parseDuration(v: string): number {
  const m = /^(\d+(?:\.\d+)?|\.\d+)(ms|s)$/.exec(v.trim());
  if (!m) return 0;
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

export function motionMs(token: DurationToken, el?: Element): number {
  return parseDuration(motionValue(token, el));
}

/** 曲線。Web Animations は空の曲線で例外を投げるので、読めなければ linear にする。 */
export function motionEase(token: '--ease-out' | '--ease-in', el?: Element): string {
  return motionValue(token, el) || 'linear';
}
