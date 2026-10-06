import { badTokens, queryTokens, type LiveFilter, type QueryToken, type SearchFilter, type StatusFilter } from '@agent-hangar/shared';
import { hasConditions, periodStart, usesServerSearch } from '../mediator/screen.ts';
import type { State } from '../mediator/types.ts';
import { liveFilterOfSession, runningSessionIds, type Store } from '../store/store.ts';
import { absoluteTime } from './format.ts';
import { markTerms } from './highlight.ts';
import { pageSlice, pagerOf, type PagerProps } from './pager.ts';
import { presentSessionRow, sortForSections, type SessionRowProps } from './row.ts';
import { DONE_HEAD, matchesStatus, sectionRows, type ListItem } from './sections.ts';

/** 状態のタブ。all は「すべて」。 */
export type StatusTab = 'all' | StatusFilter;
/** 状態のタブ 1 つ。count は桁を区切った件数、hot は数字を候補の色で灯すか（確かめるが 1 件以上のとき）。 */
export type StatusTabProps = { tab: StatusTab; label: string; count: string; hot: boolean };

/**
 * total は条件に合う全件の数である。
 * loading は問い合わせの最中を表す（ページを移ったときも含む）。
 * rows は条件に合う行の平らな並びのうち、いまのページの分で、sections は条件が無いときの節の並び（★）。sections が null なら rows を描く。
 * pager は平らな一覧のページ送りで、節で読むときと、いちばん小さい件数に収まるときは null。
 * statusColumn は行の状態の列を出すか。状態がどれも同じタブ（Done・Paused・Archived）では畳む（F1）。Active のタブは、並ぶ行に提案が無いときに畳む。
 * tabs は件数つきの状態のタブ、tab は選んでいるタブ、tokens は欄の中のチップ、hints は読めなかったトークンの知らせである。
 */
export type SessionsProps = { text: string; filter: SearchFilter; projects: { id: string; name: string }[]; rows: SessionRowProps[]; total: number; loading: boolean; mode: 'all' | 'search'; allCount: number; conditions: string[]; tabs: StatusTabProps[]; tab: StatusTab; sections: ListItem[] | null; pager: PagerProps | null; statusColumn: boolean; tokens: QueryToken[]; hints: string[] };

/** 状態がどれも同じになるタブ。行の状態の列を畳む。 */
const UNIFORM_TABS: StatusTab[] = ['done', 'paused', 'archived'];
/** 状態の列を出すか。Active の行は札を持たないので、Active のタブでは提案の札があるときだけ出す。 */
const statusColumnOf = (tab: StatusTab, rows: SessionRowProps[]): boolean => (tab === 'active' ? rows.some((r) => r.candidate !== null) : !UNIFORM_TABS.includes(tab));

/** 期間の語。絞り込みの帯と同じ語を使う。 */
const PERIOD_LABEL: Record<number, string> = { 1: '今日', 7: '7 日', 30: '30 日' };
/** 動きの語。is:running と is:waiting で届く。 */
const LIVE_LABEL: Record<LiveFilter, string> = { waiting: '入力待ち', running: '実行中', ended: '終了' };
/** タブの並びと名前（★）。語と並びはプロジェクトの状態と同じにし、提案だけを日本語にする。 */
const TABS: [StatusTab, string][] = [['all', 'すべて'], ['proposed', '確かめる'], ['active', 'Active'], ['paused', 'Paused'], ['done', 'Done'], ['archived', 'Archived']];
const STATUS_LABEL = Object.fromEntries(TABS) as Record<StatusTab, string>;

/**
 * いま効いている条件を、条件の行に並べる語にする（D1）。
 * 語、状態、動き、期間、プロジェクト、触ったファイルの順で、欄のチップの並び（queryTokens）に合わせる。
 */
function conditionsOf(text: string, f: SearchFilter, store: Store): string[] {
  const out: string[] = [];
  if (text) out.push(`『${text}』`);
  if (f.status) out.push(STATUS_LABEL[f.status]);
  if (f.live) out.push(LIVE_LABEL[f.live]);
  if (f.days) out.push(PERIOD_LABEL[f.days] ?? `${f.days} 日`);
  if (f.until !== undefined) out.push(`${absoluteTime(f.until).slice(0, 10)} より前`);
  if (f.projectId) out.push(store.projects[f.projectId]?.name ?? '見つからないプロジェクト');
  if (f.file) out.push(f.file);
  return out;
}

/**
 * 状態のタブ。件数は条件に関わらず手元の全件で、行の持ち物で数える（presenters/sections.ts の matchesStatus）。
 * 節とは数え方が違い、提案のある Active は確かめるにも Active にも入る。
 * 「すべて」は Archived を除いた数で、条件を入れたときに並ぶ行の数え方と同じにする。
 */
