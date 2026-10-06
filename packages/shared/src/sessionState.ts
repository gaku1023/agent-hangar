/**
 * セッションの状態（Active・Paused・Done・Archived）と Claude の提案。
 * 設計は docs/superpowers/specs/2026-10-01-session-status-design.md と 2026-10-02-unmarked-to-active-design.md。サーバと UI が同じ型と日付の数え方を使う。
 * Active（既定）は status の null で表し、値としては持たない。動いているかどうかは状態ではなく動きである。
 * 戻る時点は、日付（returnOn）と、任意の時刻（returnTime、HH:MM）で持つ。どちらも手元の暦と時計で読む。時刻が無ければ「その日のうち」である。
 */
export type SessionStatus = 'paused' | 'done' | 'archived';
/** 誰が付けたか。user は hangar の画面で選んだもの、conversation は会話の中で利用者が選んだもの、import は導入時の一括。 */
export type StateSetBy = 'user' | 'conversation' | 'import';
/** 提案の出どころ。会話の中、事後の要約。exit は取りやめた claude.zsh の問いの名残で、いまは書き手がいない（v14 を切るときに CHECK ごと落とす）。 */
export type CandidateSource = 'in_session' | 'exit' | 'post_hoc';
export type SessionCandidateDto = { status: 'paused' | 'done'; note: string | null; returnOn: string | null; returnTime: string | null; source: CandidateSource; at: number };
export type SessionStateDto = { status: SessionStatus | null; note: string | null; returnOn: string | null; returnTime: string | null; setBy: StateSetBy | null; setAt: number | null; candidate: SessionCandidateDto | null };
/** 理由と根拠の上限。字数は文字単位（Array.from）で数える。 */
export const STATE_NOTE_MAX = 200;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD を UTC の 0 時の時刻にする。形が違えば NaN。 */
function utcOf(date: string): number {
  const m = DATE_RE.exec(date);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
}
const fmtUtc = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** YYYY-MM-DD の形で、暦に実在する日なら true。2 月 30 日のように繰り上がる日は断る。 */
export function isReturnOn(s: string): boolean {
  const t = utcOf(s);
  return Number.isFinite(t) && fmtUtc(t) === s;
}

/** 手元の暦の日付（YYYY-MM-DD）。 */
export function localDate(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD に n 日足した日付。日付どうしの計算なので UTC の 0 時に置いて足し、夏時間の 1 時間に引きずられない。 */
export function addDays(date: string, n: number): string {
  const t = utcOf(date);
  if (!Number.isFinite(t)) throw new Error(`日付の形が違います: ${date}`);
  return fmtUtc(t + n * DAY_MS);
}

/** 戻る日が今日か過ぎていれば、過ぎた日数（今日なら 0）。先なら null。形の違う日付も null にする。 */
export function overdueDays(returnOn: string, now: number): number | null {
  const t = utcOf(returnOn);
  if (!Number.isFinite(t)) return null;
  const days = Math.round((utcOf(localDate(now)) - t) / DAY_MS);
  return days >= 0 ? days : null;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** HH:MM の形で、00:00〜23:59 なら true。 */
export function isReturnTime(s: string): boolean {
  return TIME_RE.test(s);
}

/** 手元の時刻（HH:MM）。 */
export function localTime(now: number): string {
  const d = new Date(now);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 戻る日と時刻を、手元の時刻として読んだ時点。どちらかの形が違えば NaN。 */
export function returnAtMs(returnOn: string, returnTime: string): number {
  const t = TIME_RE.exec(returnTime);
  if (!t || !isReturnOn(returnOn)) return Number.NaN;
  const [y, m, d] = returnOn.split('-').map(Number);
  return new Date(y!, m! - 1, d!, Number(t[1]), Number(t[2])).getTime();
}

/** 戻る時点を、手元のオフセット付きで書く（2026-10-05T13:30+09:00）。どのゾーンで読んだかを相手に残す。形が違えば null。 */
export function returnAtIso(returnOn: string, returnTime: string): string | null {
  const ms = returnAtMs(returnOn, returnTime);
  if (!Number.isFinite(ms)) return null;
  const off = -new Date(ms).getTimezoneOffset();
  const abs = Math.abs(off);
  return `${returnOn}T${returnTime}${off < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 当日の戻る時刻を過ぎてからの分（切り捨て）。時刻が無い、まだ過ぎていない、日が今日でないときは null。 */
export function returnPastMinutes(returnOn: string, returnTime: string | null, now: number): number | null {
  if (returnTime === null || !isReturnTime(returnTime) || overdueDays(returnOn, now) !== 0) return null;
  const at = returnAtMs(returnOn, returnTime);
  return now >= at ? Math.floor((now - at) / 60_000) : null;
}

/**
 * 戻る時点を過ぎたか。日が過ぎていれば true。当日は、時刻が無ければ朝から true（その日のうち）、時刻があればその時刻から true。
 * 形の違う日付は false にする（overdueDays と同じ）。形の違う時刻は無いものとして読む。
 */
export function returnDue(returnOn: string, returnTime: string | null, now: number): boolean {
  const days = overdueDays(returnOn, now);
  if (days === null) return false;
  if (days > 0 || returnTime === null || !isReturnTime(returnTime)) return true;
  return now >= returnAtMs(returnOn, returnTime);
}
