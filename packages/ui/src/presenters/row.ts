import type { LiveStatus, SessionDto } from '@agent-hangar/shared';
import { aliveRunOf, type Store } from '../store/store.ts';
import { absoluteTime, costLabel, relativeTime, shortModel, STATE_LABEL } from './format.ts';
import type { Segment } from './highlight.ts';

export type SessionRowProps = { id: string; name: string; oneLiner: string; projectName: string | null; live: LiveStatus | null; stateLabel: string; model: string; effort: string; when: string; whenAbs: string; filesChanged: number; prUrl: string | null; memo: string | null; hasTranscript: boolean; cost: string; runId: string | null; excerpt?: Segment[] };

export function presentSessionRow(s: SessionDto, store: Store, now: number, excerpt?: Segment[]): SessionRowProps {
  const row: SessionRowProps = {
    id: s.id, name: s.name ?? '（名前なし）', oneLiner: s.summary?.oneLiner ?? s.firstPrompt ?? '',
    projectName: s.projectId ? store.projects[s.projectId]?.name ?? null : null,
    live: s.live, stateLabel: s.summary ? STATE_LABEL[s.summary.state] : '', model: shortModel(s.stats.model), effort: s.stats.effort ?? '',
    when: relativeTime(s.lastActivityAt, now), whenAbs: absoluteTime(s.lastActivityAt), filesChanged: s.stats.filesChanged, prUrl: s.stats.prUrl, memo: s.memo, hasTranscript: s.hasTranscript,
    cost: costLabel(s.stats.costUsd), runId: aliveRunOf(store, s.id)?.id ?? null,
  };
  if (excerpt) row.excerpt = excerpt;
  return row;
}

/** 生きているセッションの並び。答えを待っているものほど上に置く。 */
const LIVE_ORDER: Record<string, number> = { waiting: 0, busy: 1, idle: 2 };
/** 終わったセッションの順位。どの生きている状態よりも後ろに来る。 */
const ENDED_ORDER = 9;
/** 生きているものを先頭に waiting、busy、idle の順で並べ、同じ順位の中は新しい順にする。 */
export function sortSessions(list: SessionDto[]): SessionDto[] {
  return [...list].sort((a, b) => {
    const la = a.live ? LIVE_ORDER[a.live] ?? 3 : ENDED_ORDER;
    const lb = b.live ? LIVE_ORDER[b.live] ?? 3 : ENDED_ORDER;
    if (la !== lb) return la - lb;
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  });
}
