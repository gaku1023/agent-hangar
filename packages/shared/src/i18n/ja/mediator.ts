import type { mediatorKeys } from '../keys/mediator.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const mediatorJa: AreaDictionary<typeof mediatorKeys> = {
  'mediator.connection.caughtUp': '最新の状態に更新しました',
  'mediator.launch.pickProject': 'プロジェクトを選択してください',
  'mediator.launch.adopting': '移動中',
  'mediator.promote.nameRequired': '名前を入力してください',
  'mediator.promote.nameSlash': '名前に / と \\ は使えません',
  'mediator.promote.promoted': 'プロジェクトにしました',
  'mediator.projectCreate.created': 'プロジェクトを作成しました',
  'mediator.screen.noWaiting': '入力待ちのセッションはありません',
  'mediator.sessionView.splitNeedsTwoTabs': '横に並べるにはタブが 2 つ必要です',
  'mediator.settings.itermHint': 'iTerm2 で開くとき、初回に macOS の自動化の許可ダイアログが表示されます',
};
