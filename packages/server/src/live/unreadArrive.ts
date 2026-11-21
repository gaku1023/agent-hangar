import { notifyRulesOf, type NotifyPreference } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { noteUnreadReady, onUnreadArrived, readUnread } from './unread.ts';

/**
 * ほかの PC から届いた未読の OS の通知（2026-11-21、未読の同期）。
 *
 * 会話を動かしている PC は、notify_user とターンの終わりで自分の決まりどおりに OS とスマホへ出す。
 * 受け取った PC も、自分の知らせ方の決まりの os の列どおりに OS の通知を出す（2 台で同時に鳴ってよい）。
 * スマホへは出さない。スマホの通知は動かしている PC だけが出し、2 通にしない。
 * 設定 sidebarOtherPcs が切なら、ほかの PC の会話の未読は数えず鳴らさないので、ここでも出さない。
 * 流す先は onUnreadReady で、OS の通知の並び（sessions/stopNotices.ts の subscribeUnread）が拾う。返答は書き終わった後に届くので、預かり（unreadHold）は通さない。
 */
export type ArriveDeps = {
  db: Db;
  deviceId: string;
  settings: () => { notifyPreference?: NotifyPreference | null; unreadBadge?: boolean; unreadOs?: boolean; unreadPhone?: boolean; sidebarOtherPcs?: boolean };
  /** 会話の見え方。統括の会話（role）と、状態で黙らせた会話（quiet）には出さない。会話が無ければ null。 */
  session: (sessionId: string) => { role: string | null; quiet: boolean } | null;
};

/** 届いた 1 件を、決まりに照らして OS の通知へ流す。 */
export function noticeArrivedUnread(deps: ArriveDeps, sessionId: string): void {
  const s = deps.settings();
  if (s.sidebarOtherPcs === false) return;
  const u = readUnread(deps.db, sessionId);
  if (!u || u.kind === null || u.latest === null || u.device === deps.deviceId) return;
  const view = deps.session(sessionId);
  if (!view || view.role === 'orchestrator' || view.quiet) return;
  if (!notifyRulesOf(s).os.includes(u.kind)) return;
  noteUnreadReady(sessionId, u.latest, u.count, ['os'], { kind: u.kind });
}

/** 届いた未読の購読を始める。戻り値を呼ぶと外す。 */
export function watchArrivedUnread(deps: ArriveDeps): () => void {
  return onUnreadArrived((db, sessionId) => { if (db === deps.db) noticeArrivedUnread(deps, sessionId); });
}
