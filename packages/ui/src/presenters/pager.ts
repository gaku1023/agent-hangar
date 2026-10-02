import { PAGE_SIZES } from '../mediator/paging.ts';

/**
 * 一覧のページ送り（A4）。page は 1 から数え、from と to はそのページの最初と最後の行が全件の何件目か（1 から）。
 * sizes は 1 ページの件数の選択肢で、size が選んでいるもの。total は全件の数。
 */
export type PagerProps = { page: number; pageCount: number; size: number; sizes: readonly number[]; from: number; to: number; total: number };

/**
 * ページ送りを組む。全件がいちばん小さい件数に収まるなら出さない。
 * ページが後ろの端を越えていたら（件数を変えた後や、行が減った後など）、最後のページに丸める。
 */
export function pagerOf(page: number, size: number, total: number): PagerProps | null {
  if (total <= PAGE_SIZES[0]) return null;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, page), pageCount);
  return { page: p, pageCount, size, sizes: PAGE_SIZES, from: (p - 1) * size + 1, to: Math.min(p * size, total), total };
}

/** いまのページの分を切り出す。ページ送りが無ければ全部。 */
export function pageSlice<T>(list: T[], pager: PagerProps | null): T[] {
  return pager ? list.slice(pager.from - 1, pager.to) : list;
}
