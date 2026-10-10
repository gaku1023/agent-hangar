import type { readinessKeys } from '../keys/readiness.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const readinessJa: AreaDictionary<typeof readinessKeys> = {
  'readiness.fix.claude': 'claude コマンドの絶対パスを入れてください',
  'readiness.fix.code': 'VS Code から code コマンドを入れてください',
  'readiness.fix.node': '同梱のサーバと同じメジャー版の Node のパスを入れてください',
  'readiness.fix.workspace': 'セッションのあるディレクトリをまとめた場所を入れてください',
  'readiness.problem.unset': '見つかりません',
  'readiness.problem.notFile': '{path} はファイルではありません',
  'readiness.problem.notExecutable': '{path} には実行権がありません',
  'readiness.problem.missing': '{path} が見つかりません',
  'readiness.tool.autoFound': '自動で見つけました',
  'readiness.tool.optional': '無くても動きます',
  'readiness.workspace.empty': '直下に、Claude のセッションがあるディレクトリがありません',
  'readiness.workspace.projects': 'プロジェクト {n} 件',
};
