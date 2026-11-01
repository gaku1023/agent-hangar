import { type AccountDto, type AgentUsageDto, type RateWindowDto, type Translate, windowAt } from '@agent-hangar/shared';
import { homePath } from '../lib/paths.ts';
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
  /** 中身が違う実ファイルになっていて、選んで直せる項目の名前（修復のダイアログへ進める）。無ければ空。 */
  linkConflicts: string[];
  /** ログイン中の Codex の方法と確認コード、取り消されたときの相手の名前。無ければ null（Claude は常に null）。 */
  login: AccountDto['login'] | null;
  dir: string;
  /** 画面に出す置き場。サーバが返したホームの下なら ~ で始まる形に縮める。ホームが分からなければ dir のまま。 */
  dirLabel: string;
};

/** 認証の状態を言う文。AccountMeters と設定の行が同じものを使う。 */
export const loggedOutText = (t: Translate): string => t('account.state.loggedOut');
export const approveText = (t: Translate): string => t('account.state.approve');
/** 承認待ちの文。確認コードの方法なら、開く先とコードを言い、それ以外は「ブラウザで承認してください…」。 */
export const approvalText = (t: Translate, a: Pick<AccountView, 'login'>): string =>
  a.login?.userCode && a.login.verificationUrl ? t('account.login.deviceCode', { url: a.login.verificationUrl, code: a.login.userCode }) : approveText(t);
/** 別のアカウントのログインに取り消されたとき（承認待ちでなくなった札）に添える一文。無ければ null。 */
export const cancelledText = (t: Translate, a: Pick<AccountView, 'login' | 'auth'>): string | null =>
  a.auth !== 'running' && a.login?.cancelledBy !== undefined ? t('account.login.cancelled') : null;

const PLANS: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };
const HOUR = 3_600_000;
/** 既存の計器（UsageGauge）の警告色と同じ線。 */
const HIGH = 80;

/** 戻る時刻を過ぎた窓は 0% として出す（windowAt）。 */
const gauge = (raw: RateWindowDto | null, now: number): AccountGauge | null => {
  const w = windowAt(raw, now);
  return w === null ? null : { percent: w.usedPercent, high: w.usedPercent >= HIGH, resets: resetsLabel(w.resetsAt, now) };
};

/**
 * 5 時間の枠が無いアカウント（週だけが届いた）。5 時間の枠は順に撤廃されているので、5 時間の行や計器を出さない。
 * どちらも届いていないときは、まだ読めていないだけなので、枠が無いとは言わない。
 */
export const fiveHourDropped = (u: { fiveHour: unknown; sevenDay: unknown }): boolean => u.fiveHour === null && u.sevenDay !== null;

/** 1 本だけ出す所（中断の群の小見出し）の計器。5 時間があれば 5 時間、無ければ週。 */
export function leadGauge(t: Translate, a: Pick<AccountView, 'fiveHour' | 'sevenDay'>): { percent: number; high: boolean; label: string } | null {
  const [g, key] = a.fiveHour ? [a.fiveHour, 'accountSwitcher.face.fiveHour'] as const : a.sevenDay ? [a.sevenDay, 'accountSwitcher.face.sevenDay'] as const : [null, null];
  return g === null ? null : { percent: g.percent, high: g.high, label: t(key, { percent: Math.round(g.percent) }) };
}

function noteOf(t: Translate, a: AccountDto, lead: AccountGauge | null, now: number): AccountView['note'] {
  if (lead?.high) return { tone: 'warn', text: lead.resets === null ? t('account.note.nearLimit') : t('account.note.nearLimitResets', { resets: lead.resets }) };
  const at = a.usage.updatedAt;
  // 境は「1 時間より古い」。ちょうど 1 時間は注記なし。
  if (at === null || now - at <= HOUR) return null;
  const hours = Math.floor((now - at) / HOUR);
  return { tone: 'stale', text: hours >= 24 ? t('account.note.staleDays', { n: Math.floor(hours / 24) }) : t('account.note.staleHours', { n: hours }) };
}

