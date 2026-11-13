import { notifyRulesOf, type NotifyKind } from '@agent-hangar/shared';

/**
 * セッションに紐づかない知らせ（設定の同期の確認、競合、自動の適用の失敗など）。
 * notify_user はセッションの ID が前提で、未読の数も OS の通知もスマホの通知もセッションごとに積む。
 * ここは会話を持たない知らせの口で、出し先は os と phone だけにする（unread は使わない。画面のヘッダの札が代わる）。
 * 振り分けは notify_user と同じ決まり（notifyRulesOf）で、kind を含む先にだけ出す。
 */
export type AppNotice = { text: string; kind: NotifyKind; sent: ('os' | 'phone')[] };

type Listener = (n: AppNotice) => void;
const listeners = new Set<Listener>();

/** 知らせの購読を足す。戻り値を呼ぶと外す。OS の通知（sessions/stopNotices.ts）とスマホの通知（boot/mobile.ts）が聞く。 */
export function onAppNotice(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * 知らせる。settings を省けば既定の決まり。出し先が無ければ何も配らない。
 * 購読が投げても、書いた側にも他の購読にも波及させない。
 */
export function notifyApp(n: { text: string; kind: NotifyKind }, settings: Parameters<typeof notifyRulesOf>[0] = {}): void {
  const rules = notifyRulesOf(settings);
  const sent = (['os', 'phone'] as const).filter((x) => rules[x].includes(n.kind));
  if (sent.length === 0) return;
  for (const cb of [...listeners]) {
    try { cb({ text: n.text, kind: n.kind, sent: [...sent] }); } catch (e) { console.error('[appNotice] a listener failed', e instanceof Error ? e.constructor.name : typeof e); }
  }
}
