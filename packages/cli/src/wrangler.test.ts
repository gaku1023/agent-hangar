import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_MARKER_ENV, type Exec, parseDatabaseId, parseWhoamiJson, parseWhoamiTable, parseWorkerUrl, wranglerEnv, WranglerRunner } from './wrangler.ts';

describe('wrangler の出力の解釈', () => {
  // wrangler 4.135 の whoami の表（logger.table、cli-table3）の形。
  const TABLE = (rows: [string, string][]): string =>
    [
      'Getting User settings...',
      '👋 You are logged in with an OAuth Token, associated with the email x@example.com.',
      '┌──────────────────┬──────────────────────────────────┐',
      '│ Account Name     │ Account ID                       │',
      '├──────────────────┼──────────────────────────────────┤',
      ...rows.map(([n, id]) => `│ ${n.padEnd(16)} │ ${id} │`),
      '└──────────────────┴──────────────────────────────────┘',
    ].join('\n');
  const A = '0123456789abcdef0123456789abcdef';
  const B = 'fedcba9876543210fedcba9876543210';

  it('whoami の表から、アカウントを全部（名前と ID）読む', () => {
    expect(parseWhoamiTable(TABLE([["X's Account", A]]))).toEqual({ loggedIn: true, accounts: [{ id: A, name: "X's Account" }] });
    expect(parseWhoamiTable(TABLE([['Personal', A], ['Team', B]]))).toEqual({ loggedIn: true, accounts: [{ id: A, name: 'Personal' }, { id: B, name: 'Team' }] });
    expect(parseWhoamiTable('Getting User settings...\nYou are not authenticated. Please run `wrangler login`.')).toEqual({ loggedIn: false, accounts: [] });
  });

  it('whoami --json から、アカウントを全部読む（wrangler 4.135 の形）', () => {
    // logger.json は JSON.stringify(data, null, 4) で、accounts は API の account をそのまま並べる。
    const json = JSON.stringify({ loggedIn: true, authType: 'OAuth Token', email: 'x@example.com', accounts: [{ id: A, name: 'Personal', type: 'standard' }, { id: B, name: 'Team' }], tokenPermissions: [] }, null, 4);
    expect(parseWhoamiJson(json)).toEqual({ loggedIn: true, accounts: [{ id: A, name: 'Personal' }, { id: B, name: 'Team' }] });
    // ログインしていないときは JsonFriendlyFatalError が {"loggedIn":false} を出して 0 以外で終わる。
    expect(parseWhoamiJson('{"loggedIn":false}')).toEqual({ loggedIn: false, accounts: [] });
    // 前後に別の行が混じっても読む。
    expect(parseWhoamiJson(`▲ [WARNING] something\n${json}\n`)).toEqual({ loggedIn: true, accounts: [{ id: A, name: 'Personal' }, { id: B, name: 'Team' }] });
    // --json を知らない古い wrangler の出力や表は JSON ではない。
    expect(parseWhoamiJson('✘ [ERROR] Unknown argument: json')).toBeNull();
    expect(parseWhoamiJson(TABLE([['Personal', A]]))).toBeNull();
    // ID の形でないものは拾わない。
    expect(parseWhoamiJson(JSON.stringify({ loggedIn: true, accounts: [{ id: 'nope', name: 'x' }, { id: A }] }))).toEqual({ loggedIn: true, accounts: [{ id: A, name: '' }] });
  });

  it('d1 create と d1 info からデータベース ID', () => {
    expect(
      parseDatabaseId(
        '✅ Successfully created DB \'hangar\'\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "hangar"\ndatabase_id = "a1b2c3d4-0000-4000-8000-000000000001"',
      ),
    ).toBe('a1b2c3d4-0000-4000-8000-000000000001');
    expect(parseDatabaseId(JSON.stringify({ uuid: 'a1b2c3d4-0000-4000-8000-000000000002', name: 'hangar' }))).toBe('a1b2c3d4-0000-4000-8000-000000000002');
    expect(parseDatabaseId('nothing')).toBeNull();
  });

  it('deploy のログから URL', () => {
    expect(parseWorkerUrl('Uploaded hangar (2.1 sec)\nDeployed hangar triggers (1.0 sec)\n  https://hangar.example.workers.dev\nCurrent Version ID: x')).toBe('https://hangar.example.workers.dev');
    expect(parseWorkerUrl('no url')).toBeNull();
  });
});

type Call = { cmd: string; args: string[]; o: { cwd: string; env: NodeJS.ProcessEnv; input?: string } };

function recorder(): { calls: Call[]; exec: Exec } {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, o) => {
    calls.push({ cmd, args, o });
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, exec };
}

const A_ID = '0123456789abcdef0123456789abcdef';

