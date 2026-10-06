import { describe, expect, it } from 'vitest';
import type { AccountDto } from '@agent-hangar/shared';
import { initialStore } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { isPickableAccount, presentAccount, presentAccounts, type AccountView } from './accounts.ts';
import { resetsLabel } from './format.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 9, 6, 12, 0).getTime();
const base = accountsFixture.accounts[0]!;
const acc = (over: Partial<AccountDto> = {}): AccountDto => ({ ...base, ...over });
const usage = (five: number | null, ago: number | null, resetsAt: number | null = NOW + 3 * HOUR): AccountDto['usage'] => ({
  fiveHour: five === null ? null : { usedPercent: five, resetsAt },
  sevenDay: five === null ? null : { usedPercent: 41, resetsAt: NOW + 24 * HOUR },
  updatedAt: ago === null ? null : NOW - ago,
});
const view = (over: Partial<AccountDto> = {}) => presentAccount(acc(over), 'primary', NOW);

describe('presentAccount', () => {
  it('プランの表示：既知は頭を大文字に、知らない値はそのまま、認証が未読なら null', () => {
    const withPlan = (plan: string | null) => view({ auth: { ...base.auth!, plan } }).plan;
    expect(withPlan('max')).toBe('Max');
    expect(withPlan('pro')).toBe('Pro');
    expect(withPlan('team')).toBe('Team');
    expect(withPlan('enterprise')).toBe('Enterprise');
    expect(withPlan('edu')).toBe('edu');
    expect(withPlan(null)).toBeNull();
    expect(view({ auth: null }).plan).toBeNull();
    expect(view({ auth: null }).email).toBeNull();
    expect(view().email).toBe('taro@example.co.jp');
  });
  it('auth は 4 通りで、ログインの途中が最優先', () => {
    expect(view({ auth: null }).auth).toBe('unknown');
    expect(view({ auth: { ...base.auth!, loggedIn: false } }).auth).toBe('out');
    expect(view({ auth: { ...base.auth!, loggedIn: true } }).auth).toBe('in');
    expect(view({ loginRunning: true }).auth).toBe('running');
    expect(view({ loginRunning: true, auth: null }).auth).toBe('running');
  });
  it('loggedIn：認証が読めていてログイン済みなら真。し直しの途中は running のまま真、初回の途中と未読は偽', () => {
    expect(view().loggedIn).toBe(true);
    expect(view({ auth: { ...base.auth!, loggedIn: false } }).loggedIn).toBe(false);
    expect(view({ auth: null }).loggedIn).toBe(false);
    const again = view({ loginRunning: true });
    expect([again.auth, again.loggedIn, again.email]).toEqual(['running', true, 'taro@example.co.jp']);
    const first = view({ loginRunning: true, auth: { ...base.auth!, loggedIn: false } });
    expect([first.auth, first.loggedIn]).toEqual(['running', false]);
    expect(view({ loginRunning: true, auth: null }).loggedIn).toBe(false);
  });
  it('計器：80 以上は high、resets は resetsLabel の文、値の無い窓は null', () => {
    const v = view({ usage: { fiveHour: { usedPercent: 82, resetsAt: NOW + 3 * HOUR }, sevenDay: { usedPercent: 41, resetsAt: NOW + 30 * HOUR }, updatedAt: NOW - MIN } });
    expect(v.fiveHour).toEqual({ percent: 82, high: true, resets: resetsLabel(NOW + 3 * HOUR, NOW) });
    expect(v.sevenDay).toEqual({ percent: 41, high: false, resets: resetsLabel(NOW + 30 * HOUR, NOW) });
    expect(view({ usage: { fiveHour: { usedPercent: 80, resetsAt: null }, sevenDay: null, updatedAt: NOW } }).fiveHour).toEqual({ percent: 80, high: true, resets: null });
    expect(view({ usage: { fiveHour: null, sevenDay: { usedPercent: 10, resetsAt: null }, updatedAt: NOW } }).fiveHour).toBeNull();
    expect(view({ usage: { fiveHour: { usedPercent: 79, resetsAt: null }, sevenDay: null, updatedAt: NOW } }).fiveHour?.high).toBe(false);
  });
  it('note：5 時間が 80 以上なら warn、戻る時刻が無ければ「まもなく上限」だけ', () => {
    const at = NOW + 3 * HOUR;
    expect(view({ usage: usage(82, MIN, at) }).note).toEqual({ tone: 'warn', text: `まもなく上限。${resetsLabel(at, NOW)} に戻ります` });
    expect(view({ usage: usage(82, MIN, null) }).note).toEqual({ tone: 'warn', text: 'まもなく上限' });
  });
  it('note：5 時間が 79 で値が古ければ stale（1 時間以上は時間、24 時間以上は日）、59 分前なら null', () => {
    expect(view({ usage: usage(79, 3 * HOUR + 10 * MIN) }).note).toEqual({ tone: 'stale', text: '3 時間前の値' });
    expect(view({ usage: usage(79, 59 * MIN) }).note).toBeNull();
    // 境は「1 時間より古い」。ちょうど 1 時間は注記なし、1 時間 1 分から出る。
    expect(view({ usage: usage(79, HOUR) }).note).toBeNull();
    expect(view({ usage: usage(79, HOUR + MIN) }).note).toEqual({ tone: 'stale', text: '1 時間前の値' });
    expect(view({ usage: usage(79, 26 * HOUR) }).note).toEqual({ tone: 'stale', text: '1 日前の値' });
  });
  it('戻る時刻を過ぎた窓は 0% で、戻る時刻は出さない。上限の注記も出さず、古い値の注記だけ残る', () => {
    const v = view({ usage: { fiveHour: { usedPercent: 85, resetsAt: NOW - 2 * HOUR }, sevenDay: { usedPercent: 41, resetsAt: NOW + 30 * HOUR }, updatedAt: NOW - 3 * HOUR } });
    expect(v.fiveHour).toEqual({ percent: 0, high: false, resets: null });
    expect(v.sevenDay).toEqual({ percent: 41, high: false, resets: resetsLabel(NOW + 30 * HOUR, NOW) });
    expect(v.note).toEqual({ tone: 'stale', text: '3 時間前の値' });
  });
  it('note：5 時間が 85 で値も古ければ warn が優先', () => {
    expect(view({ usage: usage(85, 5 * HOUR) }).note?.tone).toBe('warn');
  });
  it('値が 1 度も無ければ、計器も updatedLabel も note も null', () => {
    const v = view({ usage: { fiveHour: null, sevenDay: null, updatedAt: null } });
    expect(v.fiveHour).toBeNull();
    expect(v.sevenDay).toBeNull();
    expect(v.updatedLabel).toBeNull();
    expect(v.note).toBeNull();
  });
  it('updatedLabel は relativeTime の文、残りの項目はそのまま運ぶ', () => {
    const v = view({ usage: usage(10, 3 * MIN), linkProblem: 'リンクが壊れています' });
    expect(v.updatedLabel).toBe('3 分前');
    expect(v).toMatchObject({ id: 'primary', name: '会社', color: '#2a57b8', primary: true, dir: '/h/.claude', linkProblem: 'リンクが壊れています' });
  });
});

