import type { OpenTarget } from './push.ts';
import type { InboxView, Row } from './inbox.ts';
import type { ChatTarget } from './views/ChatScreen.tsx';

/** 行の会話の頁を開けるか。caps.chat のある PC の Claude Code の会話だけ（opencode と Codex は今までどおり PC で答える）。 */
export function chatTargetOf(view: InboxView, row: Row): ChatTarget | null {
  if (row.agent !== null) return null;
  const chat = view.feeds.find((f) => f.deviceId === row.deviceId)?.caps?.chat;
  if (!chat) return null;
  return { sessionId: row.sessionId, deviceId: row.deviceId, deviceName: row.deviceName, projectName: row.projectName, title: row.title, input: chat.input };
}

/**
 * 通知から開く会話の頁の宛先。
 * 受信箱の素にある会話ならその行から。無ければ（もう待っていない、終わった）、通知の PC の ID で、無ければ名前で PC を探し、素に無い会話として読む。
 * PC が見つからないか、会話の頁に答えない PC なら null（受信箱に印だけ付ける）。
 */
export function chatTargetOfNotice(view: InboxView, open: OpenTarget): ChatTarget | null {
  const rows = [...view.waiting, ...view.running, ...view.returning, ...view.doneToday];
  const row = rows.find((r) => r.sessionId === open.id);
  if (row) return chatTargetOf(view, row);
  const feed = view.feeds.find((f) => (open.deviceId ? f.deviceId === open.deviceId : !!open.pcName && f.deviceName === open.pcName));
  const chat = feed?.caps?.chat;
  if (!feed || !chat) return null;
  return { sessionId: open.id, deviceId: feed.deviceId, deviceName: feed.deviceName, projectName: '', title: '', input: chat.input, focusAsk: true, speculative: true };
}
