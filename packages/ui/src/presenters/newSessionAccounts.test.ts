import { describe, expect, it } from 'vitest';
import { accountsFixture } from '../test/accounts.ts';
import { initialStore } from '../store/store.ts';
import { presentAccounts, type AccountView } from './accounts.ts';
import { accountOptions, type NewSessionAccounts } from './newSession.ts';

const NOW = new Date(2026, 9, 6, 12, 0).getTime();
const list = presentAccounts({ ...initialStore(), accounts: accountsFixture }, NOW);
const accountsOf = (over: Partial<AccountView>[] = [{}, {}]): NewSessionAccounts => ({ list: list.map((a, i) => ({ ...a, ...over[i] })), currentId: 'primary' });

describe('accountOptions（アカウントの札から開く一覧の行）', () => {
  it('名前と色の点を持ち、ログイン済みなら選べる', () => {
    expect(accountOptions(accountsOf())).toEqual([
      { value: 'primary', label: '会社', color: '#2a57b8', disabled: false },
      { value: 'a1', label: '大学', color: '#7a4a9e', disabled: false },
    ]);
  });
  it('未ログインは選べず、理由を添える', () => {
    const [, second] = accountOptions(accountsOf([{}, { auth: 'out' }]));
    expect(second).toEqual({ value: 'a1', label: '大学', color: '#7a4a9e', disabled: true, tag: '未ログイン' });
  });
  it('初めてのログインの途中は選べず、承認を促す。ログインし直しの途中は選べる', () => {
    const [first, second] = accountOptions(accountsOf([{ auth: 'running', loggedIn: false }, { auth: 'running', loggedIn: true }]));
    expect(first).toMatchObject({ disabled: true, tag: 'ブラウザで承認してください…' });
    expect(second).toMatchObject({ disabled: false });
    expect('tag' in second!).toBe(false);
  });
  it('まだ読めていない（unknown）なら選べる', () => {
    expect(accountOptions(accountsOf([{ auth: 'unknown' }, {}]))[0]).toMatchObject({ disabled: false });
  });
});
