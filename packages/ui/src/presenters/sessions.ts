import type { SearchFilter } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { markTerms } from './highlight.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

export type SessionsProps = { text: string; filter: SearchFilter; projects: { id: string; name: string }[]; rows: SessionRowProps[]; total: number; loading: boolean; mode: 'all' | 'search' };

export function presentSessions(state: State, store: Store, now: number): SessionsProps {
  const projects = Object.values(store.projects).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  const f = state.search.filter;
  if (!state.search.text) {
    let list = Object.values(store.sessions);
    if (f.projectId) list = list.filter((s) => s.projectId === f.projectId);
    if (f.running !== undefined) list = list.filter((s) => (s.live !== null) === f.running);
    const { since, until } = f;
    if (since !== undefined) list = list.filter((s) => (s.lastActivityAt ?? 0) >= since);
    if (until !== undefined) list = list.filter((s) => (s.lastActivityAt ?? 0) < until);
    const rows = sortSessions(list).map((s) => presentSessionRow(s, store, now));
    return { text: '', filter: f, projects, rows, total: rows.length, loading: false, mode: 'all' };
  }
  const result = store.search.result;
  const rows: SessionRowProps[] = [];
  // 行は 2 段なので、抜粋は最初の 1 つだけを 2 段目に出す。
  for (const h of result?.hits ?? []) {
    const s = store.sessions[h.sessionId];
    if (!s) continue;
    const first = h.snippets[0];
    rows.push(presentSessionRow(s, store, now, first ? markTerms(first.text, state.search.text) : []));
  }
  return { text: state.search.text, filter: f, projects, rows, total: result?.total ?? 0, loading: store.search.loading, mode: 'search' };
}
