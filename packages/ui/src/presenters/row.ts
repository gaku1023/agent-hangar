import type { LiveStatus, SessionDto } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import { absoluteTime, relativeTime, shortModel, STATE_LABEL } from './format.ts';

export type SessionRowProps = { id: string; name: string; oneLiner: string; projectName: string | null; live: LiveStatus | null; stateLabel: string; model: string; effort: string; when: string; whenAbs: string; filesChanged: number; prUrl: string | null; memo: string | null; hasTranscript: boolean; snippets?: { seq: number; text: string }[] };

export function presentSessionRow(s: SessionDto, store: Store, now: number, snippets?: { seq: number; text: string }[]): SessionRowProps {
  const row: SessionRowProps = {
    id: s.id, name: s.name ?? '（名前なし）', oneLiner: s.summary?.oneLiner ?? s.firstPrompt ?? '',
    projectName: s.projectId ? store.projects[s.projectId]?.name ?? null : null,
    live: s.live, stateLabel: s.summary ? STATE_LABEL[s.summary.state] : '', model: shortModel(s.stats.model), effort: s.stats.effort ?? '',
    when: relativeTime(s.lastActivityAt, now), whenAbs: absoluteTime(s.lastActivityAt), filesChanged: s.stats.filesChanged, prUrl: s.stats.prUrl, memo: s.memo, hasTranscript: s.hasTranscript,
  };
  if (snippets) row.snippets = snippets;
  return row;
}

const LIVE_ORDER: Record<string, number> = { waiting: 0, busy: 1, idle: 2 };
/** 実行中を先頭に、その後を新しい順に。 */
export function sortSessions(list: SessionDto[]): SessionDto[] {
  return [...list].sort((a, b) => {
    const la = a.live ? LIVE_ORDER[a.live] ?? 3 : 9;
    const lb = b.live ? LIVE_ORDER[b.live] ?? 3 : 9;
    if ((la < 9) !== (lb < 9)) return la < 9 ? -1 : 1;
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  });
}
