/**
 * セッションの状態（Active・Paused・Done・Archived）と Claude の提案。
 * 設計は docs/superpowers/specs/2026-10-01-session-status-design.md と 2026-10-02-unmarked-to-active-design.md。サーバと UI が同じ型と日付の数え方を使う。
 * Active（既定）は status の null で表し、値としては持たない。動いているかどうかは状態ではなく動きである。
 */
export type SessionStatus = 'paused' | 'done' | 'archived';
/** 誰が付けたか。user は hangar の画面で選んだもの、conversation は会話の中で利用者が選んだもの、import は導入時の一括。 */
export type StateSetBy = 'user' | 'conversation' | 'import';
/** 提案の出どころ。会話の中、事後の要約。exit は取りやめた claude.zsh の問いの名残で、いまは書き手がいない（v14 を切るときに CHECK ごと落とす）。 */
export type CandidateSource = 'in_session' | 'exit' | 'post_hoc';
export type SessionCandidateDto = { status: 'paused' | 'done'; note: string | null; returnOn: string | null; source: CandidateSource; at: number };
export type SessionStateDto = { status: SessionStatus | null; note: string | null; returnOn: string | null; setBy: StateSetBy | null; setAt: number | null; candidate: SessionCandidateDto | null };
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
