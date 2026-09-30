import type { LiveStatus, SessionDto, SessionSummaryDto } from '@agent-hangar/shared';
import { aliveRunOf, type Store } from '../store/store.ts';
import { absoluteTime, costLabel, relativeTime, shortModel, STATE_LABEL } from './format.ts';
import type { Segment } from './highlight.ts';
import { DEFAULT_DAYS, transcriptMark, type TranscriptMark } from './retention.ts';

/**
 * 要約の見立ての札（試作 home-lists の B1）。
 * tone は色の調子で、詰まっている（blocked）とやめた（abandoned）だけに付け、ほかは null にして語だけを出す。
 */
export type SummaryStateTag = { label: string; tone: 'blocked' | 'abandoned' | null };

/** summaryState は 2 段目の頭に置く見立ての札。要約が無いときと、土台の要約のときは null。 */
export type SessionRowProps = { id: string; name: string; oneLiner: string; projectName: string | null; live: LiveStatus | null; stateLabel: string; summaryState: SummaryStateTag | null; model: string; effort: string; when: string; whenAbs: string; filesChanged: number; prUrl: string | null; memo: string | null; hasTranscript: boolean; transcript: TranscriptMark; cost: string; runId: string | null; excerpt?: Segment[] };

/**
 * 見立ての札を作る。
 * 土台の要約の state は Claude の見立てではなく、プロセスが生きているかどうかの写しなので札にしない。
 * 終わったセッションのほとんどに「済んだ」が並ぶと、本当に済んだものと見分けが付かなくなるためである。
 */
function summaryStateTag(summary: SessionSummaryDto | null): SummaryStateTag | null {
  if (!summary || summary.source === 'baseline') return null;
  const tone = summary.state === 'blocked' || summary.state === 'abandoned' ? summary.state : null;
  return { label: STATE_LABEL[summary.state], tone };
}

export function presentSessionRow(s: SessionDto, store: Store, now: number, excerpt?: Segment[]): SessionRowProps {
  const row: SessionRowProps = {
    id: s.id, name: s.name ?? '（名前なし）', oneLiner: s.summary?.oneLiner ?? s.firstPrompt ?? '',
    projectName: s.projectId ? store.projects[s.projectId]?.name ?? null : null,
    live: s.live, stateLabel: s.summary ? STATE_LABEL[s.summary.state] : '', summaryState: summaryStateTag(s.summary), model: shortModel(s.stats.model), effort: s.stats.effort ?? '',
    when: relativeTime(s.lastActivityAt, now), whenAbs: absoluteTime(s.lastActivityAt), filesChanged: s.stats.filesChanged, prUrl: s.stats.prUrl, memo: s.memo, hasTranscript: s.hasTranscript,
    transcript: transcriptMark(s, store.retention?.days ?? DEFAULT_DAYS, now),
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
