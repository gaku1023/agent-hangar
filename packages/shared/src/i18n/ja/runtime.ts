import type { runtimeKeys } from '../keys/runtime.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const runtimeJa: AreaDictionary<typeof runtimeKeys> = {
  'runtime.notify.blocked': '通知が切られています。システム設定の「通知」で Hangar を許可してください',
  'runtime.notify.denied': '通知が許可されませんでした',
  'runtime.notify.returnBody': 'リマインダーの時刻 {time} を過ぎました',
  'runtime.notify.returnBodyNote': 'リマインダーの時刻 {time} を過ぎました · {note}',
  'runtime.copy.failed': 'コピーできませんでした。文字を選択して {keys} でコピーしてください',
  'runtime.shell.openLogFailed': 'ログを開けませんでした',
  'runtime.shell.restartFailed': '再起動できませんでした',
  'runtime.shell.pickFolderFailed': 'フォルダを選べませんでした',
  'runtime.shell.restoreFailed': '設定を戻せませんでした',
  'runtime.shell.unreadable': '殻の返事を読めませんでした。',
  'runtime.tab.noClaude': 'Claude が実行中ではないので、シェルタブを開けません',
  'runtime.retention.previewLoading': '差分を読み込んでいます。少し待ってから押してください',
  'runtime.retention.set': '保持期間を {days}にしました',
  'runtime.openTerminal.fellBack': 'iTerm2 で開けなかったので Terminal.app で開きました',
};
