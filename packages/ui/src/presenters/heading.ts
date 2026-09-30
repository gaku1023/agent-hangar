import type { Route } from '@agent-hangar/shared';

/** 頁の見出しの上に出す、親へのリンク。セッションは属するプロジェクトへ、プロジェクト詳細は一覧へ戻る。 */
export type ParentLink = { label: string; route: Route };
