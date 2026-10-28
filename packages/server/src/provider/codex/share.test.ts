import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LaunchSpec } from '../../agent/types.ts';
import { codexShareFor } from './share.ts';

// 共有の読み取り（Claude の置き場、Codex の config.toml）から codexShareLaunch への橋渡し（provider/codex/share.ts）の試験。

describe('codexShareFor', () => {
  let root: string;
  let home: string;
  let cwd: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxshare-')));
    home = path.join(root, 'home');
    cwd = path.join(home, 'ws', 'repo');
    fs.mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const spec = (env: Record<string, string> = {}): LaunchSpec => ({ cwd, hangarSessionId: 's1', instructions: [], mcp: { url: 'http://x', secret: 's' }, env });

  it('両方切なら何も作らない（null）', () => {
    expect(codexShareFor(spec(), { share: () => ({ instructions: false, mcp: false }), homeDir: home, env: {} })).toBeNull();
  });

  it('既定の置き場（~/.claude、~/.codex）から指示と MCP を読む。Codex に同じ名前があれば渡さない。fallback は利用者の値の後ろに足す', () => {
    put(path.join(home, '.claude', 'CLAUDE.md'), 'USER BODY');
    put(path.join(cwd, 'CLAUDE.local.md'), 'LOCAL BODY');
    put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { mine: { command: 'a', env: { T: 'sec' } }, dup: { command: 'b' } } }));
    put(path.join(home, '.codex', 'config.toml'), 'project_doc_fallback_filenames = ["X.md"]\n[mcp_servers.dup]\ncommand = "z"\n');
    const r = codexShareFor(spec(), { share: () => ({ instructions: true, mcp: true }), homeDir: home, env: {} })!;
    expect(r.instructions?.text).toContain('USER BODY');
    expect(r.instructions?.text).toContain('LOCAL BODY');
    expect(r.config).toContain('project_doc_fallback_filenames=["X.md","CLAUDE.md"]');
    expect(r.config.some((c) => c.startsWith('mcp_servers.mine.command='))).toBe(true);
    expect(r.config.some((c) => c.startsWith('mcp_servers.dup'))).toBe(false);
    expect(r.report.mcp.find((m) => m.name === 'dup')?.skipped).toBe('conflict');
    expect(r.env).toEqual({ T: 'sec' });
  });

  it('アカウントの置き場（CLAUDE_CONFIG_DIR、CODEX_HOME）に従う', () => {
    const cdir = path.join(root, 'acct-claude');
    const xdir = path.join(root, 'acct-codex');
    put(path.join(cdir, 'CLAUDE.md'), 'ACCOUNT BODY');
    put(path.join(home, '.claude', 'CLAUDE.md'), 'PRIMARY BODY');
    put(path.join(cdir, '.claude.json'), JSON.stringify({ mcpServers: { acct: { command: 'a' } } }));
    put(path.join(xdir, 'config.toml'), '[mcp_servers.acct]\ncommand = "z"\n');
    const r = codexShareFor(spec({ CLAUDE_CONFIG_DIR: cdir, CODEX_HOME: xdir }), { share: () => ({ instructions: true, mcp: true }), homeDir: home, env: {} })!;
    expect(r.instructions?.text).toContain('ACCOUNT BODY');
    expect(r.instructions?.text).not.toContain('PRIMARY BODY');
    expect(r.report.mcp.find((m) => m.name === 'acct')?.skipped).toBe('conflict');
  });

  it('MCP だけ入のときは指示を渡さない（fallback も段も無い）。指示だけ入のときは MCP を渡さない', () => {
    put(path.join(home, '.claude', 'CLAUDE.md'), 'USER BODY');
    put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { mine: { command: 'a' } } }));
    const m = codexShareFor(spec(), { share: () => ({ instructions: false, mcp: true }), homeDir: home, env: {} })!;
    expect(m.instructions).toBeNull();
    expect(m.config.every((c) => c.startsWith('mcp_servers.'))).toBe(true);
    const i = codexShareFor(spec(), { share: () => ({ instructions: true, mcp: false }), homeDir: home, env: {} })!;
    expect(i.config.every((c) => c.startsWith('project_doc_fallback_filenames='))).toBe(true);
    expect(i.report.mcp).toEqual([]);
  });

  it('config.toml が壊れていても投げない', () => {
    put(path.join(home, '.codex', 'config.toml'), '[[[ broken');
    expect(() => codexShareFor(spec(), { share: () => ({ instructions: true, mcp: true }), homeDir: home, env: {} })).not.toThrow();
  });
});
