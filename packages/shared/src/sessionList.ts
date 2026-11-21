import type { LiveAsideDto, LiveStatus, SessionDto, SessionLockDto } from './api.ts';
import type { StopFilter } from './action.ts';
import { liveFilterOf, quietLive, type LiveFilter } from './liveFilter.ts';
import type { SessionStatus } from './sessionState.ts';
import { liveWithLimit, matchesStopFilter, stopReasonOf, type StopReason } from './stopReason.ts';

/**
 * 会話の一覧の並び、絞り込み、入れ子、頁の切り出し。
 * 画面の一覧（ui の presenters/sessions.ts）と、サーバの一覧の形の検索（/api/search の語が空のとき）が同じ答えを出すよう、ここに 1 つだけ持つ。
 * 画面が手元の全件から組む並びと、サーバが頁ごとに返す並びが食い違うと、頁を送ったときに行が抜けたり重なったりする。
 */

/**
 * 一覧で見せる動き。区切りを付けて休みのまま残っているもの（parked）は、終わったものと同じに見せる。
 * Done と Archived にした入力待ちは、入力待ちの印を付けないよう休みに見せる（quietLive）。
 * セッション画面は本当の動き（session.live）を出すので、これを使わない。
 */
export function shownLive(session: SessionDto): LiveStatus | null {
  return session.parked ? null : quietLive(liveWithLimit(session.live, session.limit), session.state?.status, session.woke);
}

/**
 * 一覧で見せる止まっている理由（stopReasonOf）。shown は一覧で見せる動き（shownLive など）である。
 * Done と Archived にした入力待ち（quietLive で休みに見せるもの）には付けない。
 * 許可待ちとリセット済みは入力待ちに、使用制限は休みに見えているときだけ付ける。
 */
export function shownReason(s: SessionDto, shown: LiveStatus | null): StopReason | null {
  const reason = stopReasonOf(s);
  if (reason === 'permission' || reason === 'reset') return shown === 'waiting' ? reason : null;
  return reason === 'limit' && shown === 'idle' ? reason : null;
}

/**
 * ほかの PC の run の状態を、この PC の画面での動き（点）に読む（SessionLockDto の live・reason）。
 * 未知（null、古いサーバ）と、黙った PC（stale）は、状態が分からないので灰の点（idle）のままにする。
 * リセット済み（reset）の休みは、この PC の liveWithLimit と同じく入力待ちに数える。
 */
export function remoteLiveOf(lock: SessionLockDto): LiveStatus {
  if (lock.stale || !lock.live) return 'idle';
  return lock.live === 'idle' && lock.reason === 'reset' ? 'waiting' : lock.live;
}

/**
 * ほかの PC の run の裏だけの印（SessionLockDto の aside）。この PC の画面で busy に見えるときだけ返す。
 * 黙った PC（stale）と未知は、状態が分からないので印を付けない。
 */
export function remoteAsideOf(lock: SessionLockDto): LiveAsideDto | null {
  return remoteLiveOf(lock) === 'busy' ? lock.aside ?? null : null;
}

/** 数えるときの live。この PC の live が無く、ほかの PC のロックがあるときは、そのロックの状態に読む。 */
function countedLive(s: SessionDto): LiveStatus | null {
  return s.live ?? (s.lock ? remoteLiveOf(s.lock) : null);
}

/**
 * 数えるときのセッションの状態（実行中、入力待ち、終了）。
 * alive は、どこかの PC で終わっていない run がある会話の id（画面の aliveAnywhere、サーバの aliveIdsOf）。
 * 区切り（Done・Archived）を付けて休みのまま残っているもの（parked）は、プロセスが残っていても終了に数える。
 */
export function sessionLiveFilter(session: SessionDto, alive: ReadonlySet<string>): LiveFilter {
  return liveFilterOf(quietLive(liveWithLimit(countedLive(session), session.limit), session.state?.status, session.woke), alive.has(session.id), session.parked);
}

const LIVE_ORDER: Partial<Record<LiveStatus, number>> = { waiting: 0, busy: 1, idle: 2 };
const ENDED_ORDER = 9;
/** 並びの順位。区切りを付けて休みのまま残っているもの（parked）は、終わったものと同じ順位にする。 */
export const liveRank = (s: SessionDto): number => { const l = shownLive(s); return l ? LIVE_ORDER[l] ?? 3 : ENDED_ORDER; };

