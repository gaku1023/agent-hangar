import type { SessionDto } from '@agent-hangar/shared';

/** 保持期間の周知で使う決まりと言い方。帯、確認、一覧、詳細、設定画面の presenter がここを通す。 */
export const DAY_MS = 86_400_000;
/** 期限までこの日数を切った本文を「まもなく削除」とする。 */
export const SOON_DAYS = 7;
/**
 * 本文が無く、最後に動いてからこの日数を過ぎた会話を「保持期間で消えたとみられる」とする。
 * 今の保持期間ではなく 30 日にするのは、今日延ばしても、過去の本文は既定の 30 日で消えているからである。
 */
export const GONE_AFTER_DAYS = 30;
export const RETENTION_CHOICES = [30, 90, 365, 3650] as const;
/** 帯と詳細から延ばすときの行き先。 */
export const EXTEND_TO = 365;

export const daysLabel = (days: number): string => (days % 365 === 0 ? `${days / 365} 年` : `${days} 日`);

export function bytesLabel(bytes: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) { const v = bytes / GB; return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} GB`; }
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export const expiresBy = (mtime: number, days: number): number => mtime + days * DAY_MS;

export const isExpiringSoon = (s: SessionDto, days: number, now: number): boolean => s.transcriptMtime !== null && expiresBy(s.transcriptMtime, days) <= now + SOON_DAYS * DAY_MS;

export const countExpiring = (sessions: SessionDto[], days: number, now: number): number => sessions.filter((s) => isExpiringSoon(s, days, now)).length;

export function transcriptMark(s: SessionDto, days: number, now: number): 'present' | 'expiring' | 'gone' | 'none' {
  if (s.hasTranscript) return isExpiringSoon(s, days, now) ? 'expiring' : 'present';
  if (s.lastActivityAt !== null && now - s.lastActivityAt > GONE_AFTER_DAYS * DAY_MS) return 'gone';
  return 'none';
}
