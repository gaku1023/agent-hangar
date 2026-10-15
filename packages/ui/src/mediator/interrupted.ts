import { translatorOf } from '../presenters/i18n.ts';
import type { Store } from '../store/store.ts';
import { overlayReplaceable } from './overlay.ts';
import type { ResumeStray } from '@agent-hangar/shared';
import type { Effect, Input, ResumeQueue, State, Step } from './types.ts';

/** まとめて再開で、同時に頼む本数。多く起こすと、使用量とマシンの負荷が一度に跳ねる。 */
export const RESUME_CONCURRENCY = 2;

/** 順番待ちから、空いた分だけ起こす。 */
function pump(q: ResumeQueue): { queue: ResumeQueue; effects: Effect[] } {
  const free = Math.max(0, RESUME_CONCURRENCY - q.active.length);
  const start = q.queued.slice(0, free);
  if (start.length === 0) return { queue: q, effects: [] };
  return {
    queue: { ...q, queued: q.queued.slice(start.length), active: [...q.active, ...start] },
    effects: start.map((sessionId): Effect => {
      const stray = q.stray?.[sessionId];
      return { kind: 'api.resumeQueued', sessionId, ...(stray ? { stray } : {}) };
    }),
  };
}

const without = <V extends string>(m: Record<string, V>, ids: Iterable<string>): Record<string, V> => {
  const drop = new Set(ids);
  return Object.fromEntries(Object.entries(m).filter(([k]) => !drop.has(k))) as Record<string, V>;
};

/** 選び方（stray）を差し替えた順番待ち。空になったら項目ごと外す。 */
function withStray(q: ResumeQueue, stray: Record<string, ResumeStray>): ResumeQueue {
  const { stray: _old, ...rest } = q;
  return Object.keys(stray).length ? { ...rest, stray } : rest;
}

/**
 * interrupted 領域：中断の群（ホームの帯の「前回実行中」）と、同じファイルの編集から worktree で始める操作。
 *
 * まとめて再開は、渡したセッションを順番待ちに足し、同時に RESUME_CONCURRENCY 本まで再開を頼む。
 * 1 本ずつの「再開」と「再試行」も同じ順番待ちに入る。どれも画面は移さず、起きたものは帯の「実行中」へ移る。
 * 断られたものは理由を行に残し、次へ進む。「残りをキャンセル」は順番待ちだけを外す（頼みかけたものは止めない）。
 * tmux（psmux）が無いと分かっているときは、muxGuide 領域が先に止める。
 *
 * 「再開しない」は、群から行を外す印をサーバに書き、「元に戻す」の付いたトーストを出す。元に戻すときはトーストを出さない。
 */
export function interruptedStep(state: State, store: Store, input: Input): Step | null {
  const q = state.resumeQueue;
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type !== 'resumeQueue.done' && e.type !== 'resumeQueue.failed') return null;
    const active = q.active.filter((id) => id !== e.sessionId);
    const failed = e.type === 'resumeQueue.failed' ? { ...q.failed, [e.sessionId]: e.message } : q.failed;
    const next = pump(withStray({ ...q, active, failed }, without(q.stray ?? {}, [e.sessionId])));
    return { state: { ...state, resumeQueue: next.queue }, effects: next.effects };
  }
  if (input.kind !== 'action') return null;
  const a = input.action;
  switch (a.type) {
    case 'interrupted.resume': {
      // 残った claude の確認から選んだときは、確認を閉じる。
      const overlay = a.stray && state.overlay.kind === 'confirm' && state.overlay.confirm.kind === 'strayProcess' ? { kind: 'none' as const } : state.overlay;
      const busy = new Set([...q.queued, ...q.active]);
      const fresh = [...new Set(a.ids)].filter((id) => !busy.has(id));
      if (fresh.length === 0) return { state: { ...state, overlay }, effects: [] };
      const stray = a.stray ? { ...q.stray, ...Object.fromEntries(fresh.map((id) => [id, a.stray!])) } : without(q.stray ?? {}, fresh);
      const next = pump(withStray({ queued: [...q.queued, ...fresh], active: q.active, failed: without(q.failed, fresh) }, stray));
      return { state: { ...state, overlay, resumeQueue: next.queue }, effects: next.effects };
    }
    case 'interrupted.cancel':
      return { state: { ...state, resumeQueue: withStray({ ...q, queued: [] }, without(q.stray ?? {}, q.queued)) }, effects: [] };
    case 'interrupted.dismiss': {
      const effects: Effect[] = [{ kind: 'api.dismissInterrupted', runIds: a.runIds, dismissed: a.dismissed }];
      if (!a.dismissed) return { state, effects };
      const t = translatorOf(store);
      const message = a.name !== undefined && a.runIds.length === 1 ? t('interrupted.toast.skipped', { name: a.name }) : t('interrupted.toast.closed', { n: a.runIds.length });
      const toast = { id: String(state.nextToastId), level: 'info' as const, message, action: { label: t('interrupted.toast.undo'), send: { type: 'interrupted.dismiss' as const, runIds: a.runIds, dismissed: false } } };
      return { state: { ...state, toasts: [...state.toasts, toast], nextToastId: state.nextToastId + 1 }, effects };
    }
    case 'overlap.worktree': {
      // 確認や入力のあるダイアログが出ていれば、差し替えない（新しいセッションのダイアログを開く操作と同じ）。
      if (!overlayReplaceable(state.overlay)) return { state, effects: [] };
      const projectId = store.sessions[a.sessionId]?.projectId ?? null;
      return { state: { ...state, overlay: { kind: 'newSession', projectId, scratch: false, worktree: true }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
    }
    default: return null;
  }
}
