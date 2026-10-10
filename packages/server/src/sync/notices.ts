import path from 'node:path';
import type { NoticeEvent } from '../events/publisher.ts';
import { writeMemoConflictCopy, type SessionMemoBackup } from './apply.ts';
import type { SyncEngineDeps } from './engine.ts';

/** 画面の隅に出す知らせ。 */
export type Toast = (level: 'info' | 'error', message: string) => void;

/** 配る層へトーストを渡す口を作る。 */
export function toastVia(hub: { broadcast(ev: NoticeEvent): void }): Toast {
  return (level, message) => hub.broadcast({ type: 'toast', level, message });
}

/**
 * セッションのメモを他端末の新しい版で置き換えたときの知らせ。
 * 控えはもうファイルになっているので、利用者に伝えるのは「どこに残したか」である。
 */
export function sessionMemoBackupMessage(o: SessionMemoBackup): string {
  return `セッションのメモを ${o.deviceName} の新しい内容で置き換えました。手元の内容は ${o.backupFile} に残してあります`;
}

/**
 * 同期の適用がメモで負けたときの後始末。SyncEngine に渡す 2 つの口を作る。
 * プロジェクトのメモは、負けた手元の内容を隣に残してから知らせる。
 * 名前の組み立ても既存の写しの守りも writeMemoConflictCopy が持っている。
 * ここで投げれば、その行は適用されない（控えの無いまま利用者の文章を消さない）。
 * セッションのメモは、控えがもうファイルになっているので、置き場を知らせて世代を刈るだけである。
 */
export function memoLossHandlers(o: { memoPath: (projectId: string) => string; toast: Toast; pruneMemos: () => void }): Required<Pick<SyncEngineDeps, 'onMemoConflict' | 'onSessionMemoBackup'>> {
  return {
    onMemoConflict: (c) => {
      const file = writeMemoConflictCopy(o.memoPath(c.projectId), c);
      o.toast('info', `メモが競合しました。手元の内容を ${path.basename(file)} に残しました`);
    },
    onSessionMemoBackup: (b) => { o.toast('info', sessionMemoBackupMessage(b)); o.pruneMemos(); },
  };
}
