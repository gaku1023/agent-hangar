import type { ArtifactDto, ProjectStatus } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import { artifactsOf, todosOf, type Store } from '../store/store.ts';
import { relativeTime } from './format.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

export type TodoItemProps = { id: string; text: string; done: boolean };
export type ArtifactCardProps = { id: string; title: string; description: string | null; favicon: string; url: string; lastPublished: string; versionCount: number; canOpenEditor: boolean };
export type ProjectProps = { id: string; name: string; path: string | null; resolved: boolean; status: ProjectStatus; sessions: SessionRowProps[]; notFound: boolean; isScratch: boolean; todos: TodoItemProps[]; memo: { markdown: string; updatedAt: number } | null; artifacts: ArtifactCardProps[] };

/** アーティファクト 1 件分のカード。題名が無い手動追加は URL の末尾を出す。 */
export function presentArtifactCard(a: ArtifactDto, now: number): ArtifactCardProps {
  return {
    id: a.id, title: a.title ?? a.url.split('/').filter(Boolean).at(-1) ?? a.url, description: a.description, favicon: a.favicon ?? '📄',
    url: a.url, lastPublished: relativeTime(a.lastPublishedAt, now), versionCount: a.versionCount, canOpenEditor: a.filePath !== null && a.fileExists,
  };
}

export function presentProject(_state: State, store: Store, now: number, id: string): ProjectProps {
  const p = store.projects[id];
  if (!p) return { id, name: id, path: null, resolved: false, status: 'active', sessions: [], notFound: true, isScratch: false, todos: [], memo: null, artifacts: [] };
  const sessions = sortSessions(Object.values(store.sessions).filter((s) => s.projectId === id)).map((s) => presentSessionRow(s, store, now));
  const memo = store.memos[id];
  return {
    id, name: p.name, path: p.path, resolved: p.resolved, status: p.status, sessions, notFound: false, isScratch: p.isScratch,
    todos: todosOf(store, id).map((t) => ({ id: t.id, text: t.text, done: t.done })),
    memo: memo ? { markdown: memo.markdown, updatedAt: memo.updatedAt } : null,
    artifacts: artifactsOf(store, { projectId: id }).map((a) => presentArtifactCard(a, now)),
  };
}
