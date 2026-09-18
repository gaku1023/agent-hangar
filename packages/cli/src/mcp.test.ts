import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCli, mcpRemoveArgs, runMcpInstall, runMcpUninstall, type CliExec } from './mcp.ts';

describe('mcpRemoveArgs', () => {
  it('user スコープの hangar を外す', () => {
    expect(mcpRemoveArgs()).toEqual(['mcp', 'remove', '--scope', 'user', 'hangar']);
  });
});

describe('runMcpInstall', () => {
  let home: string;
  let claudeJson: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcp-'));
    claudeJson = path.join(home, 'claude.json');
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  /** claude は居ることにする。呼ばれた引数を記録する。 */
  const okExec = (calls: string[][]): CliExec => (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '2.1.0', stderr: '' }; };
  const readServers = () => (JSON.parse(fs.readFileSync(claudeJson, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers;

  it('user スコープの設定を自分で書き、トークンを argv にも応答にも出さない', async () => {
    const calls: string[][] = [];
    const ok = await runMcpInstall({ home, port: 4177, claudeJson, exec: okExec(calls), probe: async () => ({ ok: true } as const) });
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    expect(ok.ok).toBe(true);
    expect(readServers().hangar).toEqual({ type: 'http', url: 'http://127.0.0.1:4177/mcp', headers: { Authorization: `Bearer ${token}` } });
    // claude mcp add は値を argv で受け取るので、どの呼び出しにもトークンを渡さない。
    expect(calls.flat().join(' ')).not.toContain(token);
    expect(calls.flat().join(' ')).not.toContain('Bearer');
    expect(ok.message).not.toContain(token);
    // 設定ファイルは他人に読ませない。
    expect(fs.statSync(claudeJson).mode & 0o077).toBe(0);
  });

  it('既にある設定の他の項目を消さず、hangar だけを差し替える', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ userID: 'u1', mcpServers: { other: { type: 'stdio', command: 'x' }, hangar: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }), { mode: 0o600 });
    await runMcpInstall({ home, port: 4200, claudeJson, exec: okExec([]), probe: async () => ({ ok: true } as const) });
    const j = JSON.parse(fs.readFileSync(claudeJson, 'utf8')) as { userID: string; mcpServers: Record<string, { url?: string }> };
    expect(j.userID).toBe('u1');
    expect(j.mcpServers.other).toEqual({ type: 'stdio', command: 'x' });
    expect(j.mcpServers.hangar!.url).toBe('http://127.0.0.1:4200/mcp');
  });

  it('壊れた設定ファイルは上書きせず、失敗として返す', async () => {
    fs.writeFileSync(claudeJson, '{ これは JSON ではない', { mode: 0o600 });
    const r = await runMcpInstall({ home, port: 4177, claudeJson, exec: okExec([]), probe: async () => ({ ok: true } as const) });
    expect(r.ok).toBe(false);
    expect(r.message).toContain(claudeJson);
    expect(fs.readFileSync(claudeJson, 'utf8')).toBe('{ これは JSON ではない');
  });

  it('claude が見つからないときは、入れ方と PATH を案内し、設定も書かない', async () => {
    // spawnSync の `spawnSync claude ENOENT` をそのまま出しても、次に何をすればよいか分からない。
    const missing: CliExec = () => ({ status: 1, stdout: '', stderr: 'spawnSync claude ENOENT', notFound: true });
    const r = await runMcpInstall({ home, port: 4177, claudeJson, exec: missing, probe: async () => ({ ok: true } as const) });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Claude Code が見つかりません');
    expect(r.message).toContain('PATH');
    expect(r.message).not.toContain('ENOENT');
    expect(fs.existsSync(claudeJson)).toBe(false);
    const u = await runMcpUninstall({ exec: missing });
    expect(u.ok).toBe(false);
    expect(u.message).toContain('Claude Code が見つかりません');
  });

  it('claude mcp remove の失敗はそのまま返す', async () => {
    const ng = await runMcpUninstall({ exec: () => ({ status: 1, stdout: '', stderr: 'usage: claude mcp remove' }) });
    expect(ng).toEqual({ ok: false, message: 'claude mcp remove に失敗しました: usage: claude mcp remove' });
    expect((await runMcpUninstall({ exec: () => ({ status: 0, stdout: '', stderr: '' }) })).ok).toBe(true);
  });

  it('登録するポートで hangar が応答しなければ、登録は済ませたうえで起動を促す', async () => {
    // 既定の 4177 ではないポートを常用する人は、ずれても気付く手掛かりが無い。
    const ports: number[] = [];
    const r = await runMcpInstall({ home, port: 4200, claudeJson, exec: okExec([]), probe: async (p) => { ports.push(p); return { ok: false, reason: 'down' }; } });
    expect(ports).toEqual([4200]);
    expect((readServers().hangar as { url: string }).url).toBe('http://127.0.0.1:4200/mcp');
    // 登録自体は続ける。起動の前に登録しておく使い方を塞がないため。
    expect(r.ok).toBe(true);
    expect(r.message).toContain('4200');
    expect(r.message).toContain('hangar start --port 4200');
  });

  it('書き換える前に控えを取り、その場所を告げる', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ userID: 'u1' }), { mode: 0o600 });
    const log = await runMcpInstall({ home, port: 4177, claudeJson, exec: okExec([]), probe: async () => ({ ok: true } as const) });
    const backups = path.join(home, 'backups');
    const files = fs.readdirSync(backups);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^claude\.json-\d{14}$/);
    expect(JSON.parse(fs.readFileSync(path.join(backups, files[0]!), 'utf8'))).toEqual({ userID: 'u1' });
    expect(log.message).toContain(path.join(backups, files[0]!));
  });

  it('別のプロセスが書いている最中なら、登録せずに閉じるよう促す', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ userID: 'u1' }), { mode: 0o600 });
    const lock = `${fs.realpathSync(claudeJson)}.hangar-lock`;
    fs.writeFileSync(lock, '99999 held');
    try {
      const r = await runMcpInstall({ home, port: 4177, claudeJson, exec: okExec([]), probe: async () => ({ ok: true } as const), lockWaitMs: 50 });
      expect(r.ok).toBe(false);
      expect(r.message).toContain('Claude Code が設定を書いている最中のようです');
      expect(JSON.parse(fs.readFileSync(claudeJson, 'utf8'))).toEqual({ userID: 'u1' });
    } finally {
      fs.unlinkSync(lock);
    }
  });

  it('他人にも読める設定ファイルは、トークンを書く前に 0600 へ狭めて告げる', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ userID: 'u1' }), { mode: 0o600 });
    fs.chmodSync(claudeJson, 0o644);
    const r = await runMcpInstall({ home, port: 4177, claudeJson, exec: okExec([]), probe: async () => ({ ok: true } as const) });
    expect(fs.statSync(claudeJson).mode & 0o777).toBe(0o600);
    expect(r.message).toContain('0600');
  });

  it('応答するときは起動の案内を出さない', async () => {
    const r = await runMcpInstall({ home, port: 4200, claudeJson, exec: okExec([]), probe: async () => ({ ok: true } as const) });
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain('hangar start');
  });

  it('書いたトークンそのもので、認証の要る経路を確かめる', async () => {
    // /health だけでは「そのポートで何かが応答する」ことしか分からない。
    const seen: { port: number; token: string }[] = [];
    await runMcpInstall({ home, port: 4200, claudeJson, exec: okExec([]), probe: async (port, token) => { seen.push({ port, token }); return { ok: true }; } });
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    expect(seen).toEqual([{ port: 4200, token }]);
    expect((readServers().hangar as { headers: { Authorization: string } }).headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('トークンが食い違うときは失敗として返し、どこがずれているかを言う', async () => {
    // HANGAR_HOME がサーバとずれていると、別のトークンを書いたまま成功と言ってしまっていた。
    const r = await runMcpInstall({ home, port: 4200, claudeJson, exec: okExec([]), probe: async () => ({ ok: false, reason: 'unauthorized', status: 401 }) });
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('トークン');
    expect(r.message).toContain('HANGAR_HOME');
    expect(r.message).toContain(home);
    // 失敗の文にトークンは出さない。
    expect(r.message).not.toContain(token);
  });

  it('認証でも起動でもない失敗は、応答の番号を添えて失敗として返す', async () => {
    const r = await runMcpInstall({ home, port: 4200, claudeJson, exec: okExec([]), probe: async () => ({ ok: false, reason: 'error', status: 500 }) });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('500');
  });
});

describe('execCli', () => {
  it('無いコマンドは notFound、あるコマンドの失敗は終了コードで返す', () => {
    // 実物の claude は呼ばない。ENOENT の見分け方だけを確かめる。
    expect(execCli('hangar-no-such-command-xyz', [])).toMatchObject({ notFound: true });
    expect(execCli('sh', ['-c', 'echo out; echo err >&2; exit 3'])).toMatchObject({ status: 3, notFound: false });
    expect(execCli('sh', ['-c', 'echo out']).stdout.trim()).toBe('out');
  });
});
