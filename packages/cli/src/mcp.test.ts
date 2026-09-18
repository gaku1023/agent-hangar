import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCli, mcpAddArgs, mcpRemoveArgs, probeHangar, runMcpInstall, runMcpUninstall, type CliExec } from './mcp.ts';

describe('mcpAddArgs', () => {
  it('名前と URL を先に、--header を最後に置く', () => {
    const a = mcpAddArgs({ port: 4177, token: 'tok' });
    expect(a).toEqual(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'hangar', 'http://127.0.0.1:4177/mcp', '--header', 'Authorization: Bearer tok']);
    expect(a.indexOf('--header')).toBe(a.length - 2);
    expect(mcpRemoveArgs()).toEqual(['mcp', 'remove', '--scope', 'user', 'hangar']);
  });
});

describe('runMcpInstall', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcp-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  /** 登録したことにする exec。呼ばれた引数を記録する。 */
  const okExec = (calls: string[][]): CliExec => (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: 'Added', stderr: '' }; };

  it('claude mcp add を呼び、成功と失敗を報告する。メッセージにトークンを出さない', async () => {
    const calls: string[][] = [];
    const ok = await runMcpInstall({ home, port: 4177, exec: okExec(calls), probe: async () => true });
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    expect(calls[0]![0]).toBe('claude');
    expect(calls[0]!.at(-1)).toBe(`Authorization: Bearer ${token}`);
    expect(ok.ok).toBe(true);
    expect(ok.message).not.toContain(token);
    const ng = await runMcpInstall({ home, port: 4177, exec: () => ({ status: 1, stdout: '', stderr: 'usage: claude mcp add' }), probe: async () => true });
    expect(ng).toEqual({ ok: false, message: 'claude mcp add に失敗しました: usage: claude mcp add' });
    expect((await runMcpUninstall({ exec: () => ({ status: 0, stdout: '', stderr: '' }) })).ok).toBe(true);
  });

  it('claude が見つからないときは、入れ方と PATH を案内する', async () => {
    // spawnSync の `spawnSync claude ENOENT` をそのまま出しても、次に何をすればよいか分からない。
    const missing: CliExec = () => ({ status: 1, stdout: '', stderr: 'spawnSync claude ENOENT', notFound: true });
    const r = await runMcpInstall({ home, port: 4177, exec: missing, probe: async () => true });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Claude Code が見つかりません');
    expect(r.message).toContain('PATH');
    expect(r.message).not.toContain('ENOENT');
    const u = await runMcpUninstall({ exec: missing });
    expect(u.ok).toBe(false);
    expect(u.message).toContain('Claude Code が見つかりません');
  });

  it('登録するポートで hangar が応答しなければ、登録は済ませたうえで起動を促す', async () => {
    // 既定の 4177 ではないポートを常用する人は、ずれても気付く手掛かりが無い。
    const ports: number[] = [];
    const calls: string[][] = [];
    const r = await runMcpInstall({ home, port: 4200, exec: okExec(calls), probe: async (p) => { ports.push(p); return false; } });
    expect(ports).toEqual([4200]);
    expect(calls[0]).toContain('http://127.0.0.1:4200/mcp');
    // 登録自体は続ける。起動の前に登録しておく使い方を塞がないため。
    expect(r.ok).toBe(true);
    expect(r.message).toContain('4200');
    expect(r.message).toContain('hangar start --port 4200');
  });

  it('応答するときは起動の案内を出さない', async () => {
    const r = await runMcpInstall({ home, port: 4200, exec: okExec([]), probe: async () => true });
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain('hangar start');
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

describe('probeHangar', () => {
  it('/health が応えれば真、誰も居なければ偽', async () => {
    const server = createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404).end('{}'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await probeHangar(port)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
    // 同じポートはもう誰も listen していない。
    expect(await probeHangar(port, 500)).toBe(false);
  });
});
