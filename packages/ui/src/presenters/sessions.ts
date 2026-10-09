import { type LiveFilter, type SearchFilter, type StatusFilter, type Translate } from '@agent-hangar/shared';
import { badTokens, queryTokens, type QueryToken } from '../lib/searchTokens.ts';
import { periodStart, usesServerSearch } from '../mediator/screen.ts';
import type { State } from '../mediator/types.ts';
import { liveFilterOfSession, runningSessionIds, type Store } from '../store/store.ts';
import { absoluteTime } from './format.ts';
import { markTerms } from './highlight.ts';
import { translatorOf } from './i18n.ts';
import { pageSlice, pagerOf, type PagerProps } from './pager.ts';
import { matchesStatus, presentSessionRow, sortForList, type SessionRowProps } from './row.ts';

/** 状態のタブ。all は「すべて」。 */
export type StatusTab = 'all' | StatusFilter;
/** 状態のタブ 1 つ。count は桁を区切った件数、hot は数字を灯すか（確認待ちが 1 件以上のとき）。 */
export type StatusTabProps = { tab: StatusTab; label: string; count: string; hot: boolean };

/**
 * total は条件に合う全件の数である。
 * loading は問い合わせの最中を表す。
 * rows は条件に合う行の平らな並びで、検索の結果はいま持っている分、手元で組む一覧はいまのページの分である。
 * pager は手元で組む一覧のページ送りで、いちばん小さい件数に収まるときと、検索の結果（「さらに読み込む」で足す）は null。
 * statusColumn は行の状態の列を出すか。状態がどれも同じタブ（Done・Paused・Archived）では畳む（F1）。Active のタブは、並ぶ行に提案が無いときに畳む。
 * tabs は件数つきの状態のタブ、tab は選んでいるタブ、tokens は欄の中のチップ、hints は読めなかったトークンの知らせである。
 * allCount は手元の全件（Archived を除く）の数で、見出しの横に出す。
 * 節（今日戻る、確認待ち、Active、Paused、Done）で読む形は無くなった。一覧はいつも平らで、状態のタブで絞る（設計書 2.9 の 2）。
 */
export type SessionListProps = { text: string; filter: SearchFilter; projects: { id: string; name: string }[]; rows: SessionRowProps[]; total: number; loading: boolean; mode: 'all' | 'search'; conditions: string[]; tabs: StatusTabProps[]; tab: StatusTab; pager: PagerProps | null; statusColumn: boolean; tokens: QueryToken[]; hints: string[]; allCount: number };

/** 状態がどれも同じになるタブ。行の状態の列を畳む。 */
const UNIFORM_TABS: StatusTab[] = ['done', 'paused', 'archived'];
/** 状態の列を出すか。Active の行は札を持たないので、Active のタブでは提案の札があるときだけ出す。 */
const statusColumnOf = (tab: StatusTab, rows: SessionRowProps[]): boolean => (tab === 'active' ? rows.some((r) => r.candidate !== null) : !UNIFORM_TABS.includes(tab));

/** タブの並び。ステータスの札（Active、Paused、Done、Archived）は、日本語でも英語のまま出す定数である。 */
const TAB_ORDER: StatusTab[] = ['all', 'proposed', 'active', 'paused', 'done', 'archived'];
const STATUS_WORD: Record<'active' | 'paused' | 'done' | 'archived', string> = { active: 'Active', paused: 'Paused', done: 'Done', archived: 'Archived' };
const tabLabel = (t: Translate, tab: StatusTab): string => (tab === 'all' ? t('list.tab.all') : tab === 'proposed' ? t('list.tab.pending') : STATUS_WORD[tab]);

/**
 * いま効いている条件を、条件の行に並べる語にする（D1）。
 * 語、状態、動き、期間、プロジェクト、操作したファイルの順で、欄のチップの並び（queryTokens）に合わせる。
 */
function conditionsOf(t: Translate, text: string, f: SearchFilter, store: Store): string[] {
  const out: string[] = [];
  if (text) out.push(t('list.cond.keyword', { text }));
  if (f.status) out.push(tabLabel(t, f.status));
  if (f.live) out.push(liveWord(t, f.live));
  if (f.days) out.push(periodWord(t, f.days));
  if (f.until !== undefined) out.push(t('list.cond.until', { date: absoluteTime(f.until).slice(0, 10) }));
  if (f.projectId) out.push(store.projects[f.projectId]?.name ?? t('list.cond.missingProject'));
  if (f.file) out.push(f.file);
  return out;
}

/** 期間の語。絞り込みのボタンの中の期間と同じ語を使う。 */
export function periodWord(t: Translate, days: number): string {
  return days === 1 ? t('list.period.today') : days === 7 ? t('list.period.week') : days === 30 ? t('list.period.month') : t('list.period.days', { n: days });
}
/** 動きの語。is:running と is:waiting で届く。 */
const liveWord = (t: Translate, live: LiveFilter): string => (live === 'waiting' ? t('list.live.waiting') : live === 'running' ? t('list.live.running') : t('list.live.ended'));

/**
 * 状態のタブ。件数は条件に関わらず手元の全件で、行の持ち物で数える（presenters/row.ts の matchesStatus）。
 * 提案のある Active は確認待ちにも Active にも入る。
 * 「すべて」は Archived を除いた数で、条件を入れたときに並ぶ行の数え方と同じにする。
 */
export function presentTabs(rows: SessionRowProps[], t: Translate): StatusTabProps[] {
  return TAB_ORDER.map((tab) => {
    const n = tab === 'all' ? rows.filter((r) => r.state !== 'archived').length : rows.filter((r) => matchesStatus(r, tab)).length;
    return { tab, label: tabLabel(t, tab), count: n.toLocaleString('en-US'), hot: tab === 'proposed' && n > 0 };
  });
}

