import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Exec, parseAccountId, parseDatabaseId, parseWorkerUrl, WranglerRunner } from './wrangler.ts';

describe('wrangler の出力の解釈', () => {
  it('whoami からアカウント ID', () => {
    const out = `Getting User settings...\n👋 You are logged in with an OAuth Token, associated with the email x@example.com.\n┌──────────────────┬──────────────────────────────────┐\n│ Account Name     │ Account ID                       │\n├──────────────────┼──────────────────────────────────┤\n│ X's Account      │ 0123456789abcdef0123456789abcdef │\n└──────────────────┴──────────────────────────────────┘`;
    expect(parseAccountId(out)).toBe('0123456789abcdef0123456789abcdef');
    expect(parseAccountId('You are not authenticated')).toBeNull();
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
    expect(parseWorkerUrl('Uploaded hangar (2.1 sec)\nDeployed hangar triggers (1.0 sec)\n  https://hangar.gaku.workers.dev\nCurrent Version ID: x')).toBe('https://hangar.gaku.workers.dev');
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

describe('WranglerRunner', () => {
  const ACCOUNT = '0123456789abcdef0123456789abcdef';

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
