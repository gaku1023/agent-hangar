import { describe, expect, it } from 'vitest';
import type { AccountsDto, SessionDto } from '@agent-hangar/shared';
import { codexAccountsFixture } from '../test/accounts.ts';
import { initialStore, type Store } from '../store/store.ts';
import { investigateSeed, setupGuideSeed } from './investigate.ts';

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

  it('注意から調べるときは、注意用の依頼の文と「注意：」の引用にし、引用を中立の色にする', () => {
    const seed = investigateSeed(base, { op: 'compat', message: '変更点あり\nClaude Code 2.4.2：変更点 1 件', agent: 'claude-code' }, 'darwin');
    expect(seed.request).toMatch(/^hangar で下の注意が出ました。/);
    expect(seed.quote.split('\n')).toEqual(['注意：変更点あり', 'Claude Code 2.4.2：変更点 1 件', 'エージェント：Claude Code', 'hangar 0.13.1 / macOS']);
    expect(seed.tone).toBe('info');
    // エラーから調べるときは色を付けない（エラーの色のまま）。
    expect(investigateSeed(base, { op: 'sync', message: 'x' }, 'darwin').tone).toBeUndefined();
  });
});

describe('setupGuideSeed', () => {
  const readiness = {
    tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.5a' }, claude: { path: '/Users/me/.local/bin/claude', ok: true, problem: null, version: '2.1.312' }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
    workspace: { path: '/Users/me/workspace', exists: true, projectCount: 12 }, mcp: { registered: false, file: '/Users/me/.claude.json' }, statusline: { command: null, scriptPath: null, installed: false },
    commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install', join: 'hangar cloud join <URL>' },
  } as unknown as NonNullable<Store['readiness']>;
  const guide = { path: '~/.agent-hangar/setup-guide.md', version: '3', sha: '9f2c1a7e' } as NonNullable<Store['setupGuide']>;
  const store: Store = { ...base, readiness, setupGuide: guide };
  it('依頼の文はすゝめの一言、引用はいまの準備の状況（各行と版と OS）で、中立の色にする', () => {
    const seed = setupGuideSeed(store, 'darwin')!;
    expect(seed.request).toBe('~/.agent-hangar/setup-guide.md（v3 sha256:9f2c1a7e）を読んで、私の環境を診断して。書き換えは私が承認してから');
    const lines = seed.quote.split('\n');
    expect(lines[0]).toBe('tmux（準備完了）：/opt/homebrew/bin/tmux（3.5a）');
    expect(lines[1]).toBe('claude（準備完了）：/Users/me/.local/bin/claude（2.1.312）');
    expect(lines).toContain('MCP サーバー（未設定）：どのセッションからも hangar の検索と要約を使えるようにします');
    expect(lines.at(-1)).toBe('hangar 0.13.1 / macOS');
    expect(seed.tone).toBe('info');
    expect(seed.accounts).toEqual({ 'claude-code': 'primary', codex: 'primary' });
  });
  it('すゝめの写しか準備の確かめが無ければ作らない', () => {
    expect(setupGuideSeed({ ...store, setupGuide: null }, 'darwin')).toBeNull();
    expect(setupGuideSeed({ ...store, readiness: null }, 'darwin')).toBeNull();
  });
});