function presentTabs(rows: SessionRowProps[]): StatusTabProps[] {
  return TABS.map(([tab, label]) => {
    const n = tab === 'all' ? rows.filter((r) => r.state !== 'archived').length : rows.filter((r) => matchesStatus(r, tab)).length;
    return { tab, label, count: n.toLocaleString('en-US'), hot: tab === 'proposed' && n > 0 };
  });
}

/** 読めなかったトークンの知らせ。何が読めなかったかと、語として本文を探していることと、書き方を言う。 */
function hintOf(token: string): string {
  const key = token.slice(0, token.indexOf(':')).toLowerCase();
  const how = key === 'is' ? 'is: の後は paused・done・archived・active・proposed・running・waiting のどれかです'
    : key === 'since' ? 'since: の後は 7d のように日数と d を書きます'
      : key === 'project' ? 'その名前で始まるプロジェクトがありません'
        : 'file: の後にパスがありません';
  return `「${token}」は条件として読めないので、語として本文を探しています。${how}。`;
}

export function presentSessions(state: State, store: Store, now: number): SessionsProps {
  const projects = Object.values(store.projects).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  const f = state.search.filter;
  const conditions = conditionsOf(state.search.text, f, store);
  // 節の元の並び（presenters/row.ts の sortForSections）。タブの件数もこの全件から数える。
  const all = sortForSections(Object.values(store.sessions)).map((s) => ({ s, row: presentSessionRow(s, store, now) }));
  // 見出しの件数は条件に関わらず手元の全件で、「すべて」のタブと同じく Archived を除く。絞った結果の件数は条件の行が言う。
  const allCount = all.filter((x) => x.row.state !== 'archived').length;
  const tab = f.status ?? 'all';
  const common: Pick<SessionsProps, 'tabs' | 'tab' | 'tokens' | 'hints'> = { tabs: presentTabs(all.map((x) => x.row)), tab, tokens: queryTokens(f, projects), hints: badTokens(state.search.text, projects).map(hintOf) };
  if (!usesServerSearch(state.search)) {
    let list = all;
    if (f.projectId) list = list.filter(({ s }) => s.projectId === f.projectId);
    if (f.live !== undefined) { const alive = runningSessionIds(store); list = list.filter(({ s }) => liveFilterOfSession(store, s, alive) === f.live); }
    const { days, until } = f;
    if (days) { const since = periodStart(days, now); list = list.filter(({ s }) => (s.lastActivityAt ?? 0) >= since); }
    if (until !== undefined) list = list.filter(({ s }) => (s.lastActivityAt ?? 0) < until);
    let rows = list.map((x) => x.row);
    const filtered = hasConditions(state.search);
    // タブを選べばその状態だけに、「すべて」のまま条件を入れたら Archived を除く（サーバの hideArchived と同じ）。
    const status = f.status;
    if (status) rows = rows.filter((r) => matchesStatus(r, status));
    else if (filtered) rows = rows.filter((r) => r.state !== 'archived');
    // 条件が無いときは節で読む。条件かタブがあれば平らな結果にする。
    // 節は Done を畳んで短く保つので、ページに分けない（S1）。平らな一覧だけをいまのページの分に切り出す。
    const sections = filtered ? null : sectionRows(rows, 'sessions', { now, doneHead: DONE_HEAD, expanded: new Set() });
    const pager = sections ? null : pagerOf(state.search.page, state.pageSize, rows.length);
    const shown = pageSlice(rows, pager);
    // 状態の列は、ページではなく条件に合う全件で決める。ページを送るたびに列が出入りしないように。
    return { text: '', filter: f, projects, rows: shown, total: rows.length, loading: false, mode: 'all', allCount, conditions, sections, pager, statusColumn: statusColumnOf(tab, rows), ...common };
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
    // 跳び先は主線の抜粋だけから取る。seq は主線とサブエージェントで別々に振るので、サブエージェントの seq では主線の違う行に着く。
    // 主線の抜粋が無ければ跳ばずに開く。
    const main = h.snippets.find((x) => x.agentId === null);
    if (state.search.text && main) row.jump = { seq: main.seq, q: state.search.text };
    rows.push(row);
  }
  // サーバはいまのページの分だけを返すので、行は切り出さずにそのまま並べる。件数は手元に無い行も含めた全件である。
  const total = result?.total ?? 0;
  const pager = pagerOf(state.search.page, state.pageSize, total);
  return { text: state.search.text, filter: f, projects, rows, total, loading: store.search.loading, mode: 'search', allCount, conditions, sections: null, pager, statusColumn: statusColumnOf(tab, rows), ...common };
}
