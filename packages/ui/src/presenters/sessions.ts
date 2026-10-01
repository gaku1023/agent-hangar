import type { LiveFilter, SearchFilter } from '@agent-hangar/shared';
import { periodStart, usesServerSearch } from '../mediator/screen.ts';
import type { State } from '../mediator/types.ts';
import { liveFilterOfSession, runningSessionIds, type Store } from '../store/store.ts';
import { absoluteTime } from './format.ts';
import { markTerms } from './highlight.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

/**
 * total は条件に合う全件の数、shown はそのうち読み込んだ件数である。
 * サーバは上位の結果だけを返すので、検索では shown が total より小さいことがある。
 * loading は新しい問い合わせの最中、loadingMore は続きを読み足している最中を表す。
 */
export type SessionsProps = { text: string; filter: SearchFilter; projects: { id: string; name: string }[]; rows: SessionRowProps[]; shown: number; total: number; loading: boolean; loadingMore: boolean; mode: 'all' | 'search'; allCount: number; conditions: string[] };

/** 期間の語。絞り込みの帯と同じ語を使う。 */
const PERIOD_LABEL: Record<number, string> = { 1: '今日', 7: '7 日', 30: '30 日' };
/** 状態の語。絞り込みの帯と同じ語を使う。 */
const LIVE_LABEL: Record<LiveFilter, string> = { waiting: '入力待ち', running: '実行中', ended: '終了' };

/**
 * いま効いている条件を、条件の行に並べる語にする（D1）。
 * 語、プロジェクト、期間、状態、触ったファイルの順で、絞り込みの段の並びと同じにする。
 */
function conditionsOf(text: string, f: SearchFilter, store: Store): string[] {
  const out: string[] = [];
  if (text) out.push(`『${text}』`);
  if (f.projectId) out.push(store.projects[f.projectId]?.name ?? '見つからないプロジェクト');
  if (f.days) out.push(PERIOD_LABEL[f.days] ?? `${f.days} 日`);
  if (f.until !== undefined) out.push(`${absoluteTime(f.until).slice(0, 10)} より前`);
  if (f.live) out.push(LIVE_LABEL[f.live]);
  if (f.file) out.push(f.file);
  return out;
}

export function presentSessions(state: State, store: Store, now: number): SessionsProps {
  const projects = Object.values(store.projects).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  const f = state.search.filter;
  // 見出しの件数は条件に関わらず全件で、絞った結果の件数は条件の行が言う。
  const allCount = Object.keys(store.sessions).length;
  const conditions = conditionsOf(state.search.text, f, store);
  if (!usesServerSearch(state.search)) {
    let list = Object.values(store.sessions);
    if (f.projectId) list = list.filter((s) => s.projectId === f.projectId);
    if (f.live !== undefined) { const alive = runningSessionIds(store); list = list.filter((s) => liveFilterOfSession(store, s, alive) === f.live); }
    const { days, until } = f;
    if (days) { const since = periodStart(days, now); list = list.filter((s) => (s.lastActivityAt ?? 0) >= since); }
    if (until !== undefined) list = list.filter((s) => (s.lastActivityAt ?? 0) < until);
    const rows = sortSessions(list).map((s) => presentSessionRow(s, store, now));
    return { text: '', filter: f, projects, rows, shown: rows.length, total: rows.length, loading: false, loadingMore: false, mode: 'all', allCount, conditions };
  }
  const result = store.search.result;
  const rows: SessionRowProps[] = [];
  // 行は 2 段なので、抜粋は最初の 1 つだけを 2 段目に出す。
  // キーワードが無い（触ったファイルだけで絞った）ときは抜粋が無いので、2 段目は要約の 1 文になる。
  for (const h of result?.hits ?? []) {
    const s = store.sessions[h.sessionId];
    if (!s) continue;
    const first = h.snippets[0];
    const row = presentSessionRow(s, store, now, state.search.text ? (first ? markTerms(first.text, state.search.text) : []) : undefined);
    // 開いたら、抜粋の一致へ跳ぶ（J1）。
    if (state.search.text && first) row.jump = { seq: first.seq, q: state.search.text };
    rows.push(row);
  }
  // 件数は手元に無い行も含めて数える。続きの offset はサーバの並びでの位置だからである。
  const more = (store.search.params?.offset ?? 0) > 0;
  return { text: state.search.text, filter: f, projects, rows, shown: result?.hits.length ?? 0, total: result?.total ?? 0, loading: store.search.loading && !more, loadingMore: store.search.loading && more, mode: 'search', allCount, conditions };
}
