import type { syncKeys } from '../keys/sync.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const syncJa: AreaDictionary<typeof syncKeys> = {
  'sync.error.notConfigured': 'クラウド同期が設定されていません',
  'sync.note.sessionReplaced': 'セッションのメモを {deviceName} の新しい内容で置き換えました。手元の内容は {backupFile} に残してあります',
  'sync.note.conflict': 'メモが競合しました。手元の内容を {file} に残しました',
  'sync.once.compatBlocked': 'クラウドと互換の版が合わないので、同期できませんでした',
  'sync.once.done': '1 回だけ同期しました。同期は一時停止のままです',
  'sync.once.leftBoth': '1 回だけ同期しましたが、未送信 {pending} 件、未送信の本文 {transcripts} 件が残りました。同期は一時停止のままです',
  'sync.once.leftChanges': '1 回だけ同期しましたが、未送信 {pending} 件が残りました。同期は一時停止のままです',
  'sync.once.leftTranscripts': '1 回だけ同期しましたが、未送信の本文 {transcripts} 件が残りました。同期は一時停止のままです',
  'sync.pull.failed': '本文を降ろせませんでした（{kind}）: {reason}',
  'sync.resume.noTranscript': 'このセッションの本文がありません',
};
