import { resumeHereOf } from './resumeHere.ts';
import { presentSessionMenu, type SessionMenuProps } from './sessionMenu.ts';
import { AUTO_DONE_IDLE_DAYS, CANDIDATE_EXPIRE_DAYS, isReturnOn, isReturnTime, overdueDays, resetAtText, returnDue, returnPastMinutes, type CandidateSource, type LiveStatus, type StopReason, type SessionDto, type SessionStateDto, type SessionStatus, type SessionSummaryDto, type StateSetBy, type StatusFilter, type Translate } from '@agent-hangar/shared';
import { aliveRunOf, shownAside, shownLive, shownReason, type Store } from '../store/store.ts';
import { absoluteTime, costLabel, relativeTime, shortModel, stateLabel } from './format.ts';
import { translatorOf } from './i18n.ts';
import { interruptMark } from './interrupted.ts';
import { phoneLabelOf } from './phoneLabel.ts';
import { projectDisplayName } from './projectName.ts';
import type { Segment } from './highlight.ts';
import { DEFAULT_DAYS, transcriptMark, type TranscriptMark } from './retention.ts';
import { presentGitChip, type GitChipProps } from './git.ts';

/**
 * 要約の見立ての札（試作 home-lists の B1）。
 * tone は色の調子で、詰まっている（blocked）とやめた（abandoned）だけに付け、ほかは null にして語だけを出す。
 */
export type SummaryStateTag = { label: string; tone: 'blocked' | 'abandoned' | null };

/** summaryState は 2 段目の頭に置く見立ての札。要約が無いときと、土台の要約のときは null。 */
export type SessionRowProps = { id: string; name: string; oneLiner: string; projectName: string | null; live: LiveStatus | null; aside: boolean; reason?: StopReason | null; reasonWord?: string | null; stateLabel: string; summaryState: SummaryStateTag | null; model: string; effort: string; when: string; whenAbs: string; filesChanged: number; prUrl: string | null; hasTranscript: boolean; transcript: TranscriptMark; cost: string; runId: string | null; excerpt?: Segment[];
  /** 検索の結果の行を開いたときの跳び先（抜粋の seq と検索語）。 */
  jump?: { seq: number; q: string };
  /** 検索で名前に当たった行の、名前の中の一致箇所（印を付ける塊）。名前に当たった行だけが持ち、名前の中に語が見つからないときも持たない。 */
  nameMarks?: Segment[];
  /** 検索で要約に当たった行。2 段目の札「要約に一致」を出す。 */
  summaryMatch?: boolean;
  /** セッションの状態。Active は null。 */
  state: SessionStatus | null;
  /** Paused の戻る日（YYYY-MM-DD）。Paused 以外は null。 */
  returnOn: string | null;
  /** Paused の戻る時刻（HH:MM、手元の時刻）。時刻の無い Paused（その日のうち）と、Paused 以外は null。 */
  returnTime: string | null;
  /** 戻る日が今日か過ぎていれば過ぎた日数（今日は 0）、先なら null。 */
  overdueDays: number | null;
  /** 戻る時点を過ぎたか（札を塗る）。時刻つきは当日でもその時刻から、時刻なしは当日の朝から。戻る日の欠けた Paused も true。 */
  returnDue: boolean;
  /** 当日の戻る時刻を過ぎてからの分。札に「3 分過ぎ」と出す。時刻の前、時刻なし、前の日に過ぎたものは null。 */
  returnPastMin: number | null;
  /** Claude の提案。状態が付いていれば null（サーバの toStateDto が状態を正にしている）。 */
  candidate: { status: 'paused' | 'done'; note: string | null; returnOn: string | null; returnTime: string | null; source: CandidateSource; ago: string } | null;
  /** 状態を誰が付けたか。conversation は会話で利用者が選んだもので、札に「会話で承認」と添える。Active は null。 */
  setBy: StateSetBy | null;
  /** 状態の札のツールチップ（札の日本語の説明、自動の Done はその理由）。省けば出さない（statusMark）。 */
  statusTitle?: string;
  /** hangar が自動で付けた Done（set_by が import）。札の頭に ✦ を置き、枠を点線にする（4a、試作の A）。 */
  autoDone?: boolean;
  /** ほかの PC の会話の「この PC で再開」（行の「⋯」の項目）。disabled は押せない理由。ほかの PC の会話でなければ省く。 */
  resumeHere?: { disabled: string | null };
  /** 中断の印（右端の「中断」）。ステータスの無いセッションで、最後の run が中断で終わり、いま終わっているものだけが持つ。title は原因と時刻。 */
  interrupted?: { label: string; title: string };
  /** スマホから起動した会話のラベル（試作 F1、名前の後ろ）。bypass は Bypass permissions で、赤い枠にする。PC で起こした会話は持たない。 */
  phone?: { label: string; title: string; bypass: boolean };

  /** git の札（2 段目の右端、試作の 2-1 の A）。まだ届いていないものと git でないものは null。 */
  git?: GitChipProps | null;
  /** 行の「⋯」と右クリックで開くセッションのメニュー（1A）。無ければ「⋯」を置かない。 */
  menu?: SessionMenuProps };

