import type { SessionRowProps } from './row.ts';

/**
 * ホームの検索の結果の見出し（設計書 2.11.1）。名前か要約に当たった行の組と、トランスクリプトだけに当たった行の組である。
 * 件数は、読んだ行だけでは決まらないとき null になり、見出しは件数を出さない。
 */
export type SearchHeadId = 'nameMatch' | 'transcriptMatch';

/**
 * 検索の結果の項目。行と、組の見出しの和にする。
 * 一覧は平らで、見出しを挟むのはこの検索の結果だけである（段 4 の PR 10 で、節の見出しはなくした）。
 */
export type ListItem = { kind: 'row'; row: SessionRowProps } | { kind: 'head'; id: SearchHeadId; label: string; count: number | null };
