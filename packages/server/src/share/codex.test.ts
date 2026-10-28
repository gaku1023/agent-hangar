import { describe, expect, it } from 'vitest';
import { codexShareLaunch } from './codex.ts';
import type { ShareFile, ShareMcp } from './sources.ts';

// Claude Code の指示と MCP を Codex の起動（-c と環境変数と追記の段）へ変える純粋な変換（share/codex.ts）の試験。

const base = { files: [], mcp: [], codexMcpNames: new Set<string>(), userFallback: null, budget: 4000 };
const file = (scope: ShareFile['scope'], p: string, text: string | null, skipped?: 'agentsMd'): ShareFile & { text: string | null } => ({ path: p, scope, text, ...(skipped ? { skipped } : {}) });

describe('指示', () => {
  it('project_doc_fallback_filenames は、利用者の値の後ろに CLAUDE.md を足す。重ねない', () => {
    expect(codexShareLaunch(base).config).toEqual(['project_doc_fallback_filenames=["CLAUDE.md"]']);
    expect(codexShareLaunch({ ...base, userFallback: ['A.md', 'B.md'] }).config).toEqual(['project_doc_fallback_filenames=["A.md","B.md","CLAUDE.md"]']);
    expect(codexShareLaunch({ ...base, userFallback: ['CLAUDE.md', 'A.md'] }).config).toEqual(['project_doc_fallback_filenames=["CLAUDE.md","A.md"]']);
  });
  it('指示を切るときは fallback を足さない', () => {
    expect(codexShareLaunch({ ...base, instructions: false }).config).toEqual([]);
  });
  it('user と local の本文は追記の段に、見出しでどのファイルかを示して入れる。project の本文は入れない', () => {
    const r = codexShareLaunch({ ...base, files: [file('user', '/h/.claude/CLAUDE.md', 'U body'), file('project', '/w/CLAUDE.md', 'P body'), file('project', '/w/a/CLAUDE.md', 'x', 'agentsMd'), file('local', '/w/a/CLAUDE.local.md', 'L body')] });
    expect(r.instructions?.key).toBe('share');
    const t = r.instructions!.text;
    expect(t).toContain('/h/.claude/CLAUDE.md');
    expect(t).toContain('U body');
    expect(t).toContain('/w/a/CLAUDE.local.md');
    expect(t).toContain('L body');
    expect(t).not.toContain('P body');
    expect(t.endsWith('\n')).toBe(true);
    expect(t.indexOf('U body')).toBeLessThan(t.indexOf('L body'));
    expect(r.report.files.map((f) => [f.path, f.status])).toEqual([['/h/.claude/CLAUDE.md', 'inline'], ['/w/CLAUDE.md', 'native'], ['/w/a/CLAUDE.md', 'agentsMd'], ['/w/a/CLAUDE.local.md', 'inline']]);
  });
  it('合わせて budget 字を超えたファイルは、場所を示す 1 行だけにする', () => {
    const r = codexShareLaunch({ ...base, budget: 30, files: [file('user', '/u.md', 'a'.repeat(20)), file('local', '/l.md', 'b'.repeat(20))] });
    const t = r.instructions!.text;
    expect(t).toContain('a'.repeat(20));
    expect(t).not.toContain('b');
    expect(t).toContain('/l.md');
    expect(r.report.files.map((f) => f.status)).toEqual(['inline', 'pointer']);
  });
  it('読めなかったファイルは段に入れず、status: unreadable', () => {
    const r = codexShareLaunch({ ...base, files: [file('user', '/u.md', null)] });
    expect(r.instructions).toBeNull();
    expect(r.report.files[0]?.status).toBe('unreadable');
  });
  it('本文が無ければ段は null', () => {
    expect(codexShareLaunch(base).instructions).toBeNull();
  });
});

const stdio = (name: string, over: Partial<ShareMcp> = {}): ShareMcp => ({ name, source: 'user', transport: 'stdio', command: 'npx', args: ['-y', 'x'], ...over });
const http = (name: string, over: Partial<ShareMcp> = {}): ShareMcp => ({ name, source: 'user', transport: 'http', url: 'https://e.test/mcp', ...over });

