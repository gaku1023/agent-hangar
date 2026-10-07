/**
 * 互換の版番号（作り替えの全体計画の D10）。
 *
 * hangar の部品のうち、別々に上がりうるのは、端末どうし（同期で Worker を挟む）、端末と Worker、殻と 4177 のサーバである。
 * それぞれが 1 つの整数を名乗り、相手に下限を持つ。下限より古い相手とは話さずに、理由を出して止まる。
 * UI とサーバと CLI は同じ束で配るので、この番号を持たない。
 *
 * 上げるのは、同期の形、Worker の API、殻とサーバの合図を、古い相手と話せない形で変えるときだけである。
 * 項目を足すだけで古い相手も読める変更では上げない（docs/design.md「互換の版番号」）。
 */
export const COMPAT_VERSION = 1;

/** 版を運ぶ見出し（X-Hangar-Compat）。端末は要求に、Worker は応答に、自分の版を載せる。 */
export const COMPAT_HEADER = 'x-hangar-compat';

/** 要求に足す見出し。サーバの同期の client、CLI、Worker の試験の道具が同じものを使う。 */
export function compatHeaders(): Record<string, string> {
  return { [COMPAT_HEADER]: String(COMPAT_VERSION) };
}

/**
 * 相手が名乗った版を読む。
 * 見出しが無いのは、版番号を入れる前の古い相手である。版 0 として読む。
 * 整数として読めない値（空、負、小数、指数、16 進、桁あふれ）も版 0 にする。相手の言い分を大きく読む向きには倒さない。
 */
export function parseCompat(v: string | null | undefined): number {
  const t = (v ?? '').trim();
  if (!/^\d+$/.test(t)) return 0;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : 0;
}

/** Worker が、下限より古い端末に 426 で返す本文。minCompat は Worker が求める下限、compat は Worker の版である。 */
export type CompatRefusalBody = { error: 'upgrade required'; minCompat: number; compat: number };

export function compatRefusalBody(minCompat: number): CompatRefusalBody {
  return { error: 'upgrade required', minCompat, compat: COMPAT_VERSION };
}

/** 426 の本文から、相手が求める下限を読む。形が違えば null を返す（例外を投げない）。 */
export function readCompatRefusal(text: string): number | null {
  try {
    const v = JSON.parse(text) as Partial<CompatRefusalBody> | null;
    if (!v || v.error !== 'upgrade required') return null;
    const n = v.minCompat;
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