/**
 * 見立ての札を作る。札にするのは「ブロック中」だけで、進行中、完了、中止は出さない（2026-10-24 の決定。状態の札と時刻が既に言っている）。
 * 土台の要約の state は Claude の見立てではなく、プロセスが生きているかどうかの写しなので札にしない。
 */
function summaryStateTag(t: Translate, summary: SessionSummaryDto | null): SummaryStateTag | null {
  if (!summary || summary.source === 'baseline' || summary.state !== 'blocked') return null;
  return { label: stateLabel(t, summary.state), tone: 'blocked' };
}

/**
 * 一覧の行の止まっている理由と、右端の語（試作の L1）。語は「許可待ち」「使用制限 · 16:50」「リセット済み」で、2 段目の要約は変えない。
 * 理由の中身（命令、自動で続くか）はホームとセッション画面に任せる。一覧は探す場所だからである。
 */
function reasonOf(t: Translate, s: SessionDto, now: number): { reason: StopReason | null; reasonWord: string | null } {
  const reason = shownReason(s, shownLive(s));
  if (reason === 'permission') return { reason, reasonWord: t('stop.state.permission') };
  if (reason === 'limit' && s.limit) return { reason, reasonWord: t('stop.limit.short', { time: resetAtText(t, s.limit.resetsAt, now) }) };
  if (reason === 'reset') return { reason, reasonWord: t('stop.state.reset') };
  return { reason: null, reasonWord: null };
}

const DAY_MS = 86_400_000;
/** 長く動いていなかったので付いた Done とみなす、動きの無い日数の下限（選べる日数の最小）。 */
const MIN_IDLE_DAYS = Math.min(...AUTO_DONE_IDLE_DAYS.filter((d) => d > 0));

/** 札の説明の鍵。札の語は英語のまま、意味を日本語で添える（用語集の「札の説明」）。 */
const STATUS_TIP = { active: 'row.status.tip.active', paused: 'row.status.tip.paused', done: 'row.status.tip.done', archived: 'row.status.tip.archived' } as const;

/**
 * 状態の札のツールチップと自動の印（2026-10-13 の決定、4a）。一覧の行とセッション画面の冒頭の札が使う。
 * 自動の Done は set_by が import の Done で、理由を言う。理由は残していないので、手元の事実から読み直す。
 * 提案の理由（note）を持つものは、放っておかれた Done の提案を確定したもの（sessions/states.ts の expireCandidates）である。
 * ターンが 3 以下なら使い捨て、会話の中か事後の要約が「完了」か「中止」なら要約で決めたもの（sessions/autoDone.ts）。
 * 付けた時点で最後の動きから 3 日（選べる日数の最小）以上たっていれば、長く動いていなかったもので、その日数を言う。
 * どれにも当たらないもの（導入時の一括 Done など）は、自動で付いたことだけを言う。
 */
