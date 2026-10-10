import type { ProjectDto, Translate } from '@agent-hangar/shared';

/**
 * プロジェクトの表示名。
 * プロジェクトに属さないセッションのまとまり（擬似プロジェクト）は、DB に入っている名前ではなく辞書の名前で出す。
 * DB の名前は同期で端末をまたぐので、どの言語の端末が作っても、いまの言語の名前で見えるようにする。
 * 一覧の行、絞り込みの選択肢と条件、欄の project: の語、画面の見出し、札、パレットの副題は、すべてここを通す。
 */
export function projectDisplayName(p: Pick<ProjectDto, 'name' | 'isScratch'>, t: Translate): string {
  return p.isScratch ? t('project.name.quick') : p.name;
}
