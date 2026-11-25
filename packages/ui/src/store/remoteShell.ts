import type { RemoteTabDto, ServerEvent } from '@agent-hangar/shared';
import type { Store } from './store.ts';

/** その会話の SSH のシェルタブを、開いた順に返す。 */
export function remoteTabsOf(store: Store, sessionId: string): RemoteTabDto[] {
  return Object.values(store.remoteTabs).filter((t) => t.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/**
 * この出来事のあとで、閉じるべき SSH のシェルタブの id（計画 6 節 Q5）。
 * 閉じる場面は 2 つ。この PC でその会話の run が始まった（再開した）とき、
 * 別の PC で動いていた会話の lock が外れた（終わった）とき。
 * lock が最初から無い会話（終わった会話を見て開いたタブ）は閉じない。lock が外れる前後を比べるので、出来事を当てる前後の Store を受ける。
 */
export function staleRemoteTabs(before: Store, after: Store, ev: ServerEvent): string[] {
  let sessionId: string | null = null;
  if (ev.type === 'run.started') {
    if (after.device !== null && ev.run.deviceId === after.device.id) sessionId = ev.run.sessionId;
  } else if (ev.type === 'session.upsert') {
    if (before.sessions[ev.session.id]?.lock && !after.sessions[ev.session.id]?.lock) sessionId = ev.session.id;
  }
  return sessionId === null ? [] : remoteTabsOf(after, sessionId).map((t) => t.id);
}