/**
 * 一覧の並び。
 * 生きているものを先に置き（waiting、busy、idle の順）、残りは新しい順にする。
 * 止まっている Done の行だけは、Done にした時刻（setAt）の新しい順にする。
 * 提案を確定した行や手で Done にした行が、最後に動いた時刻が古くても Done の先頭に来て、ページ送りの奥に消えないようにするためである。
 * 導入時の一括 Done は同じ時刻を持つので、その中は最後に動いた時刻の新しい順になる。
 */
export function sortForList(list: SessionDto[]): SessionDto[] {
  // 何千件も並べるので、順位と鍵は 1 件につき 1 回だけ求めてから並べる（比べるたびに shownLive を通すと重い）。
  const keyed = list.map((s) => {
    const rank = liveRank(s);
    const last = s.lastActivityAt ?? 0;
    return { s, rank, key: rank === ENDED_ORDER && s.state?.status === 'done' ? s.state.setAt ?? 0 : last, last };
  });
  keyed.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : b.key - a.key || b.last - a.last));
  return keyed.map((x) => x.s);
}

/** 起動元を引く表。会話の id から、spawnedBy と状態だけを読む。 */
export type SpawnTable = Record<string, { spawnedBy?: string | null; state?: { status: string | null } | null } | undefined>;

/**
 * 入れ子にするときの起動元。自分自身を指すもの、無いもの、Done か Archived のものは null。
 * 終わった会話の下に、動いている仕事を並べないためである。起動元を Active に戻せば、また入れ子になる。
 * 起動元は SessionDto.spawnedBy で、古いサーバは返さないので undefined は null と読む。
 */
export function spawnParentOf(sessions: SpawnTable, id: string): string | null {
  const p = sessions[id]?.spawnedBy;
  if (typeof p !== 'string' || p === '' || p === id) return null;
  const parent = sessions[p];
  if (parent === undefined || parent.state?.status === 'done' || parent.state?.status === 'archived') return null;
  return p;
}

/**
 * 一覧の根の行。起動元が見えている行（visible）の中に無い行である。ページ送りはこの数で数える。
 * 起動元をたどって輪になるものは、先に出てきた方を根にする。
 */
export function nestTopsOf<T extends { id: string }>(visible: T[], sessions: SpawnTable): T[] {
  const ids = new Set(visible.map((r) => r.id));
  const tops: T[] = [];
  const reach = (id: string): boolean => {
    // 起動元の連なりが、自分に戻らずに見えている行へ着くか。着かなければ根。
    const seen = new Set<string>([id]);
    for (let p = spawnParentOf(sessions, id); p !== null; p = spawnParentOf(sessions, p)) {
      if (seen.has(p)) return false;
      if (ids.has(p)) return true;
      seen.add(p);
    }
    return false;
  };
  for (const r of visible) {
    const p = spawnParentOf(sessions, r.id);
    if (p === null || !ids.has(p) || !reach(r.id)) tops.push(r);
  }
  return tops;
}

/** 入れ子の木の 1 つ。 */
export type NestNode<T> = { item: T; kids: NestNode<T>[] };

/**
 * 根の行に、起動元の下の子の行を足した木（深さ優先の兄弟の並びは pool の順）。
 * 子は pool（いまの条件の、状態の絞り込み前の全部）から引くので、状態が起動元と違う子も起動元の下に出る。
 * 同じ一覧に同じ行を 2 度並べないよう、ほかの根になっている子は起動元の下には足さない。
 */
export function nestForest<T extends { id: string }>(tops: T[], pool: T[], sessions: SpawnTable): NestNode<T>[] {
  const kids = new Map<string, T[]>();
  for (const r of pool) {
    const p = spawnParentOf(sessions, r.id);
    if (p !== null) kids.set(p, [...kids.get(p) ?? [], r]);
  }
  // 1 度並べた行は、別の起動元の下にも輪の先にも並べない。
  const seen = new Set<string>(tops.map((r) => r.id));
  const build = (x: T): NestNode<T> => {
    const ks = (kids.get(x.id) ?? []).filter((k) => !seen.has(k.id));
    for (const k of ks) seen.add(k.id);
    return { item: x, kids: ks.map(build) };
  };
  return tops.map(build);
}

/** 一覧の絞り込み。since と until は最後の活動の時刻（since 以上、until 未満）。status を省くと Archived を除く。 */
export type ListFilter = { projectId?: string; since?: number; until?: number; live?: LiveFilter; stop?: StopFilter; status?: SessionStatus | 'active' | 'proposed' };

