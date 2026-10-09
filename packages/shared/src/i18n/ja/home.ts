import type { homeKeys } from '../keys/home.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const homeJa: AreaDictionary<typeof homeKeys> = {
  'home.band.label': 'ホームの件数',
  'home.band.attention': '要対応',
  'home.band.running': '実行中',
  'home.band.pending': '確認待ち',
  'home.band.attentionSummary': '入力待ち {waiting}、今日のリマインダー {reminders}',
  'home.band.runningSummary': '作業中 {busy}、アイドル {idle}',
  'home.band.pendingSummary': '提案 {n}',
  'home.band.collapse': '折りたたむ',
  'home.band.searchNote': '検索中は引き出しを閉じています',
  'home.band.waited': '{time}待機',
  'home.band.working': '作業中 {time}',
  'home.band.external': '外部ターミナルで実行中',
  'home.band.noDate': '日付なし',
  'home.band.reminderTime': 'リマインダーの時刻 {time}',
  'home.band.answer': 'ターミナルで回答',
  'home.band.move': 'hangar に移動',
  'home.band.open': '開く',
  'home.band.changeDate': '日付を変更',
  'home.band.confirm': '確定',
  'home.band.dismiss': '却下',
  'home.band.actionFor': '{action}、{name}',
};
