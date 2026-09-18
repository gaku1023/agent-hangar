import { spawnSync } from 'node:child_process';
import { ensureHome, readOrCreateToken } from '@agent-hangar/server';

export type CliExec = (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string };

const defaultExec: CliExec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : '') };
};

/** `--header` は可変長オプションなので、名前と URL の位置引数を先に置く（フェーズ 0 で確認）。 */
export function mcpAddArgs(o: { port: number; token: string }): string[] {
  return ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'hangar', `http://127.0.0.1:${o.port}/mcp`, '--header', `Authorization: Bearer ${o.token}`];
}

export function mcpRemoveArgs(): string[] {
  return ['mcp', 'remove', '--scope', 'user', 'hangar'];
}

/** ~/.claude.json は hangar が直接書かず、claude mcp add に任せる。 */
export function runMcpInstall(o: { home: string; port: number; exec?: CliExec }): { ok: boolean; message: string } {
  ensureHome(o.home);
  const token = readOrCreateToken(o.home);
  const r = (o.exec ?? defaultExec)('claude', mcpAddArgs({ port: o.port, token }));
  if (r.status === 0) return { ok: true, message: 'user スコープに MCP サーバ hangar を登録しました。claude mcp list で Connected を確認できます。' };
  return { ok: false, message: `claude mcp add に失敗しました: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`}` };
}

export function runMcpUninstall(o: { exec?: CliExec } = {}): { ok: boolean; message: string } {
  const r = (o.exec ?? defaultExec)('claude', mcpRemoveArgs());
  if (r.status === 0) return { ok: true, message: 'user スコープの MCP サーバ hangar を削除しました。' };
  return { ok: false, message: `claude mcp remove に失敗しました: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`}` };
}