describe('WranglerRunner', () => {
  const ACCOUNT = A_ID;

  it('秘密は標準入力で渡し、argv には載せない', async () => {
    const r = recorder();
    const w = new WranglerRunner({ cloudDir: '/tmp/agent-hangar-does-not-exist', accountId: ACCOUNT, exec: r.exec });
    await w.run(['secret', 'put', 'JOIN_SECRET_HASH', '--config', '/x/wrangler.jsonc'], 'deadbeef\n');
    const c = r.calls[0]!;
    // ps から読めてはいけない。argv にも実行ファイル名にも秘密を載せない。
    expect([c.cmd, ...c.args].join(' ')).not.toContain('deadbeef');
    expect(c.o.input).toBe('deadbeef\n');
    expect(c.args[0]).toMatch(/wrangler\.js$/);
    expect(c.o.cwd).toBe('/tmp/agent-hangar-does-not-exist');
  });

  it('アカウント ID は環境変数で渡し、計測は切る', async () => {
    const r = recorder();
    await new WranglerRunner({ cloudDir: '/tmp/x', accountId: ACCOUNT, exec: r.exec }).run(['whoami']);
    expect(r.calls[0]!.o.env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
    expect(r.calls[0]!.o.env.WRANGLER_SEND_METRICS).toBe('false');
  });

  it('アカウント ID が無いうちは手元の環境をそのまま渡す', async () => {
    const r = recorder();
    await new WranglerRunner({ cloudDir: '/tmp/x', accountId: null, exec: r.exec }).run(['whoami']);
    // 立てていないので、利用者の環境にあればそれが、無ければ無いままになる。
    expect(r.calls[0]!.o.env.CLOUDFLARE_ACCOUNT_ID).toBe(process.env.CLOUDFLARE_ACCOUNT_ID);
  });

  it('Claude Code の中から呼んでも、wrangler にエージェントと見なさせない', async () => {
    const r = recorder();
    const keep = { ...process.env };
    try {
      process.env.CLAUDECODE = '1';
      process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
      process.env.CLAUDE_CODE_SESSION_ID = 'abc';
      process.env.HANGAR_TEST_KEEP = 'yes';
      await new WranglerRunner({ cloudDir: '/tmp/x', accountId: null, exec: r.exec }).run(['deploy']);
      await new WranglerRunner({ cloudDir: '/tmp/x', accountId: null, interactive: async (_a, o) => { r.calls.push({ cmd: 'i', args: [], o }); return 0; } }).runInteractive(['login']);
    } finally {
      process.env = keep;
    }
    for (const c of r.calls) {
      // wrangler 4.135 の deploy は、エージェントと判定すると workers.dev のサブドメインを package.json の名前で黙って登録しに行く。
      expect(c.o.env.CLAUDECODE).toBeUndefined();
      expect(Object.keys(c.o.env).filter((k) => k.startsWith('CLAUDE_CODE_'))).toEqual([]);
      expect(c.o.env.HANGAR_TEST_KEEP).toBe('yes');
      expect(c.o.env.PATH).toBe(process.env.PATH);
    }
  });

  it('外す変数は wrangler の判定に使う印で、手元の環境は書き換えない', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SSE_PORT: '1', CODEX_THREAD_ID: 't', OPENCODE: '1', CLAUDE_CONFIG_DIR: '/c', CLOUDFLARE_ACCOUNT_ID: 'u' };
    const env = wranglerEnv(base, null);
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(env.CODEX_THREAD_ID).toBeUndefined();
    expect(env.OPENCODE).toBeUndefined();
    // 印でないものは残す。CLAUDE_CONFIG_DIR は wrangler の判定に使われない。
    expect(env.CLAUDE_CONFIG_DIR).toBe('/c');
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBe('u');
    expect(env.WRANGLER_SEND_METRICS).toBe('false');
    expect(base.CLAUDECODE).toBe('1');
    expect(wranglerEnv(base, A_ID).CLOUDFLARE_ACCOUNT_ID).toBe(A_ID);
    expect(AGENT_MARKER_ENV).toContain('CLAUDECODE');
  });

  it('packages/cloud から wrangler の実行ファイルを見つける', () => {
    // wrangler の exports は bin を公開していないので、素朴な resolve では見つからない。
    const cloudDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cloud');
    const bin = new WranglerRunner({ cloudDir, accountId: null }).bin();
    expect(fs.existsSync(bin)).toBe(true);
    expect(bin.endsWith(path.join('wrangler', 'bin', 'wrangler.js'))).toBe(true);
  });

  it('withAccount は元を変えずに写しを返す', async () => {
    const r = recorder();
    const base = new WranglerRunner({ cloudDir: '/tmp/x', accountId: null, exec: r.exec });
    const withAcc = base.withAccount(ACCOUNT);
    await base.run(['whoami']);
    await withAcc.run(['whoami']);
    expect(r.calls[0]!.o.env.CLOUDFLARE_ACCOUNT_ID).toBe(process.env.CLOUDFLARE_ACCOUNT_ID);
    expect(r.calls[1]!.o.env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
  });
});
