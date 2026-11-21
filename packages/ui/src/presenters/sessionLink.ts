import { remoteLiveOf, shownLive, shownReason, type LiveStatus, type SessionDto, type StopReason, type Translate } from '@agent-hangar/shared';
import { remoteReasonOf, shownAside, type Store } from '../store/store.ts';
import { projectDisplayName } from './projectName.ts';

/** 会話の状態の点に要るもの（動き、裏の作業、止まっている理由）。この PC の会話はこの PC の live を、別の PC の会話はそのロックを読む。 */
export type SessionDot = { live: LiveStatus | null; aside: boolean; reason: StopReason | null };

export function sessionDotOf(s: SessionDto): SessionDot {
  const own = shownLive(s);
  if (own !== null || !s.lock || s.parked) return { live: own, aside: shownAside(s) !== null, reason: shownReason(s, own) };
  const live = remoteLiveOf(s.lock);
  return { live, aside: false, reason: remoteReasonOf(s.lock, live) };
}

/**
 * 本文の会話のリンクの札（右下の知らせの 1 行目と同じ、状態の丸と題）。
 * project と device は、見ている会話と違うときだけ入る（同じなら null）。見ているのが会話でないとき（viewingId が null）は、プロジェクトは常に、PC は別の PC のときだけ入る。
 * この PC で分からない会話は null で、本文は元のリンクのままにする。
 */
export type SessionChipProps = SessionDot & { id: string; name: string; project: string | null; device: string | null };

/** 会話のいる PC。別の PC のロックだけがあれば、その PC。そうでなければこの PC（store.device）。 */
function deviceOf(store: Store, s: SessionDto): { id: string; name: string } | null {
  const me = store.device;
  if (s.lock && s.live === null && me && s.lock.deviceId !== me.id) return { id: s.lock.deviceId, name: s.lock.deviceName };
  return me;
}

export function presentSessionChip(store: Store, t: Translate, id: string, viewingId: string | null): SessionChipProps | null {
  const s = store.sessions[id];
  if (!s) return null;
  const viewing = viewingId ? store.sessions[viewingId] ?? null : null;
  const p = s.projectId ? store.projects[s.projectId] : undefined;
  const project = p && (viewing === null || viewing.projectId !== s.projectId) ? projectDisplayName(p, t) : null;
  const mine = deviceOf(store, s);
  const there = viewing ? deviceOf(store, viewing) : store.device;
  const device = mine && mine.id !== there?.id ? mine.name : null;
  return { id: s.id, name: s.name ?? t('common.label.noName'), ...sessionDotOf(s), project, device };
}
