/**
 * 版の文字列（0.19.0、0.19.0-rc.1 など）の数の部分を比べる。
 * 前置きの語（rc など）は見ず、major、minor、patch の順に比べる。読めない版は、足りないものとして扱う。
 */
function core(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** have が need 以上か。have が無いか読めなければ false。need が読めなければ、比べられないので true。 */
export function versionAtLeast(have: string | null | undefined, need: string): boolean {
  const n = core(need);
  if (!n) return true;
  const h = have ? core(have) : null;
  if (!h) return false;
  for (let i = 0; i < 3; i++) {
    if (h[i]! !== n[i]!) return h[i]! > n[i]!;
  }
  return true;
}
