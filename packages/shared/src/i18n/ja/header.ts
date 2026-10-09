import type { headerKeys } from '../keys/header.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const headerJa: AreaDictionary<typeof headerKeys> = {
  'header.sync.off': '同期オフ',
  'header.sync.idle': '同期済み',
  'header.sync.synced': '同期 {time}',
  'header.sync.preparing': '同期の準備中',
  'header.sync.sending': '送信中',
  'header.sync.receiving': '受信中',
  'header.sync.paused': '同期を一時停止中',
  'header.sync.once': '1 回だけ同期中…',
  'header.sync.error': '同期エラー',
  'header.sync.failed': '同期に失敗しました',
  'header.sync.errorDetail': '同期エラー: {message}',
  'header.sync.pausedError': '同期を一時停止中 · 同期エラー: {message}',
  'header.sync.pausedErrorShort': '同期を一時停止中 · 同期エラー',
  'header.sync.limited': '無料枠で停止 · {time} にリセット',
  'header.sync.pending': '未送信の変更 {n}',
  'header.sync.sweepPending': '未送信のトランスクリプト {n}',
  'header.sync.skipped': '送信に失敗したトランスクリプト {n}',
  'header.sync.title': '{text}（押すと同期の設定を開く）',
  'header.sync.separator': '、',
};
