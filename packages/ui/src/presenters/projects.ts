import type { ProjectDto, ProjectStatus } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import { liveFilterOfSession, runningSessionIds, type Store } from '../store/store.ts';
import { relativeTime, STATUS_LABEL } from './format.ts';

export type ProjectCardProps = { id: string; name: string; path: string | null; resolved: boolean; status: ProjectStatus; lastActivity: string; runningCount: number; waitingCount: number; openTodoCount: number; memoHead: string | null; lastOneLiner: string | null };
export type ProjectsProps = { sections: { status: ProjectStatus; label: string; cards: ProjectCardProps[] }[]; archivedCount: number };

/**
 * プロジェクトの実行中と入力待ちの数。
 * ホームと同じ数え方にするため、サーバの runningCount（入力待ちを含み、起動中を含まない）は使わず、手元のセッションから数える。
 */
export function liveCountsOf(store: Store, projectId: string, alive: Set<string> = runningSessionIds(store)): { running: number; waiting: number } {
  let running = 0;
  let waiting = 0;
  for (const s of Object.values(store.sessions)) {
    if (s.projectId !== projectId) continue;
    const f = liveFilterOfSession(store, s, alive);
    if (f === 'running') running++;
    else if (f === 'waiting') waiting++;
  }
  return { running, waiting };
}

export function presentProjectCard(p: ProjectDto, store: Store, now: number, alive: Set<string> = runningSessionIds(store)): ProjectCardProps {
  const last = Object.values(store.sessions).filter((s) => s.projectId === p.id).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
  const counts = liveCountsOf(store, p.id, alive);
  return { id: p.id, name: p.name, path: p.path, resolved: p.resolved, status: p.status, lastActivity: relativeTime(p.lastActivityAt, now), runningCount: counts.running, waitingCount: counts.waiting, openTodoCount: p.openTodoCount, memoHead: p.memoHead, lastOneLiner: last?.summary?.oneLiner ?? last?.firstPrompt ?? null };
}

export function presentProjects(_state: State, store: Store, now: number, filter: string, showArchived: boolean): ProjectsProps {
  const needle = filter.trim().toLowerCase();
  // スクラッチの擬似プロジェクトはカードに出さない。Sessions 画面の絞り込みには残る。
  const all = Object.values(store.projects).filter((p) => !p.isScratch).filter((p) => !needle || p.name.toLowerCase().includes(needle)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const alive = runningSessionIds(store);
  const statuses: ProjectStatus[] = showArchived ? ['active', 'paused', 'done', 'archived'] : ['active', 'paused', 'done'];
  return { sections: statuses.map((status) => ({ status, label: STATUS_LABEL[status], cards: all.filter((p) => p.status === status).map((p) => presentProjectCard(p, store, now, alive)) })), archivedCount: all.filter((p) => p.status === 'archived').length };
}
