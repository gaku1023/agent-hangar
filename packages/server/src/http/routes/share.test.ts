import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharePreviewDto } from '@agent-hangar/shared';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 設定の「Claude Code の指示 / MCP を渡す」の一覧（routes/share.ts）の試験。home は試験の世界の ws にそろえる。

const SECRET = 'sk-share-secret-1234567890';

let t: TestWorld;
const app = () => createApp({ ...t.deps, shareHome: t.ws });
const get = (q: string) => app().request(`/api/share/preview${q}`, { headers: H });
const write = (file: string, text: string): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

beforeEach(async () => {
  // CI（GitHub の Linux）は XDG_CONFIG_HOME を持つ。opencode の設定を試験の世界の ~/.config から読ませるため外す。
  vi.stubEnv('XDG_CONFIG_HOME', '');
  t = await testDeps();
  write(path.join(t.claudeDir, 'CLAUDE.md'), '# 私の指示\n');
  write(path.join(t.ws, '.claude.json'), JSON.stringify({
    mcpServers: {
      files: { command: 'npx', args: ['-y', 'files-mcp'], env: { API_TOKEN: SECRET } },
      remote: { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: `Bearer ${SECRET}` } },
      legacy: { type: 'sse', url: 'https://example.invalid/sse' },
      hangar: { command: 'hangar', args: ['mcp'] },
      needs: { command: 'run', env: { K: '${SHARE_TEST_UNSET_VAR}' } },
      dup: { command: 'dup' },
    },
    // フォルダごとの登録は、作業フォルダが決まらないので出さない。
    projects: { [t.ws]: { mcpServers: { local1: { command: 'x' } } } },
  }));
  write(path.join(t.ws, '.codex', 'config.toml'), '[mcp_servers.dup]\ncommand = "other"\n');
  write(path.join(t.ws, '.config', 'opencode', 'opencode.json'), JSON.stringify({ mcp: { servers: { dup: { type: 'local', command: ['other'] } } } }));
});
afterEach(() => { t.dispose(); vi.unstubAllEnvs(); });

const byName = (d: SharePreviewDto, name: string) => d.mcp.find((m) => m.name === name);

describe('GET /api/share/preview', () => {
  it('Codex：利用者の CLAUDE.md と MCP を、渡す・渡さない（理由つき）で返す', async () => {
    const r = await get('?agent=codex');
    expect(r.status).toBe(200);
    const d = (await r.json()) as SharePreviewDto;
    expect(d.files).toEqual([{ path: path.join(t.claudeDir, 'CLAUDE.md'), scope: 'user', status: 'inline' }]);
    expect(byName(d, 'files')).toEqual({ name: 'files', source: 'user', transport: 'stdio' });
    expect(byName(d, 'remote')).toEqual({ name: 'remote', source: 'user', transport: 'http' });
    expect(byName(d, 'legacy')?.skipped).toBe('sse');
    expect(byName(d, 'hangar')?.skipped).toBe('reserved');
    expect(byName(d, 'dup')?.skipped).toBe('conflict');
    expect(byName(d, 'needs')).toMatchObject({ skipped: 'missingEnv', envName: 'SHARE_TEST_UNSET_VAR' });
    expect(byName(d, 'local1')).toBeUndefined();
  });

  it('opencode：sse は渡す。名前のぶつかりは opencode の登録を使う', async () => {
    const d = (await (await get('?agent=opencode')).json()) as SharePreviewDto;
    expect(d.files).toEqual([{ path: path.join(t.claudeDir, 'CLAUDE.md'), scope: 'user', status: 'inline' }]);
    expect(byName(d, 'legacy')).toEqual({ name: 'legacy', source: 'user', transport: 'sse' });
    expect(byName(d, 'dup')?.skipped).toBe('conflict');
    expect(byName(d, 'hangar')?.skipped).toBe('reserved');
  });

  it('秘密（env と headers の値）を応答に載せない', async () => {
    for (const agent of ['codex', 'opencode']) expect(await (await get(`?agent=${agent}`)).text()).not.toContain(SECRET);
  });

  it('CLAUDE.md も登録も無ければ空を返す', async () => {
    fs.rmSync(path.join(t.claudeDir, 'CLAUDE.md'));
    fs.rmSync(path.join(t.ws, '.claude.json'));
    expect(await (await get('?agent=codex')).json()).toEqual({ files: [], mcp: [] });
  });

  it('agent が codex でも opencode でもなければ 400', async () => {
    expect((await get('?agent=claude')).status).toBe(400);
    expect((await get('')).status).toBe(400);
  });

  it('認証が要る', async () => {
    expect((await app().request('/api/share/preview?agent=codex')).status).toBe(401);
  });
});
