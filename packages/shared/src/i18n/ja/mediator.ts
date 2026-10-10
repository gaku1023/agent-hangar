import type { mediatorKeys } from '../keys/mediator.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const mediatorJa: AreaDictionary<typeof mediatorKeys> = {
  'mediator.connection.caughtUp': '最新の状態に追いつきました',
  'mediator.launch.pickProject': 'プロジェクトを選んでください',
  'mediator.launch.adopting': '移動中',
  'mediator.promote.nameRequired': '名前を入力してください',
  'mediator.promote.nameSlash': '名前に / と \\ は使えません',
  'mediator.promote.promoted': 'プロジェクトに昇格しました',
  'mediator.projectCreate.created': 'プロジェクトを作りました',
  'mediator.screen.noWaiting': '入力待ちのセッションはありません',
  'mediator.sessionView.splitNeedsTwoTabs': '横に並べるにはタブが 2 つ必要です',
  'mediator.settings.itermHint': 'iTerm2 で開くとき、初回に macOS の自動化の許可ダイアログが出ます',
};
