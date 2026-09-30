import type { SearchFilter } from '@agent-hangar/shared';
import { periodStart, usesServerSearch } from '../mediator/screen.ts';
import type { State } from '../mediator/types.ts';
import { liveFilterOfSession, runningSessionIds, type Store } from '../store/store.ts';
import { markTerms } from './highlight.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

/**
 * total は条件に合う全件の数、shown はそのうち読み込んだ件数である。
 * サーバは上位の結果だけを返すので、検索では shown が total より小さいことがある。
 * loading は新しい問い合わせの最中、loadingMore は続きを読み足している最中を表す。
 */
export type SessionsProps = { text: string; filter: SearchFilter; projects: { id: string; name: string }[]; rows: SessionRowProps[]; shown: number; total: number; loading: boolean; loadingMore: boolean; mode: 'all' | 'search' };

export function presentSessions(state: State, store: Store, now: number): SessionsProps {
  const projects = Object.values(store.projects).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  const f = state.search.filter;
  if (!usesServerSearch(state.search)) {
    let list = Object.values(store.sessions);
    if (f.projectId) list = list.filter((s) => s.projectId === f.projectId);
    if (f.live !== undefined) { const alive = runningSessionIds(store); list = list.filter((s) => liveFilterOfSession(store, s, alive) === f.live); }
    const { days, until } = f;
    if (days) { const since = periodStart(days, now); list = list.filter((s) => (s.lastActivityAt ?? 0) >= since); }
    if (until !== undefined) list = list.filter((s) => (s.lastActivityAt ?? 0) < until);
    const rows = sortSessions(list).map((s) => presentSessionRow(s, store, now));
    return { text: '', filter: f, projects, rows, shown: rows.length, total: rows.length, loading: false, loadingMore: false, mode: 'all' };
  }
  const result = store.search.result;
  const rows: SessionRowProps[] = [];
  // 行は 2 段なので、抜粋は最初の 1 つだけを 2 段目に出す。
  // キーワードが無い（触ったファイルだけで絞った）ときは抜粋が無いので、2 段目は要約の 1 文になる。
  for (const h of result?.hits ?? []) {
    const s = store.sessions[h.sessionId];
    if (!s) continue;
    const first = h.snippets[0];
    rows.push(presentSessionRow(s, store, now, state.search.text ? (first ? markTerms(first.text, state.search.text) : []) : undefined));
  }
  // 件数は手元に無い行も含めて数える。続きの offset はサーバの並びでの位置だからである。
  const more = (store.search.params?.offset ?? 0) > 0;
  return { text: state.search.text, filter: f, projects, rows, shown: result?.hits.length ?? 0, total: result?.total ?? 0, loading: store.search.loading && !more, loadingMore: store.search.loading && more, mode: 'search' };
}
