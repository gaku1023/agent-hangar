import type { readinessKeys } from '../keys/readiness.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const readinessJa: AreaDictionary<typeof readinessKeys> = {
  'readiness.fix.claude': 'claude コマンドの絶対パスを入力してください',
  'readiness.fix.code': 'VS Code から code コマンドをインストールしてください',
  'readiness.fix.node': '同梱のサーバと同じメジャー版の Node のパスを入力してください',
  'readiness.fix.workspace': 'セッションのあるディレクトリをまとめた場所を入力してください',
  'readiness.problem.unset': '見つかりません',
  'readiness.problem.notFile': '{path} はファイルではありません',
  'readiness.problem.notExecutable': '{path} には実行権がありません',
  'readiness.problem.missing': '{path} が見つかりません',
  'readiness.tool.autoFound': '自動で見つけました',
  'readiness.tool.optional': '無くても動きます',
  'readiness.workspace.empty': '直下に、Claude のセッションがあるディレクトリがありません',
  'readiness.workspace.projects': 'プロジェクト {n} 件',
};
