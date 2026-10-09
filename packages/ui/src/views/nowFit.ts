/**
 * 「いま」の列に、先頭から丸ごと入る項目の数。
 * widths は項目 1 つずつの幅、gap は項目の間の隙間、available は列の幅、moreWidth は「ほか N」の札の幅である。
 * 全部入るなら全部を数える。入り切らないときは、「ほか N」の札の分を空けて、丸ごと入る数だけを数える。
 * 項目を途中で切らないための数で、View が測った幅を渡す。
 * 幅がまだ測れていない（available が 0 以下）ときは、全部を出す。
 */
export function fitCount(widths: number[], gap: number, available: number, moreWidth: number): number {
  if (available <= 0) return widths.length;
  const used = (k: number) => widths.slice(0, k).reduce((sum, w) => sum + w, 0) + Math.max(0, k - 1) * gap;
  if (used(widths.length) <= available) return widths.length;
  for (let k = widths.length - 1; k > 0; k--) if (used(k) + gap + moreWidth <= available) return k;
  return 0;
}

/**
 * 「ほか N」の札を必ず置くときに、先頭から丸ごと入る項目の数（現在の帯のツール呼び出し）。
 * 札の分は常に空ける。全部入っても札は置く（直近より前の呼び出しがあるため）。
 * 幅がまだ測れていない（available が 0 以下）ときは、全部を出す。
 */
export function fitCountWithMore(widths: number[], gap: number, available: number, moreWidth: number): number {
  if (available <= 0) return widths.length;
  const used = (k: number) => widths.slice(0, k).reduce((sum, w) => sum + w, 0) + Math.max(0, k - 1) * gap;
  for (let k = widths.length; k > 0; k--) if (used(k) + gap + moreWidth <= available) return k;
  return 0;
}
