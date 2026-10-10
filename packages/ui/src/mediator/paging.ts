import type { Step, State } from './types.ts';

/** 1 ページの件数を残す localStorage の鍵。値は件数そのもの。 */
export const PAGE_SIZE_KEY = 'sessions.pageSize';
/** 1 ページの件数の選択肢。サーバは 1 回に 200 件まで返す（server/src/search/search.ts の MAX_LIMIT）。 */
export const PAGE_SIZES = [25, 50, 100, 200] as const;
export const PAGE_SIZE_DEFAULT = 50;

/** 保存から読んだ件数。選択肢に無い値（手で書き換えられたなど）は既定に戻す。 */
export function readPageSize(v: unknown): number {
  return typeof v === 'number' && (PAGE_SIZES as readonly number[]).includes(v) ? v : PAGE_SIZE_DEFAULT;
}

/** 1 より前へは行かない。後ろの端は件数を知る Presenter が丸める。 */
const atLeastOne = (page: number) => Math.max(1, Math.floor(page));

/** 一覧（ホームとプロジェクトの画面）のページを移る。 */
export function pageStep(state: State, page: number): State {
  return { ...state, search: { ...state.search, page: atLeastOne(page) } };
}

/**
 * 1 ページの件数を変える。どの一覧も同じ件数を使う。
 * 見ていたページの先頭の行を含むページに留まる（50 件ずつの 3 ページ目の先頭は 101 件目で、100 件ずつなら 2 ページ目）。
 * 選択肢に無い件数は受け取らない。
 */
export function pageSizeStep(state: State, size: number): Step | null {
  if (!(PAGE_SIZES as readonly number[]).includes(size)) return null;
  const keep = (page: number) => Math.floor(((page - 1) * state.pageSize) / size) + 1;
  return {
    state: { ...state, pageSize: size, search: { ...state.search, page: keep(state.search.page) } },
    effects: [{ kind: 'storage.save', key: PAGE_SIZE_KEY, value: size }],
  };
}
