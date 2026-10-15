import { describe, expect, it } from 'vitest';
import { makeRedactor } from './redact.ts';

const ctx = {
  home: '/Users/alice',
  user: 'alice',
  host: 'alice-mbp.local',
  projects: [
    { name: 'secret-app', path: '/Users/alice/work/secret-app' },
    { name: 'other', path: '/Users/alice/code/other-dir' },
  ],
};

describe('makeRedactor', () => {
  it('プロジェクトのパスをホームより先に <project-N> にする', () => {
    const r = makeRedactor(ctx)('落ちた場所は /Users/alice/work/secret-app/src/a.ts と /Users/alice/.agent-hangar/x.log');
    expect(r.text).toBe('落ちた場所は <project-1>/src/a.ts と ~/.agent-hangar/x.log');
    expect(r.count).toBe(2);
  });

  it('プロジェクトの名前とフォルダ名を同じ番号で伏せる', () => {
    const r = makeRedactor(ctx)('secret-app と other-dir と other で起きる');
    expect(r.text).toBe('<project-1> と <project-2> と <project-2> で起きる');
  });

  it('ユーザー名とホスト名は語の境目でだけ伏せる', () => {
    const r = makeRedactor(ctx)('user alice on alice-mbp.local, not malice');
    expect(r.text).toBe('user <user> on <host>, not malice');
  });

  it('3 字未満の名前は伏せない', () => {
    const r = makeRedactor({ ...ctx, user: 'al', projects: [{ name: 'ui', path: '/p/ui' }] })('the ui is al');
    expect(r.text).toBe('the ui is al');
  });

  it('メールとトークンらしい文字列を伏せる', () => {
    const r = makeRedactor(ctx)([
      'mail me at bob@example.com',
      'token ghp_0123456789abcdefABCDEF0123456789abcd',
      'key sk-ant-api03-abcDEF_123-xyz',
      'Authorization: Bearer abc.def-ghi',
      'hash 0123456789abcdef0123456789abcdef',
    ].join('\n'));
    expect(r.text).toBe([
      'mail me at <email>',
      'token <token>',
      'key <token>',
      'Authorization: Bearer <token>',
      'hash <token>',
    ].join('\n'));
    expect(r.count).toBe(5);
  });

  it('Windows のパスは大文字小文字と区切りの違いを越えて伏せる', () => {
    const r = makeRedactor({ home: 'C:\\Users\\Alice', user: 'Alice', host: 'DESKTOP-1', projects: [{ name: 'proj', path: 'C:\\Users\\Alice\\src\\proj' }] })(
      'at c:\\users\\alice\\src\\proj\\a.ts and C:/Users/Alice/AppData/x',
    );
    expect(r.text).toBe('at <project-1>\\a.ts and ~/AppData/x');
  });

  it('agent-hangar 自身の名前は伏せず、パスは伏せる', () => {
    const r = makeRedactor({ ...ctx, projects: [{ name: 'agent-hangar', path: '/Users/alice/w/agent-hangar' }] })('agent-hangar at /Users/alice/w/agent-hangar/x');
    expect(r.text).toBe('agent-hangar at <project-1>/x');
  });

  it('同じ伏せ手で何度呼んでも番号は変わらない', () => {
    const red = makeRedactor(ctx);
    red('other');
    expect(red('secret-app').text).toBe('<project-1>');
  });
});
