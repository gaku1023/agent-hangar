import type { ProjectDto, ProjectStatus } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { relativeTime, STATUS_LABEL } from './format.ts';

export type ProjectCardProps = { id: string; name: string; path: string | null; resolved: boolean; status: ProjectStatus; lastActivity: string; runningCount: number; openTodoCount: number; memoHead: string | null; lastOneLiner: string | null };
export type ProjectsProps = { sections: { status: ProjectStatus; label: string; cards: ProjectCardProps[] }[]; archivedCount: number };

export function presentProjectCard(p: ProjectDto, store: Store, now: number): ProjectCardProps {
  const last = Object.values(store.sessions).filter((s) => s.projectId === p.id).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
  return { id: p.id, name: p.name, path: p.path, resolved: p.resolved, status: p.status, lastActivity: relativeTime(p.lastActivityAt, now), runningCount: p.runningCount, openTodoCount: p.openTodoCount, memoHead: p.memoHead, lastOneLiner: last?.summary?.oneLiner ?? last?.firstPrompt ?? null };
}

export function presentProjects(_state: State, store: Store, now: number, filter: string, showArchived: boolean): ProjectsProps {
  const needle = filter.trim().toLowerCase();
  const all = Object.values(store.projects).filter((p) => !needle || p.name.toLowerCase().includes(needle)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const statuses: ProjectStatus[] = showArchived ? ['active', 'paused', 'done', 'archived'] : ['active', 'paused', 'done'];
  return { sections: statuses.map((status) => ({ status, label: STATUS_LABEL[status], cards: all.filter((p) => p.status === status).map((p) => presentProjectCard(p, store, now)) })), archivedCount: all.filter((p) => p.status === 'archived').length };
}
