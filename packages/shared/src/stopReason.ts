import type { LimitKind, LiveStatus, PermissionAskDto, SessionActivityDto, SessionLimitDto, WaitKind } from './api.ts';
import type { Translate } from './i18n/t.ts';
import { localDate, localTime } from './sessionState.ts';

/**
 * 止まっている理由（2026-10-12 の試作 stop-reason-proto の V1）。
 * permission は許可待ち（ツールの許可を求めて入力待ち）、limit は使用制限（リセットを待っている休み）、
 * reset はリセット済み（リセットの時刻から猶予を過ぎても続きが始まっていない休み）である。
 * 入力待ちの問いと、ほかの入力待ちは理由を付けない（今までどおりの入力待ち）。
 */
export type StopReason = 'permission' | 'limit' | 'reset';

/**
 * リセットの時刻から、続きが始まるのを待つ長さ。
 * これを過ぎても休みのままなら、自動では続かなかったとみなし、リセット済みとして要対応に上げる。
 */
export const LIMIT_RESET_GRACE_MS = 90_000;
/**
 * 自動で続く予約のある（auto）ものを待つ長さ。
 * Claude Code の自動の続きは、リセットから 70 秒から 90 秒ほど遅れて始まる（2.1.296 の実測）ので、ふだんの猶予では自動で続くものまでリセット済みにしてしまう。
 */
export const LIMIT_RESET_AUTO_GRACE_MS = 150_000;

/**
 * Claude Code の登録の waitingFor の値と、その読み方。
 * Claude Code 自身も、この 4 つを permission と question に分けて扱う（2.1.296 の本体で確かめた）。
 * goal proposal も Claude Code は permission に数えるが、ツールの許可ではないので other にする。
 */
const PERMISSION_WAITS = new Set(['permission prompt', 'sandbox request', 'worker request']);
const QUESTION_WAITS = new Set(['input needed']);
/** 互換の見張り（server の compat/registry.ts）が知っている値。ここに無い値は、ずれとして記録する。 */
export const KNOWN_WAITING_FOR = ['permission prompt', 'sandbox request', 'worker request', 'input needed', 'dialog open', 'goal proposal'] as const;

/** 登録の waitingFor の値を、画面の読み方に替える。文字列でなければ null。 */
export function waitKindOf(raw: unknown): WaitKind | null {
  if (typeof raw !== 'string' || raw === '') return null;
  if (PERMISSION_WAITS.has(raw)) return 'permission';
  if (QUESTION_WAITS.has(raw)) return 'question';
  return 'other';
}

/** 本文の quotaLimits.rateLimitType を、画面で言い分ける枠に替える。seven_day で始まるもの（モデル別の週の枠も）は週にまとめる。 */
export function limitKindOf(raw: unknown): LimitKind {
  if (raw === 'five_hour') return 'five_hour';
  if (typeof raw === 'string' && raw.startsWith('seven_day')) return 'weekly';
  return 'other';
}

/** 猶予の長さ。自動で続く予約のあるものは長めに待つ。 */
export function limitResetGrace(auto: boolean): number {
  return auto ? LIMIT_RESET_AUTO_GRACE_MS : LIMIT_RESET_GRACE_MS;
}

/** リセットの時刻から猶予を過ぎたか（SessionLimitDto の reset）。auto は自動で続く予約があること。 */
export function limitReset(resetsAt: number, now: number, auto = false): boolean {
  return now >= resetsAt + limitResetGrace(auto);
}

/**
 * セッションが止まっている理由。理由が無ければ null。
 * 許可待ちは、登録が許可を待つと書いた入力待ちのうち、AskUserQuestion の問いを待っていないものである。
 * Claude Code が AskUserQuestion にどの waitingFor を書くかは版で変わりうるので、問いを待っているとき（hook か本文の索引から問いの文が届いている）は問いとして扱う。
 * 使用制限は、休み（か入力待ちでない状態）で使用制限の行が残っているものである。作業中なら続きが始まっているので理由を付けない。
 */
export function stopReasonOf(s: { live: LiveStatus | null; waitingFor?: WaitKind | null; activity?: SessionActivityDto | null; permission?: PermissionAskDto | null; limit?: SessionLimitDto | null }): StopReason | null {
  if (s.live === 'waiting') {
    if (s.waitingFor !== 'permission') return null;
    const asking = (s.activity?.tool === 'AskUserQuestion' && !!s.activity.question) || s.permission?.tool === 'AskUserQuestion';
    return asking ? null : 'permission';
  }
  if (s.live === 'idle' && s.limit) return s.limit.reset ? 'reset' : 'limit';
  return null;
}

/**
 * 数えるときの動き。自動で続かずにリセットを過ぎた休み（reset）は、答えを待つものとして入力待ちに数える。
 * Done と Archived の扱いは、この後に quietLive を通して決める。
 */
export function liveWithLimit(live: LiveStatus | null, limit: SessionLimitDto | null | undefined): LiveStatus | null {
  return live === 'idle' && limit?.reset ? 'waiting' : live;
}

/** 使用制限の枠の名前（5 時間、週）。どちらでもない枠は「使用制限」とだけ言う。 */
export function limitKindText(t: Translate, kind: LimitKind): string {
  return t(kind === 'five_hour' ? 'stop.kind.fiveHour' : kind === 'weekly' ? 'stop.kind.weekly' : 'stop.kind.other');
}

/**
 * リセットの時刻の文。今日なら HH:MM、ほかの日なら M/D HH:MM（手元の時刻）。
 * 5 時間の枠はたいてい今日のうちにリセットされ、週の枠は日をまたぐ。
 */
export function resetAtText(t: Translate, resetsAt: number, now: number): string {
  const time = localTime(resetsAt);
  if (localDate(resetsAt) === localDate(now)) return time;
  const d = new Date(resetsAt);
  return t('stop.time.otherDay', { date: `${d.getMonth() + 1}/${d.getDate()}`, time });
}

/** 止まっている理由が、検索の絞り込み（is:permission、is:limited）に合うか。 */
export function matchesStopFilter(reason: StopReason | null, f: 'permission' | 'limited'): boolean {
  return f === 'permission' ? reason === 'permission' : reason === 'limit' || reason === 'reset';
}

/** 許可待ちの通知の本文。道具と命令（無ければ道具だけ）。中身が届いていなければ「許可待ちです」。 */
export function permissionNoticeText(t: Translate, p: PermissionAskDto | null): string {
  if (!p) return t('stop.notify.permissionBare');
  return p.input ? t('stop.notify.permission', { tool: p.tool, input: p.input }) : t('stop.notify.permissionTool', { tool: p.tool });
}
