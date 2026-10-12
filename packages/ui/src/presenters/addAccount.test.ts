import { describe, expect, it } from 'vitest';
import { initialState } from '../mediator/transition.ts';
import { initialStore } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { presentAddAccount } from './addAccount.ts';

describe('presentAddAccount', () => {
  it('ダイアログが開いていなければ null', () => {
    expect(presentAddAccount(initialState(), initialStore())).toBeNull();
  });
  it('共有の元は最初のアカウントの場所を ~ の形で、送信の進みと断られた理由を渡す', () => {
    const primary = accountsFixture.accounts.find((a) => a.primary)!;
    const home = primary.dir.replace(/[\\/][^\\/]+$/, '');
    const store = { ...initialStore(), home, accounts: accountsFixture, desktop: true };
    const open = { ...initialState(), overlay: { kind: 'addAccount' as const } };
    expect(presentAddAccount(open, store)).toMatchObject({ home, primaryDirLabel: `~${primary.dir.slice(home.length)}`, desktop: true, submitting: false, error: null, preview: null });
    expect(presentAddAccount({ ...open, accountAdd: { kind: 'submitting' } }, store)?.submitting).toBe(true);
    expect(presentAddAccount({ ...open, accountAdd: { kind: 'failed', message: 'x' } }, store)?.error).toBe('x');
  });
});
