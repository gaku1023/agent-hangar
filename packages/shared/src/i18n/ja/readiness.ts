import type { readinessKeys } from '../keys/readiness.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const readinessJa: AreaDictionary<typeof readinessKeys> = {
  'readiness.fix.claude': 'claude コマンドの絶対パスを入力してください',
  'readiness.fix.git': 'git をインストールしてください。git がなくても動作しますが、ブランチと未コミットの件数は表示されません',
  'readiness.fix.node': '同梱のサーバに対応するバージョンとアーキテクチャの Node を、node の実行ファイルの絶対パスで入力してください',
  'readiness.fix.workspace': '空にするか、別のディレクトリを選択してください',
  'readiness.problem.unset': '見つかりません',
  'readiness.problem.notFile': '{path} はファイルではありません',
  'readiness.problem.notExecutable': '{path} には実行権限がありません',
  'readiness.problem.missing': '{path} が見つかりません',
  'readiness.problem.notAbsolute': '{path} は絶対パスではありません',
  'readiness.problem.notNode': '{path} は Node として応答しません',
  'readiness.problem.nodeTooOld': '{path} は Node {found} です。Node {min} 以上が必要です（Node-API {napi} を使うため）',
  'readiness.problem.nodeWrongArch': '{path} は {foundArch} 用の Node です。{arch} 用の Node が必要です',
  'readiness.tool.autoFound': '自動で検出しました',
  'readiness.tool.optional': 'なくても動作します',
  'readiness.workspace.missing': 'このディレクトリが見つかりません',
  'readiness.workspace.projects': 'プロジェクト {n} 件',
};
