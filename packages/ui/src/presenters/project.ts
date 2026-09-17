import type { ProjectStatus } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

export type ProjectProps = { id: string; name: string; path: string | null; resolved: boolean; status: ProjectStatus; sessions: SessionRowProps[]; notFound: boolean };

export function presentProject(_state: State, store: Store, now: number, id: string): ProjectProps {
  const p = store.projects[id];
  if (!p) return { id, name: id, path: null, resolved: false, status: 'active', sessions: [], notFound: true };
  const sessions = sortSessions(Object.values(store.sessions).filter((s) => s.projectId === id)).map((s) => presentSessionRow(s, store, now));
  return { id, name: p.name, path: p.path, resolved: p.resolved, status: p.status, sessions, notFound: false };
}
