import { isReturnOn, isReturnTime, localDate, type StatusFilter } from '@agent-hangar/shared';
import type { SessionRowProps } from './row.ts';

/**
 * 一覧の節（P3 と ★）。
 * returning は今日戻る、proposed は確かめる（Claude の提案が残っているもの）である。
 * live と continue はプロジェクト画面のいま動いているものと続き（止まっている Active、提案あり、戻る日が先の Paused）、
 * active と paused は Sessions の Active（状態が無いもの。動いているかは問わない）と Paused である。
 */
export type SectionId = 'returning' | 'proposed' | 'live' | 'continue' | 'active' | 'paused' | 'done' | 'archived';
/**
 * 一覧の項目。行と、節の見出しの和にする。
 * 見出しの count はその節の全件の数で、畳んで見せていない行も数える（検索の結果の見出しは、数えられないとき null）。
 * more は見出しの右端のボタンで、押すと target の節を広げるか（プロジェクト画面の Archived）、そのタブへ移る（Sessions）。
 */
export type ListItem = { kind: 'row'; row: SessionRowProps } | { kind: 'head'; id: SectionId | SearchHeadId; label: string; count: number | null; more?: { label: string; target: SectionId } };
/**
 * ホームの検索の結果の見出し（設計書 2.11.1）。名前か要約に当たった行の組と、トランスクリプトだけに当たった行の組である。
 * 件数は、読んだ行だけでは決まらないとき null になり、見出しは件数を出さない。
 */
export type SearchHeadId = 'nameMatch' | 'transcriptMatch';

/**
 * Sessions の Done の節で見せる件数。残りは「ほか N 件」でタブへ移る。
 * プロジェクト画面の Done は畳まずに全件を出し、ページ送りに分ける（2026-10-06 の決定。導入時の一括で Done がほぼ全件になり、畳むと一覧の下が空くだけだったため）。
 */
export const DONE_HEAD = 3;

const LABEL: Record<SectionId, string> = { returning: '今日戻る', proposed: '確かめる', live: 'いま動いている', continue: '続き', active: 'Active', paused: 'Paused', done: 'Done', archived: 'Archived' };
/** 節の並び。Archived はどちらも末尾の 1 行にする。Sessions は状態の並び（プロジェクトの状態と同じ順）で読む。 */
const ORDER: Record<'project' | 'sessions', SectionId[]> = {
  project: ['returning', 'live', 'continue', 'done', 'archived'],
  sessions: ['returning', 'proposed', 'active', 'paused', 'done', 'archived'],
};
/** Sessions の節とタブの対応。今日戻るにはタブが無い（Paused のタブが今日戻るも含む）。 */
export const SECTION_TAB: Partial<Record<SectionId, StatusFilter>> = { proposed: 'proposed', active: 'active', paused: 'paused', done: 'done', archived: 'archived' };

/**
 * 動いているか（入力待ち、作業中、休み、起動中）。Claude の一覧に載る前でも、hangar の run が生きていれば動いている（shared の liveFilterOf と同じ）。
 * 区切りを付けて休みのまま残っているもの（parked）は、行を作るときに live も runId も null にしてあるので、ここでは動いていない側に入る。
 */
export function isLive(r: SessionRowProps): boolean {
  return r.live !== null || r.runId !== null;
}

/**
 * 戻る日が来ているか。today は手元の暦の今日（localDate）。
 * 戻る日が欠けたり、暦に無い日だったりする Paused（同期や古い端末から届いた行）も、来ているとみなす。
 * 黙って続きに紛れると、しおりとして挟んだものを見失うからである。
 */
export function dueOn(returnOn: string | null, today: string): boolean {
  return returnOn === null || !isReturnOn(returnOn) || returnOn <= today;
}

/** タブの絞り込み。節の振り分けとは違い、行の持ち物だけで決める。Active は状態が無いもので、提案のあるものも含む（確かめると重なる）。 */
export function matchesStatus(r: SessionRowProps, f: StatusFilter): boolean {
  switch (f) {
    case 'active': return r.state === null;
    case 'proposed': return r.candidate !== null;
    default: return r.state === f;
  }
}