/** 読めなかったトークンの知らせ。何が読めなかったかと、語として本文を探していることと、書き方を言う。 */
function hintOf(t: Translate, token: string): string {
  const key = token.slice(0, token.indexOf(':')).toLowerCase();
  const how = key === 'is' ? t('list.hint.is') : key === 'since' ? t('list.hint.since') : key === 'project' ? t('list.hint.project') : t('list.hint.file');
  return t('list.hint.unread', { token, how });
}

/**
 * 一覧（タブ、欄、絞り込み、条件の行、行、ページ送り）に渡すものを組む。ホームと、1 つのプロジェクトの画面が使う。
 * 語か触ったファイルがあるときはサーバの結果を、そうでなければ手元の全件を、同じ平らな並びにする。
 * inProject を渡すと、そのプロジェクトのセッションだけを手元の全件とする（タブの件数も、見出しの件数もその分だけになる）。
 * サーバの結果は、問い合わせのときにプロジェクトで絞ってある（mediator/screen.ts の searchParams）。
 * プロジェクトは画面が決めているので、絞り込み（State.search.filter）には入れず、条件の行と欄の札にも出さない。
 */
export function presentSessionList(state: State, store: Store, now: number, inProject?: string): SessionListProps {
  const t = translatorOf(store);
  const projects = Object.values(store.projects).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  const f = state.search.filter;
  const conditions = conditionsOf(t, state.search.text, f, store);
  // 並びの元は row.ts の sortForList（生きているものを先に、残りは新しい順）。タブの件数もこの全件から数える。
  const mine = inProject === undefined ? Object.values(store.sessions) : Object.values(store.sessions).filter((s) => s.projectId === inProject);
  const all = sortForList(mine).map((s) => ({ s, row: presentSessionRow(s, store, now) }));
  // 見出しの件数は条件に関わらず手元の全件で、「すべて」のタブと同じく Archived を除く。絞った結果の件数は条件の行が言う。
  const allCount = all.filter((x) => x.row.state !== 'archived').length;
  const tab = f.status ?? 'all';
  const common: Pick<SessionListProps, 'tabs' | 'tab' | 'tokens' | 'hints' | 'allCount' | 'projects' | 'filter' | 'conditions'> = { tabs: presentTabs(all.map((x) => x.row), t), tab, tokens: queryTokens(f, projects), hints: badTokens(state.search.text, projects).map((h) => hintOf(t, h)), allCount, projects, filter: f, conditions };
  if (!usesServerSearch(state.search)) {
    let list = all;
    if (f.projectId) list = list.filter(({ s }) => s.projectId === f.projectId);
    if (f.live !== undefined) { const alive = runningSessionIds(store); list = list.filter(({ s }) => liveFilterOfSession(store, s, alive) === f.live); }
    const { days, until } = f;
    if (days) { const since = periodStart(days, now); list = list.filter(({ s }) => (s.lastActivityAt ?? 0) >= since); }
    if (until !== undefined) list = list.filter(({ s }) => (s.lastActivityAt ?? 0) < until);
    let rows = list.map((x) => x.row);
    // タブを選べばその状態だけに、「すべて」のまま条件を入れたら Archived を除く（サーバの hideArchived と同じ）。
    // 条件が無いときも「すべて」は Archived を除く（タブの件数と同じ）。
    const status = f.status;
    if (status) rows = rows.filter((r) => matchesStatus(r, status));
    else rows = rows.filter((r) => r.state !== 'archived');
    // 平らな一覧だけをいまのページの分に切り出す。
    const pager = pagerOf(state.search.page, state.pageSize, rows.length);
    const shown = pageSlice(rows, pager);
    // 状態の列は、ページではなく条件に合う全件で決める。ページを送るたびに列が出入りしないように。
    return { text: '', rows: shown, total: rows.length, loading: false, mode: 'all', pager, statusColumn: statusColumnOf(tab, rows), ...common };
  }
  const result = store.search.result;
  const rows: SessionRowProps[] = [];
  // 行は 2 段なので、抜粋は最初の 1 つだけを 2 段目に出す。
  // キーワードが無い（触ったファイルだけで絞った）ときは抜粋が無いので、2 段目は要約の 1 文になる。
  for (const h of result?.hits ?? []) {
    const s = store.sessions[h.sessionId];
    // 結果が届く前の、ほかの画面の検索の名残が混ざらないように、プロジェクトの画面ではそのプロジェクトの行だけを出す。
    if (!s || (inProject !== undefined && s.projectId !== inProject)) continue;
    const first = h.snippets[0];
    const row = presentSessionRow(s, store, now, state.search.text ? (first ? markTerms(first.text, state.search.text) : []) : undefined);
    // 開いたら、抜粋の一致へ跳ぶ（J1）。
    // 跳び先は主線の抜粋だけから取る。seq は主線とサブエージェントで別々に振るので、サブエージェントの seq では主線の違う行に着く。
    // 主線の抜粋が無ければ跳ばずに開く。
    const main = h.snippets.find((x) => x.agentId === null);
    if (state.search.text && main) row.jump = { seq: main.seq, q: state.search.text };
    rows.push(row);
  }
  // 件数は手元に無い行も含めた全件である。続きは「さらに読み込む」で足すので、ページ送りは持たない。
  const total = result?.total ?? 0;
  return { text: state.search.text, rows, total, loading: store.search.loading, mode: 'search', pager: null, statusColumn: statusColumnOf(tab, rows), ...common };
}
