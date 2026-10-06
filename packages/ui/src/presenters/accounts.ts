import type { AccountDto, RateWindowDto } from '@agent-hangar/shared';
import { accountList, currentAccount, type Store } from '../store/store.ts';
import { relativeTime, resetsLabel } from './format.ts';

export type AccountGauge = { percent: number; high: boolean; resets: string | null };
export type AccountView = {
  id: string; name: string; color: string; primary: boolean; current: boolean;
  /** プランの表示。Max、Pro、Team、Enterprise。知らない値はそのまま、認証が未読なら null。 */
  plan: string | null;
  email: string | null;
  /** 未読は 'unknown'、未ログインは 'out'、ログイン済みは 'in'、ログインの途中は 'running'。 */
  auth: 'unknown' | 'out' | 'in' | 'running';
  fiveHour: AccountGauge | null; sevenDay: AccountGauge | null;
  /** 値の時刻の文（「3 分前」）。1 度も届いていなければ null。 */
  updatedLabel: string | null;
  /** 札に添える一言。上限が近い、値が古い、のどちらか 1 つ（上限が近いほうを優先）。無ければ null。 */
  note: { tone: 'warn' | 'stale'; text: string } | null;
  linkProblem: string | null;
  dir: string;
};

const PLANS: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };
const HOUR = 3_600_000;
/** 既存の計器（UsageGauge）の警告色と同じ線。 */
const HIGH = 80;

const gauge = (w: RateWindowDto | null, now: number): AccountGauge | null =>
  w === null ? null : { percent: w.usedPercent, high: w.usedPercent >= HIGH, resets: resetsLabel(w.resetsAt, now) };

function noteOf(a: AccountDto, five: AccountGauge | null, now: number): AccountView['note'] {
  if (five?.high) return { tone: 'warn', text: five.resets === null ? 'まもなく上限' : `まもなく上限。${five.resets} に戻ります` };
  const at = a.usage.updatedAt;
  // 境は「1 時間より古い」。ちょうど 1 時間は注記なし。
  if (at === null || now - at <= HOUR) return null;
  const hours = Math.floor((now - at) / HOUR);
  return { tone: 'stale', text: hours >= 24 ? `${Math.floor(hours / 24)} 日前の値` : `${hours} 時間前の値` };
}

export function presentAccount(a: AccountDto, currentId: string, now: number): AccountView {
  const plan = a.auth?.plan ?? null;
  const fiveHour = gauge(a.usage.fiveHour, now);
  return {
    id: a.id, name: a.name, color: a.color, primary: a.primary, current: a.id === currentId,
    plan: plan === null ? null : PLANS[plan] ?? plan,
    email: a.auth?.email ?? null,
    auth: a.loginRunning ? 'running' : a.auth === null ? 'unknown' : a.auth.loggedIn ? 'in' : 'out',
    fiveHour, sevenDay: gauge(a.usage.sevenDay, now),
    updatedLabel: a.usage.updatedAt === null ? null : relativeTime(a.usage.updatedAt, now),
    note: noteOf(a, fiveHour, now),
    linkProblem: a.linkProblem, dir: a.dir,
  };
}

export function presentAccounts(store: Store, now: number): AccountView[] {
  // currentId が一覧に無いとき（外した直後など）は、currentAccount と同じく最初のアカウントがいまのアカウントになる。
  const currentId = currentAccount(store)?.id ?? '';
  return accountList(store).map((a) => presentAccount(a, currentId, now));
}
