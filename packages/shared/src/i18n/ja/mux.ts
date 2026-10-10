import type { muxKeys } from '../keys/mux.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const muxJa: AreaDictionary<typeof muxKeys> = {
  'mux.status.notInstalled': '{name} がインストールされていません',
  'mux.status.stillMissing': '{name} がまだ見つかりません。インストールしたあと、Hangar の再起動が必要な場合があります',
  'mux.action.recheck': '再確認',
  'mux.action.checking': '確認中…',
  'mux.badge.installed': 'インストール済み',
  'mux.badge.missing': '未インストール',
  'mux.info.version': 'バージョン {version}',
  'mux.desc.windows': 'セッションの実行と保持に使います。Windows では tmux の代わりに psmux を使います',
  'mux.desc.other': 'セッションの実行と保持に使います',
  'mux.run.windows': 'PowerShell で次のコマンドを実行してください',
  'mux.run.other': 'ターミナルで次のコマンドを実行してください',
  'mux.guide.title': 'セッションを開始するには {name} が必要です',
  'mux.guide.lead.windows': 'Windows では psmux が tmux の代わりにセッションを保持します。PowerShell で次のコマンドを実行してください',
  'mux.guide.lead.other': 'tmux がセッションを保持します。ターミナルで次のコマンドを実行してください',
  'mux.guide.recheck': 'インストールしたので再確認',
  'mux.guide.found.title': '{name} を確認しました',
  'mux.guide.found.lead': 'バージョン {version} が見つかりました。セッションを開始します',
  'mux.guide.found.leadNoVersion': '見つかりました。セッションを開始します',
  'mux.guide.start': '開始',
};
