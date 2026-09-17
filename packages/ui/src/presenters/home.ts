import type { LiveStatus } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { durationLabel } from './format.ts';
import { presentProjectCard, type ProjectCardProps } from './projects.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

export type HomeProps = { running: { id: string; name: string; projectName: string | null; live: LiveStatus; elapsed: string }[]; activeProjects: ProjectCardProps[]; recent: SessionRowProps[] };

export function presentHome(_state: State, store: Store, now: number): HomeProps {
  const sessions = Object.values(store.sessions);
  const running = sortSessions(sessions.filter((s) => s.live !== null)).map((s) => ({ id: s.id, name: s.name ?? '（名前なし）', projectName: s.projectId ? store.projects[s.projectId]?.name ?? null : null, live: s.live as LiveStatus, elapsed: durationLabel(now - (s.startedAt ?? now)) }));
  const activeProjects = Object.values(store.projects).filter((p) => p.status === 'active').sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).map((p) => presentProjectCard(p, store, now));
  const recent = sortSessions(sessions).slice(0, 30).map((s) => presentSessionRow(s, store, now));
  return { running, activeProjects, recent };
}