describe('MCP', () => {
  it('stdio は command と args と env_vars。値は env に入れ、config に出さない', () => {
    const r = codexShareLaunch({ ...base, instructions: false, mcp: [stdio('a', { env: { TOKEN: 's3cret', K2: 'v2' } })] });
    expect(r.config).toEqual(['mcp_servers."a".command="npx"', 'mcp_servers."a".args=["-y","x"]', 'mcp_servers."a".env_vars=["TOKEN","K2"]']);
    expect(r.env).toEqual({ TOKEN: 's3cret', K2: 'v2' });
    expect(r.config.join('\n')).not.toContain('s3cret');
  });
  it('http は url と env_http_headers。見出しの値は env に入れ、config に出さない', () => {
    const r = codexShareLaunch({ ...base, instructions: false, mcp: [http('my.srv', { headers: { Authorization: 'Bearer zzz', 'X-Id': 'q' } })] });
    expect(r.config[0]).toBe('mcp_servers."my.srv".url="https://e.test/mcp"');
    expect(r.config[1]).toBe('mcp_servers."my.srv".env_http_headers={"Authorization"="HANGAR_MCP_MY_SRV_0","X-Id"="HANGAR_MCP_MY_SRV_1"}');
    expect(r.env).toEqual({ HANGAR_MCP_MY_SRV_0: 'Bearer zzz', HANGAR_MCP_MY_SRV_1: 'q' });
    expect(r.config.join('\n')).not.toContain('zzz');
  });
  it('見出しが無い http は env_http_headers を書かない', () => {
    expect(codexShareLaunch({ ...base, instructions: false, mcp: [http('a')] }).config).toEqual(['mcp_servers."a".url="https://e.test/mcp"']);
  });
  it('名前に引用符や空白があっても鍵が壊れない', () => {
    const r = codexShareLaunch({ ...base, instructions: false, mcp: [stdio('a "b" c')] });
    expect(r.config[0]).toBe('mcp_servers."a \\"b\\" c".command="npx"');
  });
  it('sse は渡さず、理由 sse。Codex に同じ名前があれば渡さず、理由 conflict', () => {
    const r = codexShareLaunch({ ...base, instructions: false, codexMcpNames: new Set(['dup']), mcp: [{ name: 's', source: 'user', transport: 'sse', url: 'https://e.test/sse' }, stdio('dup'), stdio('ok')] });
    expect(r.report.mcp.map((m) => [m.name, m.skipped])).toEqual([['s', 'sse'], ['dup', 'conflict'], ['ok', undefined]]);
    expect(r.config.every((c) => c.startsWith('mcp_servers."ok"'))).toBe(true);
  });
  it('入力で skipped が付いているものは、その理由のまま渡さない', () => {
    const r = codexShareLaunch({ ...base, instructions: false, mcp: [{ name: 'u', source: 'project', transport: 'stdio', skipped: 'unapproved' }] });
    expect(r.config).toEqual([]);
    expect(r.report.mcp).toEqual([{ name: 'u', source: 'project', transport: 'stdio', skipped: 'unapproved' }]);
  });
  it('stdio の env の鍵が他のサーバと同じ名前で違う値なら、後のものを渡さない（invalid）。同じ値なら渡す', () => {
    const r = codexShareLaunch({ ...base, instructions: false, mcp: [stdio('a', { env: { K: '1' } }), stdio('b', { env: { K: '2' } }), stdio('c', { env: { K: '1' } })] });
    expect(r.report.mcp.map((m) => [m.name, m.skipped])).toEqual([['a', undefined], ['b', 'invalid'], ['c', undefined]]);
    expect(r.env).toEqual({ K: '1' });
    expect(r.config.some((c) => c.startsWith('mcp_servers."b"'))).toBe(false);
  });
  it('env の名前の衝突（a-b と a_b）は連番で避ける', () => {
    const r = codexShareLaunch({ ...base, instructions: false, mcp: [http('a-b', { headers: { H: '1' } }), http('a_b', { headers: { H: '2' } })] });
    expect(Object.keys(r.env)).toHaveLength(2);
    expect(Object.values(r.env).sort()).toEqual(['1', '2']);
  });
  it('秘密は config のどこにも出ない', () => {
    const r = codexShareLaunch({ ...base, mcp: [stdio('a', { env: { T: 'SECRET-1' } }), http('b', { headers: { A: 'SECRET-2' } })] });
    expect(r.config.join('\n')).not.toMatch(/SECRET/);
    expect(JSON.stringify(r.report)).not.toMatch(/SECRET/);
  });
});
