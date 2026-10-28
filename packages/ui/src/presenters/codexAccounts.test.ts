import { describe, expect, it } from 'vitest';
import { translator, type AccountsDto, type SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { accountsFixture, codexAccountsFixture } from '../test/accounts.ts';
import { approvalText, cancelledText, presentCodexAccounts } from './accounts.ts';
import { presentAddAccount } from './addAccount.ts';
import { presentConfirm } from './confirm.ts';
import { presentShell } from './shell.ts';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const t = translator('ja');
const session = (id: string, provider: 'claude-code' | 'codex'): SessionDto => ({ id, provider, live: 'busy', parked: false } as unknown as SessionDto);
const storeWith = (accounts: AccountsDto | null): Store => ({
  ...initialStore(), bootstrapped: true, accounts,
  sessions: { c1: session('c1', 'codex'), k1: session('k1', 'claude-code') },
});
const at = (screen: State['screen']): State => ({ ...initialState(), screen });

describe('ヘッダの面の Codex のアカウント（A7）', () => {
  it('ホームでは顔は Claude のいまのアカウントのまま、Codex の節はいまの Codex アカウントを指す', () => {
    const a = presentShell(initialState(), storeWith(codexAccountsFixture), NOW).account!;
    expect(a.shown.id).toBe('primary');
    expect(a.shown.name).toBe('会社');
    expect(a.codexAccounts).toMatchObject({ shownId: 'primary', claudeShownId: 'primary', sessionId: null });
    expect(a.codexAccounts!.list.map((x) => [x.name, x.plan, x.current])).toEqual([['個人', 'Plus', true], ['会社用', 'Business', false]]);
  });
  it('Codex の会話の画面では、顔の名前と色がその会話の Codex アカウントになり、確認つきで付け替える会話を指す', () => {
    const a = presentShell(at({ name: 'session', id: 'c1' }), storeWith(codexAccountsFixture), NOW).account!;
    expect(a.shown).toMatchObject({ id: 'cw', name: '会社用', color: '#c77a1a' });
    expect(a.codexAccounts).toMatchObject({ shownId: 'cw', sessionId: 'c1', working: true, claudeShownId: 'primary' });
    // Claude の切り替えは会話の付け替えにしない（Codex の会話には Claude のアカウントが無い）。
    expect(a.sessionId).toBeNull();
  });
  it('Claude の会話では今のまま（顔は会話の Claude アカウント）。Codex の節は現在の Codex アカウント', () => {
    const a = presentShell(at({ name: 'session', id: 'k1' }), storeWith(codexAccountsFixture), NOW).account!;
    expect(a.shown.id).toBe('primary');
    expect(a.sessionId).toBe('k1');
    expect(a.codexAccounts).toMatchObject({ shownId: 'primary', sessionId: null });
  });
  it('AccountsDto.codex が無い（切、古いサーバ）ときは codexAccounts を持たず、顔も今のまま', () => {
    const store = storeWith({ ...accountsFixture, agents: { codex: { fiveHour: null, sevenDay: null, updatedAt: null, plan: 'plus' } } });
    const a = presentShell(at({ name: 'session', id: 'c1' }), store, NOW).account!;
    expect(a.codexAccounts).toBeUndefined();
    expect(a.codex?.here).toBe(true);
    expect(a.shown.id).toBe('primary');
  });
  it('会話の対応に無い Codex の会話は、最初の Codex アカウントを出す', () => {
    const store = storeWith({ ...codexAccountsFixture, codex: { ...codexAccountsFixture.codex!, currentId: 'cw', sessions: {} } });
    expect(presentShell(at({ name: 'session', id: 'c1' }), store, NOW).account!.shown.id).toBe('primary');
  });
});

describe('Codex のアカウントの札と文', () => {
  it('承認待ちは確認コードの方法なら開く先とコード、取り消されたものは付録の一文を言う', () => {
    const dto: AccountsDto = { ...codexAccountsFixture, codex: { ...codexAccountsFixture.codex!, accounts: [
      { ...codexAccountsFixture.codex!.accounts[0]!, auth: null, loginRunning: true, login: { method: 'deviceCode', userCode: 'ABCD-1234', verificationUrl: 'https://auth.example/device' } },
      { ...codexAccountsFixture.codex!.accounts[1]!, auth: { loggedIn: false, email: null, plan: null, orgName: null, checkedAt: 1 }, login: { method: 'browser', cancelledBy: '個人' } },
    ] } };
    const [a, b] = presentCodexAccounts(storeWith(dto), NOW);
    expect(a!.auth).toBe('running');
    expect(approvalText(t, a!)).toBe('https://auth.example/device を開き、コード ABCD-1234 を入力してください');
    expect(cancelledText(t, a!)).toBeNull();
    expect(cancelledText(t, b!)).toBe('別のアカウントのログインを開始したため、取り消しました');
    expect(approvalText(t, { login: { method: 'browser' } })).toBe('ブラウザで承認してください…');
  });
});

describe('Codex の確認と追加ダイアログの表示', () => {
  it('確認の名前は Codex の一覧から引く（Claude と id が重なっても取り違えない）', () => {
    const state = (kind: 'switchAccount' | 'removeAccount', agent?: 'codex'): State => ({
      ...initialState(),
      overlay: { kind: 'confirm', confirm: kind === 'switchAccount' ? { kind, sessionId: 'c1', accountId: 'primary', working: false, ...(agent ? { agent } : {}) } : { kind, accountId: 'primary', ...(agent ? { agent } : {}) } },
    });
    const store = storeWith(codexAccountsFixture);
    expect(presentConfirm(state('switchAccount', 'codex'), store, NOW)?.accountName).toBe('個人');
    expect(presentConfirm(state('switchAccount'), store, NOW)?.accountName).toBe('会社');
    expect(presentConfirm(state('removeAccount', 'codex'), store, NOW)?.accountName).toBe('個人');
  });
  it('追加ダイアログは agent を渡し、Codex の共有の元は Codex の最初のアカウントの場所にする', () => {
    const store = { ...storeWith(codexAccountsFixture), home: '/h' };
    const claude = presentAddAccount({ ...initialState(), overlay: { kind: 'addAccount' } }, store);
    const codex = presentAddAccount({ ...initialState(), overlay: { kind: 'addAccount', agent: 'codex' } }, store);
    expect(claude).toMatchObject({ agent: 'claude-code', primaryDirLabel: '~/.claude' });
    expect(codex).toMatchObject({ agent: 'codex', primaryDirLabel: '~/.codex' });
  });
});
