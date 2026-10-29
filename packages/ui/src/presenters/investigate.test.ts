import { describe, expect, it } from 'vitest';
import type { AccountsDto, SessionDto } from '@agent-hangar/shared';
import { codexAccountsFixture } from '../test/accounts.ts';
import { initialStore, type Store } from '../store/store.ts';
import { investigateSeed } from './investigate.ts';

const base: Store = { ...initialStore(), version: '0.13.1', accounts: codexAccountsFixture };
const withLanguage = (s: Store, language: 'ja' | 'en'): Store => ({ ...s, settings: { ...(s.settings ?? {}), language } as Store['settings'] });
const broken = (a: AccountsDto, id: string): AccountsDto => ({ ...a, accounts: a.accounts.map((x) => (x.id === id ? { ...x, linkProblem: '~/.claude-univ/plugins が共有から外れています' } : x)) });

describe('investigateSeed', () => {
  it('依頼の文と、操作・エラー・エージェント・アカウント・版と OS の引用に分ける', () => {
    const seed = investigateSeed(base, { op: 'launch', message: 'codex を起動できませんでした: spawn codex ENOENT', agent: 'claude-code', accountId: 'a1' }, 'darwin');
    expect(seed.request).toContain('draft_issue_report');
    expect(seed.quote.split('\n')).toEqual([
      '操作：新しいセッションの起動',
      'エラー：codex を起動できませんでした: spawn codex ENOENT',
      'エージェント：Claude Code',
      'アカウント：大学（/h/.claude-univ）',
      'hangar 0.13.1 / macOS',
    ]);
  });

  it('コードとファイルがあれば、エラーの次に足す', () => {
    const seed = investigateSeed(base, { op: 'linkRepair', message: 'EACCES', code: 'EACCES', files: ['settings.json', 'skills'], agent: 'claude-code', accountId: 'a1' }, 'win32');
    expect(seed.quote.split('\n').slice(1, 4)).toEqual(['エラー：EACCES', 'エラーコード：EACCES', 'ファイル：settings.json、skills']);
    expect(seed.quote.endsWith('hangar 0.13.1 / Windows')).toBe(true);
  });

  it('再開とフォークは、元のセッションからエージェントとアカウントを引く', () => {
    const session = { id: 'c1', provider: 'codex' } as SessionDto;
    const store: Store = { ...base, sessions: { c1: session } };
    const seed = investigateSeed(store, { op: 'resume', message: 'x', sessionId: 'c1' }, 'darwin');
    expect(seed.quote).toContain('エージェント：Codex');
    expect(seed.quote).toContain('アカウント：会社用（/h/.codex-work）');
  });

  it('エージェントが分からなければ、エージェントとアカウントの行を出さない', () => {
    const seed = investigateSeed(base, { op: 'sync', message: '401 Unauthorized' }, 'darwin');
    expect(seed.quote.split('\n')).toEqual(['操作：クラウドとの同期', 'エラー：401 Unauthorized', 'hangar 0.13.1 / macOS']);
  });

  it('アカウントは、いまのアカウントを選ぶ', () => {
    const seed = investigateSeed(base, { op: 'sync', message: 'x' }, 'darwin');
    expect(seed.accounts).toEqual({ 'claude-code': 'primary', codex: 'primary' });
  });

  it('エラーに絡むアカウントと壊れたアカウントは避け、いまのアカウント、主のアカウントの順に選ぶ', () => {
    // いまは大学（a1）。大学がエラーに絡むので、主の会社にする。
    const store: Store = { ...base, accounts: { ...codexAccountsFixture, currentId: 'a1' } };
    expect(investigateSeed(store, { op: 'accountLinks', message: 'x', agent: 'claude-code', accountId: 'a1' }, 'darwin').accounts?.['claude-code']).toBe('primary');
    // いまの大学は壊れている。主の会社にする。
    const broke: Store = { ...base, accounts: { ...broken(codexAccountsFixture, 'a1'), currentId: 'a1' } };
    expect(investigateSeed(broke, { op: 'sync', message: 'x' }, 'darwin').accounts?.['claude-code']).toBe('primary');
    // 主の会社がエラーに絡み、いまも会社。選べるものが無いので、付けない（ダイアログの既定に任せる）。
    expect(investigateSeed(base, { op: 'accountLinks', message: 'x', agent: 'claude-code', accountId: 'primary' }, 'darwin').accounts?.['claude-code']).toBeUndefined();
    // Codex のエラーは、Claude のアカウントの選びに響かない。
    expect(investigateSeed(base, { op: 'accountLinks', message: 'x', agent: 'codex', accountId: 'primary' }, 'darwin').accounts).toEqual({ 'claude-code': 'primary' });
  });

  it('アプリの表示言語で書く', () => {
    const seed = investigateSeed(withLanguage(base, 'en'), { op: 'sync', message: '401' }, 'darwin');
    expect(seed.quote.split('\n')).toEqual(['Action: Syncing with the cloud', 'Error: 401', 'hangar 0.13.1 / macOS']);
    expect(seed.request).toMatch(/^hangar/);
  });
});
