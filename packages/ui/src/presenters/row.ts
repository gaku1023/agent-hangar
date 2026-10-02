import { isReturnOn, overdueDays, type CandidateSource, type LiveStatus, type SessionDto, type SessionStatus, type SessionSummaryDto, type StateSetBy } from '@agent-hangar/shared';
import { aliveRunOf, shownLive, type Store } from '../store/store.ts';
import { absoluteTime, costLabel, relativeTime, shortModel, STATE_LABEL } from './format.ts';
import type { Segment } from './highlight.ts';
import { DEFAULT_DAYS, transcriptMark, type TranscriptMark } from './retention.ts';

/**
 * 要約の見立ての札（試作 home-lists の B1）。
 * tone は色の調子で、詰まっている（blocked）とやめた（abandoned）だけに付け、ほかは null にして語だけを出す。
 */
export type SummaryStateTag = { label: string; tone: 'blocked' | 'abandoned' | null };

/** summaryState は 2 段目の頭に置く見立ての札。要約が無いときと、土台の要約のときは null。 */
export type SessionRowProps = { id: string; name: string; oneLiner: string; projectName: string | null; live: LiveStatus | null; stateLabel: string; summaryState: SummaryStateTag | null; model: string; effort: string; when: string; whenAbs: string; filesChanged: number; prUrl: string | null; memo: string | null; hasTranscript: boolean; transcript: TranscriptMark; cost: string; runId: string | null; excerpt?: Segment[];
  /** 検索の結果の行を開いたときの跳び先（抜粋の seq と検索語）。 */
  jump?: { seq: number; q: string };
  /** セッションの状態。印なしは null。 */
  state: SessionStatus | null;
  /** Paused の戻る日（YYYY-MM-DD）。Paused 以外は null。 */
  returnOn: string | null;
  /** 戻る日が今日か過ぎていれば過ぎた日数（今日は 0）、先なら null。 */
  overdueDays: number | null;
  /** Claude の提案。状態が付いていれば null（サーバの toStateDto が状態を正にしている）。 */
  candidate: { status: 'paused' | 'done'; note: string | null; returnOn: string | null; source: CandidateSource; ago: string } | null;
  /** 状態を誰が付けたか。conversation は会話で利用者が選んだもので、札に「会話で承認」と添える。印なしは null。 */
  setBy: StateSetBy | null };

/**
 * 見立ての札を作る。
 * 土台の要約の state は Claude の見立てではなく、プロセスが生きているかどうかの写しなので札にしない。
 * 終わったセッションのほとんどに「済んだ」が並ぶと、本当に済んだものと見分けが付かなくなるためである。
 */
function summaryStateTag(summary: SessionSummaryDto | null): SummaryStateTag | null {
  if (!summary || summary.source === 'baseline') return null;
  const tone = summary.state === 'blocked' || summary.state === 'abandoned' ? summary.state : null;
  return { label: STATE_LABEL[summary.state], tone };
}

export function presentSessionRow(s: SessionDto, store: Store, now: number, excerpt?: Segment[]): SessionRowProps {
  // 古いサーバは state を送らない。欠けたものは印なしとして読む。
  const st = s.state ?? null;
  const status = st?.status ?? null;
  // 戻る日が欠けた・暦に無い・形の違う Paused（同期や古い端末から届く）は null にして、undefined や壊れた文字列を行に流さない。
  const returnOn = status === 'paused' && typeof st!.returnOn === 'string' && isReturnOn(st!.returnOn) ? st!.returnOn : null;
  const row: SessionRowProps = {
    id: s.id, name: s.name ?? '（名前なし）', oneLiner: s.summary?.oneLiner ?? s.firstPrompt ?? '',
    projectName: s.projectId ? store.projects[s.projectId]?.name ?? null : null,
    live: shownLive(s), stateLabel: s.summary ? STATE_LABEL[s.summary.state] : '', summaryState: summaryStateTag(s.summary), model: shortModel(s.stats.model), effort: s.stats.effort ?? '',
    when: relativeTime(s.lastActivityAt, now), whenAbs: absoluteTime(s.lastActivityAt), filesChanged: s.stats.filesChanged, prUrl: s.stats.prUrl, memo: s.memo, hasTranscript: s.hasTranscript,
    transcript: transcriptMark(s, store.retention?.days ?? DEFAULT_DAYS, now),
    // 区切りを付けて休みのまま残っているもの（parked）は、終わった行と同じに作る。灯も run も持たせず、状態の節に入れる。
    cost: costLabel(s.stats.costUsd), runId: s.parked ? null : aliveRunOf(store, s.id)?.id ?? null,
    state: status, returnOn, overdueDays: returnOn ? overdueDays(returnOn, now) : null,
    candidate: st?.candidate ? { status: st.candidate.status, note: st.candidate.note, returnOn: st.candidate.returnOn, source: st.candidate.source, ago: relativeTime(st.candidate.at, now) } : null,
    setBy: status ? st!.setBy : null,
  };
  if (excerpt) row.excerpt = excerpt;
  return row;
}