export function statusMark(t: Translate, state: SessionStateDto | null, stats: { turns: number }, summary: SessionSummaryDto | null, lastActivityAt: number | null = null): { title: string; auto: boolean } {
  const status = state?.status ?? null;
  if (status === 'done' && state!.setBy === 'import') {
    if (state!.note) return { title: t('row.status.auto.expired', { days: CANDIDATE_EXPIRE_DAYS }), auto: true };
    if (stats.turns <= 3) return { title: t('row.status.auto.disposable'), auto: true };
    if (summary && summary.source !== 'baseline' && (summary.state === 'done' || summary.state === 'abandoned')) return { title: t('row.status.auto.summary'), auto: true };
    const idleDays = state!.setAt !== null && lastActivityAt !== null ? Math.floor((state!.setAt - lastActivityAt) / DAY_MS) : 0;
    if (idleDays >= MIN_IDLE_DAYS) return { title: t('row.status.auto.idle', { days: idleDays }), auto: true };
    return { title: t('row.status.auto.plain'), auto: true };
  }
  const tip = t(STATUS_TIP[status ?? 'active']);
  return { title: state?.status && state.setBy === 'conversation' ? `${tip} · ${t('row.conversation.note')}` : tip, auto: false };
}

export function presentSessionRow(s: SessionDto, store: Store, now: number, excerpt?: Segment[]): SessionRowProps {
  const t = translatorOf(store);
  // state が null なら Active として読む。
  const st = s.state;
  const status = st?.status ?? null;
  // 戻る日が欠けた・暦に無い・形の違う Paused（同期や古い端末から届く）は null にして、undefined や壊れた文字列を行に流さない。
  const returnOn = status === 'paused' && typeof st!.returnOn === 'string' && isReturnOn(st!.returnOn) ? st!.returnOn : null;
  // 時刻は日があってはじめて意味を持つ。古いサーバは returnTime を送らないので、欠けたものと形の違うものは時刻なしとして読む。
  const returnTime = returnOn !== null && typeof st!.returnTime === 'string' && isReturnTime(st!.returnTime) ? st!.returnTime : null;
  const mark = statusMark(t, st, s.stats, s.summary, s.lastActivityAt);
  const row: SessionRowProps = {
    id: s.id, name: s.name ?? t('common.label.noName'), oneLiner: s.summary?.oneLiner ?? s.firstPrompt ?? '',
    projectName: s.projectId && store.projects[s.projectId] ? projectDisplayName(store.projects[s.projectId]!, t) : null,
    live: shownLive(s), aside: shownAside(s) !== null, ...reasonOf(t, s, now), stateLabel: s.summary ? stateLabel(t, s.summary.state) : '', summaryState: summaryStateTag(t, s.summary), model: shortModel(s.stats.model), effort: s.stats.effort ?? '',
    when: relativeTime(t, s.lastActivityAt, now), whenAbs: absoluteTime(t, s.lastActivityAt), filesChanged: s.stats.filesChanged, prUrl: s.stats.prUrl, hasTranscript: s.hasTranscript,
    transcript: transcriptMark(s, store.retention?.days ?? DEFAULT_DAYS, now),
    // 区切りを付けて休みのまま残っているもの（parked）は、終わった行と同じに作る。灯も run も持たせず、状態の節に入れる。
    cost: costLabel(s.stats.costUsd), runId: s.parked ? null : aliveRunOf(store, s.id)?.id ?? null,
    state: status, returnOn, returnTime, overdueDays: returnOn ? overdueDays(returnOn, now) : null,
    returnDue: status === 'paused' && returnHasCome(st!.returnOn, returnTime, now),
    returnPastMin: returnOn !== null ? returnPastMinutes(returnOn, returnTime, now) : null,
    candidate: st?.candidate ? { status: st.candidate.status, note: st.candidate.note, returnOn: st.candidate.returnOn, returnTime: st.candidate.returnTime ?? null, source: st.candidate.source, ago: relativeTime(t, st.candidate.at, now) } : null,
    setBy: status ? st!.setBy : null,
    statusTitle: mark.title, autoDone: mark.auto,
    git: presentGitChip(t, store.git, s.id, store.sessions),
  };
  if (excerpt) row.excerpt = excerpt;
  const here = resumeHereOf(store, s, t);
  if (here) row.resumeHere = { disabled: here.disabled };
  row.menu = presentSessionMenu(store, s, t);
  if (s.interrupted && row.live === null && row.runId === null && !status) row.interrupted = interruptMark(t, s.interrupted, now);
  const phone = phoneLabelOf(s, t);
  if (phone) row.phone = phone;
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
 * 一覧の並び。
 * 生きているものを先に置くのは sortSessions と同じで、残りは新しい順にする。
 * 止まっている Done の行だけは、Done にした時刻（setAt）の新しい順にする。
 * 提案を確定した行や手で Done にした行が、最後に動いた時刻が古くても Done の先頭に来て、ページ送りの奥に消えないようにするためである。
 * 導入時の一括 Done は同じ時刻を持つので、その中は最後に動いた時刻の新しい順になる。
 */
export function sortForList(list: SessionDto[]): SessionDto[] {
  const key = (s: SessionDto) => (shownLive(s) === null && s.state?.status === 'done' ? s.state.setAt ?? 0 : s.lastActivityAt ?? 0);
  return [...list].sort((a, b) => {
    const la = liveRank(a);
    const lb = liveRank(b);
    if (la !== lb) return la - lb;
    return key(b) - key(a) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  });
}

/**
 * 戻る時点が来たか（ホームの今日戻るに出すか）。
 * 日付だけのものはその日の朝から、時刻つきのものはその時刻を過ぎてから来たものとする（2026-10-13。時刻の前は一覧の行に枠だけの札が出る）。
 * 日付なし（null と空）は利用者が選んだもので、来ることはない（ホームには出さず、一覧の Paused で見る）。
 * 暦に無い日や形の違う日の Paused（同期や古い端末から届いた行）は、来ているとみなす。黙って埋もれると、しおりとして挟んだものを見失うからである。
 */
export function returnHasCome(returnOn: string | null | undefined, returnTime: string | null | undefined, now: number): boolean {
  if (returnOn === null || returnOn === undefined || returnOn === '') return false;
  if (!isReturnOn(returnOn)) return true;
  return returnDue(returnOn, typeof returnTime === 'string' && isReturnTime(returnTime) ? returnTime : null, now);
}

/** タブの絞り込み。行の持ち物だけで決める。Active は状態が無いもので、動いているかも提案の有無も問わない（確認待ちと重なる）。 */
export function matchesStatus(r: SessionRowProps, f: StatusFilter): boolean {
  switch (f) {
    case 'active': return r.state === null;
    case 'proposed': return r.candidate !== null;
    default: return r.state === f;
  }
}

/**
 * 今日戻るの並びの鍵。欠けた日と壊れた日は空にして先頭へ置く（ホームの帯と知らせの一覧が同じ並びに使う）。
 * 同じ日の中は時刻の早い順にし、時刻なし（その日のうち）はその日の最後に置く（24:00 は時刻として通らない値なので、どの時刻よりも後ろに並ぶ）。
 */
export const returnKey = (r: { returnOn: string | null; returnTime?: string | null }) =>
  (r.returnOn !== null && isReturnOn(r.returnOn) ? `${r.returnOn} ${r.returnTime && isReturnTime(r.returnTime) ? r.returnTime : '24:00'}` : '');

/**
 * PR の URL の末尾の番号（`/pull/88` の 88）。URL がこの形でなければ null。
 * 一覧の行の 2 段目の右端に「PR #88」と出す。取れなければ「PR」とだけ出す（設計書 4.1）。
 */
export function prNumberOf(url: string | null): string | null {
  const m = url ? /\/pull\/(\d+)(?:[/?#]|$)/.exec(url) : null;
  return m ? m[1]! : null;
}

/** 状態の札の語。プロジェクトの状態と同じ英語にする。 */
export const STATUS_LABEL: Record<SessionStatus, string> = { paused: 'Paused', done: 'Done', archived: 'Archived' };
/** 状態の無い行（Active）の札の語。Active は値として持たないので、STATUS_LABEL とは別に置く。 */
export const ACTIVE_LABEL = 'Active';
/** 提案の出どころの語。ポップに「出どころ：会話 · 12 分前」と出す。exit は型に残るだけで、いまは書き手がいない。 */
const CANDIDATE_SOURCE_KEY = { in_session: 'row.candidateSource.conversation', exit: 'row.candidateSource.exit', post_hoc: 'row.candidateSource.summary' } as const;
export const candidateSourceLabel = (t: Translate, source: CandidateSource): string => t(CANDIDATE_SOURCE_KEY[source]);

/** 曜日の語。0 が日曜（Date の getUTCDay と同じ並び）。 */
const WEEKDAY_KEY = ['row.weekday.sun', 'row.weekday.mon', 'row.weekday.tue', 'row.weekday.wed', 'row.weekday.thu', 'row.weekday.fri', 'row.weekday.sat'] as const;

/**
 * 戻る日の札の文言。今日は「今日」、過ぎたものは「N 日過ぎ」、先のものは「10/2（金）」。
 * 曜日は日付だけから決まるので、今の時刻は要らない（過ぎたかどうかは overdue で受け取る）。
 * 戻る日が無いか、暦に無い日と形の違う日は「日付なし」にする（NaN や undefined を札に出さない）。
 * 時刻があれば「今日 13:30」「10/2（金）13:30」と日の後ろに添える。過ぎた日は日数だけを言う（何日も前の時刻は読んでも使い道が無い）。
 * 当日の時刻を過ぎたら（pastMin）、日と同じく過ぎた長さを言う。1 分未満は「いま」、60 分未満は分、それ以上は時間（切り捨て）。
 */
export function returnOnLabel(t: Translate, returnOn: string | null, overdue: number | null, returnTime: string | null = null, pastMin: number | null = null): string {
  return returnOnText(t, returnOn, overdue, returnTime, pastMin, false);
}

/** returnOnLabel の本体。short が真なら、先の日の時刻つきだけ曜日を省く（行の時刻の列用）。 */
function returnOnText(t: Translate, returnOn: string | null, overdue: number | null, returnTime: string | null, pastMin: number | null, short: boolean): string {
  if (returnOn === null || !isReturnOn(returnOn)) return t('row.return.noDate');
  if (overdue === 0 && pastMin !== null) return pastMin < 1 ? t('row.return.now') : pastMin < 60 ? t('row.return.minOver', { n: pastMin }) : t('row.return.hourOver', { n: Math.floor(pastMin / 60) });
  const time = returnTime !== null && isReturnTime(returnTime) ? returnTime : null;
  if (overdue === 0) return time ? t('row.return.todayAt', { time }) : t('row.return.today');
  if (overdue !== null) return t('row.return.dayOver', { n: overdue });
  const [y, m, d] = returnOn.split('-').map(Number);
  if (short && time) return t('row.return.dateTimeShort', { date: t('row.date.monthDay', { month: m!, day: d! }), time });
  const date = t('row.date.monthDayWeekday', { month: m!, day: d!, weekday: t(WEEKDAY_KEY[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!) });
  return time ? t('row.return.dateTime', { date, time }) : date;
}

/**
 * 行の時刻の列に置く戻る日の札の文言。列は 72px なので、先の日の時刻つきだけ曜日を省いて「10/6 13:30」にする。
 * 省いた曜日は、ポインタを乗せたときの説明（returnOnLabel）で読める。
 */
export function returnOnRowLabel(t: Translate, returnOn: string | null, overdue: number | null, returnTime: string | null, pastMin: number | null = null): string {
  return returnOnText(t, returnOn, overdue, returnTime, pastMin, overdue === null);
}

/** 行の状態の列に置く提案の札の語（F1）。列は 62px なので短く言い、言い切り（candidateLabel）はポインタを乗せると読める。 */
export function candidateShortLabel(t: Translate, c: { status: 'paused' | 'done' }): string {
  return t(c.status === 'done' ? 'row.candidate.doneShort' : 'row.candidate.pausedShort');
}

/** 提案の札の文言（Q3 の枠だけの札）。 */
export function candidateLabel(t: Translate, c: { status: 'paused' | 'done'; returnOn: string | null; returnTime?: string | null }): string {
  return c.status === 'done' ? t('row.candidate.done') : t('row.candidate.paused', { date: returnOnLabel(t, c.returnOn, null, c.returnTime ?? null) });
}
