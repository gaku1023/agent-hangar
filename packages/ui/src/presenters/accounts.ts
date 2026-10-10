import { type AccountDto, type RateWindowDto, type Translate, windowAt } from '@agent-hangar/shared';
import { accountList, currentAccount, type Store } from '../store/store.ts';
import { relativeTime, resetsLabel } from './format.ts';
import { translatorOf } from './i18n.ts';

export type AccountGauge = { percent: number; high: boolean; resets: string | null };
export type AccountView = {
  id: string; name: string; color: string; primary: boolean; current: boolean;
  /** プランの表示。Max、Pro、Team、Enterprise。知らない値はそのまま、認証が未読なら null。 */
  plan: string | null;
  email: string | null;
  /** 未読は 'unknown'、未ログインは 'out'、ログイン済みは 'in'、ログインの途中は 'running'。 */
  auth: 'unknown' | 'out' | 'in' | 'running';
  /** 認証が読めていて、ログイン済みか。未読は false。ログインし直しの途中（auth が running）でも、元がログイン済みなら true。 */
  loggedIn: boolean;
  fiveHour: AccountGauge | null; sevenDay: AccountGauge | null;
  /** 値の時刻の文（「3 分前」）。1 度も届いていなければ null。 */
  updatedLabel: string | null;
  /** 札に添える一言。上限が近い、値が古い、のどちらか 1 つ（上限が近いほうを優先）。無ければ null。 */
  note: { tone: 'warn' | 'stale'; text: string } | null;
  linkProblem: string | null;
  dir: string;
};

/** 認証の状態を言う文。AccountMeters と設定の行が同じものを使う。 */
export const loggedOutText = (t: Translate): string => t('account.state.loggedOut');
export const approveText = (t: Translate): string => t('account.state.approve');

const PLANS: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };
const HOUR = 3_600_000;
/** 既存の計器（UsageGauge）の警告色と同じ線。 */
const HIGH = 80;

/** 戻る時刻を過ぎた窓は 0% として出す（windowAt）。 */
const gauge = (raw: RateWindowDto | null, now: number): AccountGauge | null => {
  const w = windowAt(raw, now);
  return w === null ? null : { percent: w.usedPercent, high: w.usedPercent >= HIGH, resets: resetsLabel(w.resetsAt, now) };
};

function noteOf(t: Translate, a: AccountDto, five: AccountGauge | null, now: number): AccountView['note'] {
  if (five?.high) return { tone: 'warn', text: five.resets === null ? t('account.note.nearLimit') : t('account.note.nearLimitResets', { resets: five.resets }) };
  const at = a.usage.updatedAt;
  // 境は「1 時間より古い」。ちょうど 1 時間は注記なし。
  if (at === null || now - at <= HOUR) return null;
  const hours = Math.floor((now - at) / HOUR);
  return { tone: 'stale', text: hours >= 24 ? t('account.note.staleDays', { n: Math.floor(hours / 24) }) : t('account.note.staleHours', { n: hours }) };
}

export function presentAccount(t: Translate, a: AccountDto, currentId: string, now: number): AccountView {
  const plan = a.auth?.plan ?? null;
  const fiveHour = gauge(a.usage.fiveHour, now);
  return {
    id: a.id, name: a.name, color: a.color, primary: a.primary, current: a.id === currentId,
    plan: plan === null ? null : PLANS[plan] ?? plan,
    email: a.auth?.email ?? null,
    auth: a.loginRunning ? 'running' : a.auth === null ? 'unknown' : a.auth.loggedIn ? 'in' : 'out',
    loggedIn: a.auth?.loggedIn === true,
    fiveHour, sevenDay: gauge(a.usage.sevenDay, now),
    updatedLabel: a.usage.updatedAt === null ? null : relativeTime(t, a.usage.updatedAt, now),
    note: noteOf(t, a, fiveHour, now),
    linkProblem: a.linkProblem, dir: a.dir,
  };
}

/**
 * 札で選べるか（新規セッションの札、ヘッダの切り替え）。
 * 選べないのは、未ログイン（out）と、初めてのログインの途中（running で loggedIn が偽）。
 * まだ読めていない（unknown）と、ログインし直しの途中（running で loggedIn が真）は、いまのログインが生きているので選べる。
 */
export const isPickableAccount = (a: AccountView): boolean => a.auth !== 'out' && !(a.auth === 'running' && !a.loggedIn);

/**
 * ヘッダの切り替えボタンの読み上げ。
 * 名前に 5 時間と週の使用率（丸めた値）を添える。値が無い窓は言わない。メールアドレスは入れない。
 */
export function switchLabel(t: Translate, a: Pick<AccountView, 'name' | 'fiveHour' | 'sevenDay'>): string {
  const parts = [a.name];
  if (a.fiveHour !== null) parts.push(t('accountSwitcher.face.fiveHour', { percent: Math.round(a.fiveHour.percent) }));
  if (a.sevenDay !== null) parts.push(t('accountSwitcher.face.sevenDay', { percent: Math.round(a.sevenDay.percent) }));
  return t('accountSwitcher.face.aria', { parts: parts.join(t('common.list.separator')) });
}

export function presentAccounts(store: Store, now: number): AccountView[] {
  // currentId が一覧に無いとき（外した直後など）は、currentAccount と同じく最初のアカウントがいまのアカウントになる。
  const currentId = currentAccount(store)?.id ?? '';
  const t = translatorOf(store);
  return accountList(store).map((a) => presentAccount(t, a, currentId, now));
}

/**
 * ホームの下の置き場を、~ で始まる形に縮める。
 * ホームのディレクトリは View が知らないので、/Users/<名前>/ と /home/<名前>/ の形で見分ける。
 * ホームの下でなければそのまま返す。
 */
export function homePath(path: string): string {
  const m = /^\/(?:Users|home)\/[^/]+(?:\/(.*))?$/.exec(path);
  if (m === null) return path;
  const rest = m[1] ?? '';
  return rest === '' ? '~' : `~/${rest}`;
}