export function presentAccount(t: Translate, a: AccountDto, currentId: string, now: number, home: string | null = null): AccountView {
  const plan = a.auth?.plan ?? null;
  const fiveHour = gauge(a.usage.fiveHour, now);
  const sevenDay = gauge(a.usage.sevenDay, now);
  return {
    id: a.id, name: a.name, color: a.color, primary: a.primary, current: a.id === currentId,
    plan: plan === null ? null : PLANS[plan] ?? plan,
    email: a.auth?.email ?? null,
    auth: a.loginRunning ? 'running' : a.auth === null ? 'unknown' : a.auth.loggedIn ? 'in' : 'out',
    loggedIn: a.auth?.loggedIn === true,
    fiveHour, sevenDay,
    updatedLabel: a.usage.updatedAt === null ? null : relativeTime(t, a.usage.updatedAt, now),
    // 5 時間の枠が無いアカウントは、週で上限に近いことを言う。
    note: noteOf(t, a, fiveHour ?? (fiveHourDropped(a.usage) ? sevenDay : null), now),
    login: a.login ?? null,
    linkProblem: a.linkProblem, linkConflicts: a.linkConflicts, dir: a.dir, dirLabel: homePath(a.dir, home),
  };
}

/** Claude 以外のエージェントの枠の札（ヘッダの切り替えの面の Codex の節）。アカウントは持たず、プランと 2 本の棒だけ。 */
export type AgentUsageView = { plan: string | null; fiveHour: AccountGauge | null; sevenDay: AccountGauge | null; updatedLabel: string | null };

/** planType の小文字の値（plus、pro など）。知らない値は頭だけ大文字にする。 */
const AGENT_PLANS: Record<string, string> = { plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', free: 'Free', go: 'Go' };

const agentPlan = (plan: string | null): string | null => (plan === null || plan === '' ? null : AGENT_PLANS[plan] ?? plan.charAt(0).toUpperCase() + plan.slice(1));

export function presentAgentUsage(t: Translate, u: AgentUsageDto, now: number): AgentUsageView {
  const plan = agentPlan(u.plan);
  return { plan, fiveHour: gauge(u.fiveHour, now), sevenDay: gauge(u.sevenDay, now), updatedLabel: u.updatedAt === null ? null : relativeTime(t, u.updatedAt, now) };
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
  return accountList(store).map((a) => presentAccount(t, a, currentId, now, store.home));
}

/** Codex のアカウントの札。AccountsDto.codex が無ければ空。currentId が一覧に無ければ最初のアカウントがいまのアカウント。 */
export function presentCodexAccounts(store: Store, now: number): AccountView[] {
  const c = store.accounts?.codex;
  if (!c) return [];
  const currentId = (c.accounts.find((a) => a.id === c.currentId) ?? c.accounts.find((a) => a.primary) ?? c.accounts[0])?.id ?? '';
  const t = translatorOf(store);
  return c.accounts.map((a) => ({ ...presentAccount(t, a, currentId, now, store.home), plan: agentPlan(a.auth?.plan ?? null) }));
}

/** その Codex の会話を最後に動かしたアカウントの id。対応に無い、または一覧に無ければ最初のアカウント。一覧が空なら null。 */
export function codexAccountIdOfSession(store: Store, sessionId: string): string | null {
  const c = store.accounts?.codex;
  if (!c) return null;
  const id = c.sessions[sessionId];
  return (id ? c.accounts.find((a) => a.id === id) : undefined)?.id ?? c.accounts.find((a) => a.primary)?.id ?? c.accounts[0]?.id ?? null;
}

/** ホームの下の置き場を、~ で始まる形に縮める（macOS、Linux、Windows。lib/paths.ts）。ホームはサーバが返したものを渡す。 */
export { homePath };
