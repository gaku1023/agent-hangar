/**
 * JSON の形の値（サーバの DTO）が、中身として同じか。
 * 同じ中身の配信で Store を作り直さないために使う（store.ts の applyServerEvent）。作り直すと React が画面全体を描き直す。
 * 鍵の並びは問わない。undefined の値を持つ鍵と、鍵が無いことは区別する（違うと見て描き直すだけなので害は無い）。
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(rb, k) || !sameValue(ra[k], rb[k])) return false;
  return true;
}