/** 生きているセッションの並び。答えを待っているものほど上に置く。 */
const LIVE_ORDER: Record<string, number> = { waiting: 0, busy: 1, idle: 2 };
/** 終わったセッションの順位。どの生きている状態よりも後ろに来る。 */
const ENDED_ORDER = 9;
/** 並びの順位。区切りを付けて休みのまま残っているもの（parked）は、終わったものと同じ順位にする。 */
const liveRank = (s: SessionDto): number => { const l = shownLive(s); return l ? LIVE_ORDER[l] ?? 3 : ENDED_ORDER; };
/** 生きているものを先頭に waiting、busy、idle の順で並べ、同じ順位の中は新しい順にする。 */
export function sortSessions(list: SessionDto[]): SessionDto[] {
  return [...list].sort((a, b) => {
    const la = liveRank(a);
    const lb = liveRank(b);
    if (la !== lb) return la - lb;
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  });
}

/**
 * 節に分ける前の並び（P3 と ★）。
 * 生きているものを先に置くのは sortSessions と同じで、残りは新しい順にする。
 * 止まっている Done の行だけは、Done にした時刻（setAt）の新しい順にする。
 * 提案を確定した行や手で Done にした行が、最後に動いた時刻が古くても Done の節の先頭に来て、畳んだ中に消えないようにするためである。
 * 導入時の一括 Done は同じ時刻を持つので、その中は最後に動いた時刻の新しい順になる。
 */
export function sortForSections(list: SessionDto[]): SessionDto[] {
  const key = (s: SessionDto) => (shownLive(s) === null && s.state?.status === 'done' ? s.state.setAt ?? 0 : s.lastActivityAt ?? 0);
  return [...list].sort((a, b) => {
    const la = liveRank(a);
    const lb = liveRank(b);
    if (la !== lb) return la - lb;
    return key(b) - key(a) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  });
}

/** 状態の札の語。プロジェクトの状態と同じ英語にする。 */
export const STATUS_LABEL: Record<SessionStatus, string> = { paused: 'Paused', done: 'Done', archived: 'Archived' };
/** 提案の出どころの語。ポップに「出どころ：会話 · 12 分前」と出す。exit は型に残るだけで、いまは書き手がいない。 */
export const CANDIDATE_SOURCE_LABEL: Record<CandidateSource, string> = { in_session: '会話', exit: '抜けるとき', post_hoc: '要約' };

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 戻る日の札の文言。今日は「今日」、過ぎたものは「N 日過ぎ」、先のものは「10/2（金）」。
 * 曜日は日付だけから決まるので、今の時刻は要らない（過ぎたかどうかは overdue で受け取る）。
 * 戻る日が無いか、暦に無い日と形の違う日は「日付なし」にする（NaN や undefined を札に出さない）。
 */
export function returnOnLabel(returnOn: string | null, overdue: number | null): string {
  if (returnOn === null || !isReturnOn(returnOn)) return '日付なし';
  if (overdue === 0) return '今日';
  if (overdue !== null) return `${overdue} 日過ぎ`;
  const [y, m, d] = returnOn.split('-').map(Number);
  return `${m}/${d}（${WEEKDAY[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]}）`;
}

/** 行の状態の列に置く提案の札の語（F1）。列は 62px なので短く言い、言い切り（candidateLabel）はポインタを乗せると読める。 */
export function candidateShortLabel(c: { status: 'paused' | 'done' }): string {
  return c.status === 'done' ? 'Done？' : 'Paused？';
}

/** 提案の札の文言（Q3 の枠だけの札）。 */
export function candidateLabel(c: { status: 'paused' | 'done'; returnOn: string | null }): string {
  return c.status === 'done' ? 'Done にする？' : `Paused · ${c.returnOn ? returnOnLabel(c.returnOn, null) : '日付なし'}？`;
}