describe('presentAccounts', () => {
  it('current は currentId と一致する 1 件だけ真', () => {
    const store = { ...initialStore(), accounts: { ...accountsFixture, currentId: 'a1' } };
    const list = presentAccounts(store, NOW);
    expect(list.map((a) => [a.id, a.current])).toEqual([['primary', false], ['a1', true]]);
  });
  it('currentId が一覧に無いときは、最初のアカウントの 1 件だけが current', () => {
    const store = { ...initialStore(), accounts: { ...accountsFixture, currentId: 'gone' } };
    expect(presentAccounts(store, NOW).map((a) => [a.id, a.current])).toEqual([['primary', true], ['a1', false]]);
  });
  it('store.accounts が null なら空の配列', () => {
    expect(presentAccounts(initialStore(), NOW)).toEqual([]);
  });
});

describe('isPickableAccount', () => {
  const of = (auth: AccountView['auth'], loggedIn: boolean): AccountView => ({ ...view(), auth, loggedIn });
  it.each([
    ['out', false, false],
    ['running', false, false],
    ['running', true, true],
    ['in', true, true],
    ['unknown', false, true],
  ] as const)('auth が %s で loggedIn が %s なら、選べる:%s', (auth, loggedIn, want) => {
    expect(isPickableAccount(of(auth, loggedIn))).toBe(want);
  });
});