/**
 * 行の節。
 * プロジェクト画面は、動いているものを状態に関わらず「いま動いている」に置く（区切りを付けて休みのまま残っているものは、動いているものに数えない）。
 * Sessions は状態だけで決める。動いているものは Active の節の先頭に並び（sortForSections）、状態を付けたものは動いていてもその状態の節に入る。
 */
function sectionOf(r: SessionRowProps, kind: 'project' | 'sessions', today: string): SectionId {
  if (kind === 'project' && isLive(r)) return 'live';
  if (r.state === 'archived') return 'archived';
  if (r.state === 'paused' && dueOn(r.returnOn, today)) return 'returning';
  if (kind === 'project') return r.state === 'done' && r.candidate === null ? 'done' : 'continue';
  if (r.candidate !== null) return 'proposed';
  if (r.state === 'paused') return 'paused';
  return r.state === 'done' ? 'done' : 'active';
}

/**
 * 今日戻るの並びの鍵。欠けた日と壊れた日は空にして先頭へ置く（Home も同じ並びに使い回す）。
 * 同じ日の中は時刻の早い順にし、時刻なし（その日のうち）はその日の最後に置く（24:00 は時刻として通らない値なので、どの時刻よりも後ろに並ぶ）。
 */
export const returnKey = (r: { returnOn: string | null; returnTime?: string | null }) =>
  (r.returnOn !== null && isReturnOn(r.returnOn) ? `${r.returnOn} ${r.returnTime && isReturnTime(r.returnTime) ? r.returnTime : '24:00'}` : '');

/** 件数の桁を区切る（1,221）。 */
const num = (n: number) => n.toLocaleString('en-US');

/** 見出しの右端のボタン。プロジェクト画面は Archived だけをその場で広げ、Sessions はそのタブへ移る。 */
function moreOf(id: SectionId, kind: 'project' | 'sessions', count: number, open: boolean, doneHead: number): { label: string; target: SectionId } | undefined {
  const rest = count - doneHead;
  if (kind === 'project') return id === 'archived' ? { label: open ? '隠す ▴' : '表示 ▸', target: 'archived' } : undefined;
  if (id === 'done' && rest > 0) return { label: `ほか ${num(rest)} 件 ▸`, target: 'done' };
  if (id === 'archived') return { label: '表示 ▸', target: 'archived' };
  return SECTION_TAB[id] ? { label: 'この節だけ見る ▸', target: id } : undefined;
}

/**
 * 行を節に分けて、見出しと行の並びにする。中身がある節だけを出す。
 * rows は sortForSections の並びで渡す。節の中はその並びを保ち、今日戻るだけを戻る日の古い順に並べ直す。
 * Archived は見出しだけを出す。Sessions の Done は doneHead 件までにし、プロジェクト画面の Done は全件を出す（ページ送りは presentProject が分ける）。
 * expanded に入った Archived は、プロジェクト画面では全件を出す。Sessions では使わない（広げる代わりにタブへ移る）。
 */
export function sectionRows(rows: SessionRowProps[], kind: 'project' | 'sessions', o: { now: number; doneHead: number; expanded: Set<string> }): ListItem[] {
  const today = localDate(o.now);
  const by = new Map<SectionId, SessionRowProps[]>();
  for (const r of rows) {
    const id = sectionOf(r, kind, today);
    const list = by.get(id);
    if (list) list.push(r);
    else by.set(id, [r]);
  }
  // sort は安定なので、同じ戻る日の中は渡された並び（新しい順）のまま残る。
  by.get('returning')?.sort((a, b) => returnKey(a).localeCompare(returnKey(b)));
  const out: ListItem[] = [];
  for (const id of ORDER[kind]) {
    const list = by.get(id);
    if (!list || list.length === 0) continue;
    const open = kind === 'project' && o.expanded.has(id);
    const more = moreOf(id, kind, list.length, open, o.doneHead);
    out.push(more ? { kind: 'head', id, label: LABEL[id], count: list.length, more } : { kind: 'head', id, label: LABEL[id], count: list.length });
    const shown = id === 'done' && kind === 'sessions' ? list.slice(0, o.doneHead) : id === 'archived' && !open ? [] : list;
    for (const row of shown) out.push({ kind: 'row', row });
  }
  return out;
}
