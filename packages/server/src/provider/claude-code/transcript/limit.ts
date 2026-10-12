import { limitKindOf, type LimitKind, type TranscriptEvent } from '@agent-hangar/shared';

/**
 * 使用制限で止まっていること。本文の合成の assistant 行から読み、索引が session_limits に残す（indexer/indexFile.ts）。
 * resetsAt はリセットの時刻（ミリ秒）、hitAt は当たった時刻（行の時刻、ミリ秒）。
 * auto は、Claude Code が「リセットされたら自動で続ける」と本文に書いたこと。
 */
export type Limit = { kind: LimitKind; resetsAt: number; auto: boolean; hitAt: number };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 秒で書かれたリセットの時刻をミリ秒にする。すでにミリ秒らしい大きさなら、そのまま使う。 */
const toMs = (t: number): number => (t < 1e12 ? t * 1000 : t);

/**
 * 使用制限の合成の行（type が assistant、error が rate_limit）から、枠とリセットの時刻を読む。
 * 使用制限の行は quotaLimits（status、resetsAt、rateLimitType）を持つ（2.1.273 から 2.1.296 の実物で確かめた）。
 * 同じ error の rate_limit でも、一時の混雑や組織の方針で断られたものはリセットの時刻を持たない。待っても戻らないので、使用制限としては扱わない。
 */
export function rateLimitOf(rec: unknown): { kind: LimitKind; resetsAt: number } | null {
  if (!isRec(rec) || rec.type !== 'assistant' || rec.error !== 'rate_limit' || !isRec(rec.quotaLimits)) return null;
  const q = rec.quotaLimits;
  if (typeof q.resetsAt !== 'number' || !Number.isFinite(q.resetsAt) || q.resetsAt <= 0) return null;
  return { kind: limitKindOf(q.rateLimitType), resetsAt: toMs(q.resetsAt) };
}

/** Claude Code が自動の続きを予約した、または続きを始めたと書く知らせ（system の informational）。英語の文で、版によって後ろが変わる。 */
const AUTO_CONTINUE = /continuing automatically/i;
/**
 * 自動の続きを取り消した、または切ったと書く知らせ。2.1.296 の実物の文は「Automatic continue cancelled · /rate-limit-options to re-arm」
 * （Esc）と、背面や別のアプリへ移したときの「Automatic continue cancelled · this session moved to …」、「Automatic continue was turned off · …」である。
 */
const AUTO_CANCELLED = /^Automatic continue (cancelled|was turned off)/i;

/** 行の時刻（ミリ秒）。無ければ NaN。 */
const tsOf = (rec: unknown): number => (isRec(rec) && typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN);

/**
 * 本文の 1 行を畳んで、使用制限の状態を進める。
 * 当たった行で入り、自動の続きの知らせで auto を立て、取り消しの知らせで下ろし、次の指示（自動の続きの指示も含む）、返答、ツールの呼び出しで抜ける。
 * ターンの終わりや、裏のタスクの知らせ（正規化では system）では抜けない。止まっている間にも書かれるからである。
 * 当たった行より時刻の前の行でも抜けない。初めの発言ですぐ 429 が返ると、Claude Code は使用制限の行を先に書き、時刻の早い発言の行を後から書くことがある。
 * 抜けた後にまた当たれば、新しい行で入り直す。
 */
export function foldLimit(prev: Limit | null, rec: unknown, events: TranscriptEvent[]): Limit | null {
  const hit = rateLimitOf(rec);
  if (hit) {
    const ts = tsOf(rec);
    return { ...hit, auto: false, hitAt: Number.isFinite(ts) ? ts : Date.now() };
  }
  if (prev === null) return null;
  const notes = events.filter((e) => e.kind === 'system' && e.subtype === 'informational').map((e) => (e as { text: string }).text);
  if (notes.some((n) => AUTO_CANCELLED.test(n))) return prev.auto ? { ...prev, auto: false } : prev;
  if (notes.some((n) => AUTO_CONTINUE.test(n))) return prev.auto ? prev : { ...prev, auto: true };
  if (events.some((e) => e.kind === 'user' || e.kind === 'assistant' || e.kind === 'tool_call')) {
    const ts = tsOf(rec);
    return Number.isFinite(ts) && ts < prev.hitAt ? prev : null;
  }
  return prev;
}