/** タブの絞り込み。Active は状態が無いもので、動いているかも提案の有無も問わない（確認待ちと重なる）。 */
export function matchesStatusOf(s: SessionDto, f: NonNullable<ListFilter['status']>): boolean {
  const state = s.state?.status ?? null;
  switch (f) {
    case 'active': return state === null;
    case 'proposed': return !!s.state?.candidate;
    default: return state === f;
  }
}

/**
 * 並べた全件（sortForList の後）を絞る。
 * list は状態の絞り込みの前（入れ子の子を引く元）、rows は状態まで絞った後（並べる行）である。
 */
export function filterForList(sorted: SessionDto[], f: ListFilter, alive: ReadonlySet<string>): { list: SessionDto[]; rows: SessionDto[] } {
  let list = sorted;
  if (f.projectId) list = list.filter((s) => s.projectId === f.projectId);
  if (f.live !== undefined) { const live = f.live; list = list.filter((s) => sessionLiveFilter(s, alive) === live); }
  if (f.stop !== undefined) { const stop = f.stop; list = list.filter((s) => matchesStopFilter(shownReason(s, shownLive(s)), stop)); }
  if (f.since !== undefined) { const since = f.since; list = list.filter((s) => (s.lastActivityAt ?? 0) >= since); }
  if (f.until !== undefined) { const until = f.until; list = list.filter((s) => (s.lastActivityAt ?? 0) < until); }
  const status = f.status;
  const rows = status ? list.filter((s) => matchesStatusOf(s, status)) : list.filter((s) => s.state?.status !== 'archived');
  return { list, rows };
}

/** 一覧の頁の 1 行。depth は入れ子の深さ（根は 0）。畳みは画面が持つので、ここでは全部を開いた並びにする。 */
export type ListRowDto = { id: string; depth: number };
/**
 * 一覧の頁。rows は頁の根と、その下の子を深さ優先で並べたもの。
 * total は条件に合う行の数（画面の件数の表示と同じく、子も 1 件に数える）、roots は根の数（頁送りはこの数で数える）。
 */
export type ListPageDto = { rows: ListRowDto[]; total: number; roots: number };

/**
 * 会話の全件から一覧の 1 頁を組む。画面の presentSessionList の手元の一覧と同じ並び、同じ件数になる。
 * all は会話の全件（並びは問わない）、alive は終わっていない run がどこかの PC にある会話の id である。
 */
export function listPageOf(all: SessionDto[], f: ListFilter, alive: ReadonlySet<string>, offset: number, limit: number): ListPageDto {
  const table: SpawnTable = {};
  for (const s of all) table[s.id] = s;
  const { list, rows } = filterForList(sortForList(all), f, alive);
  const pool = f.status ? list : rows;
  const tops = nestTopsOf(rows, table);
  const out: ListRowDto[] = [];
  const emit = (n: NestNode<SessionDto>, depth: number): void => { out.push({ id: n.item.id, depth }); for (const k of n.kids) emit(k, depth + 1); };
  for (const n of nestForest(tops.slice(offset, offset + limit), pool, table)) emit(n, 0);
  return { rows: out, total: rows.length, roots: tops.length };
}

/**
 * 会話の件数の集計。画面が手元の全件を数えていた所（状態のタブ、プロジェクトの件数、エージェントの印、保存期間）が読む。
 * tabs の all は Archived を除いた数で、proposed は提案のある会話（Active と重なる）。
 * byProject は、プロジェクトごとの会話の数（Archived を含む）と、そのうちの Archived の数。
 * providers は、opencode と Codex の会話が 1 件でもあるか。
 * retention は保存期間（days）があるときだけ持ち、soon は近く（RETENTION_SOON_DAYS 日のうちに）消える数、expired は期限を過ぎた数である。at は数えた時刻。
 */
export type SessionCountsDto = {
  total: number;
  tabs: Record<'all' | 'proposed' | 'active' | 'paused' | 'done' | 'archived', number>;
  byProject: Record<string, { count: number; archived: number }>;
  providers: { opencode: boolean; codex: boolean };
  retention: { days: number; soon: number; expired: number; at: number } | null;
};

/** 保存期間で「近く消える」とみなす日数。 */
export const RETENTION_SOON_DAYS = 7;
