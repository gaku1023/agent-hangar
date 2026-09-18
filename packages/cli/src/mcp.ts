import { spawnSync } from 'node:child_process';
import { ensureHome, readOrCreateToken, upsertUserMcpServer } from '@agent-hangar/server';

/** notFound は、コマンド自体を起こせなかったこと。終了コードでは区別できない。 */
export type CliResult = { status: number; stdout: string; stderr: string; notFound?: boolean };
export type CliExec = (cmd: string, args: string[]) => CliResult;
/** 登録するポートで hangar が応答するかを確かめる関数。テストは偽物を渡せる。 */
export type PortProbe = (port: number) => Promise<boolean>;

/** claude が PATH に無いときの案内。spawnSync の ENOENT をそのまま出しても次の一手が分からない。 */
const CLAUDE_MISSING = 'Claude Code が見つかりません。claude コマンドをインストールするか、PATH を通してから実行してください。';

/** 外部コマンドを同期で呼ぶ。起こせなかったときは notFound を立てる。 */
export const execCli: CliExec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  const notFound = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : ''), notFound };
};

export function mcpRemoveArgs(): string[] {
  return ['mcp', 'remove', '--scope', 'user', 'hangar'];
}

/** そのポートで hangar が動いているか。/health は認証を通さないので、トークン無しで確かめられる。 */
export async function probeHangar(port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/** 外部コマンドの失敗を 1 つの文にする。 */
function failure(what: string, r: CliResult): string {
  return `${what} に失敗しました: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`}`;
}

/**
 * user スコープの登録は claude mcp add に任せず、~/.claude.json の mcpServers.hangar を自分で書く。
 * claude mcp add はヘッダの値を argv で受け取るので、64 桁のトークンが ps から読めてしまう。
 * claude が入っているかどうかだけは先に確かめる。入っていない端末に登録しても意味が無いためである。
 * 登録したポートで hangar が応答しないときは、登録自体は済ませたうえで起動を促す。
 * ここで止めると、まだ起動していない端末で先に登録しておく使い方ができなくなる。
 */
export async function runMcpInstall(o: { home: string; port: number; claudeJson: string; exec?: CliExec; probe?: PortProbe }): Promise<{ ok: boolean; message: string }> {
  ensureHome(o.home);
  const token = readOrCreateToken(o.home);
  if ((o.exec ?? execCli)('claude', ['--version']).notFound) return { ok: false, message: CLAUDE_MISSING };
  try {
    upsertUserMcpServer(o.claudeJson, 'hangar', { type: 'http', url: `http://127.0.0.1:${o.port}/mcp`, headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    return { ok: false, message: `${o.claudeJson} の書き換えに失敗しました: ${e instanceof Error ? e.message : String(e)}` };
  }
  const done = `user スコープに MCP サーバ hangar をポート ${o.port} で登録しました。`;
  if (await (o.probe ?? probeHangar)(o.port)) return { ok: true, message: `${done}claude mcp list で Connected を確認できます。` };
  // ポートがずれていても気付く手掛かりが無いので、ここで言う。
  return { ok: true, message: `${done}\nただし、そのポートで hangar が応答しません。\`hangar start --port ${o.port}\` で起動してから、claude mcp list で Connected を確認してください。` };
}

export async function runMcpUninstall(o: { exec?: CliExec } = {}): Promise<{ ok: boolean; message: string }> {
  const r = (o.exec ?? execCli)('claude', mcpRemoveArgs());
  if (r.notFound) return { ok: false, message: CLAUDE_MISSING };
  if (r.status !== 0) return { ok: false, message: failure('claude mcp remove', r) };
  return { ok: true, message: 'user スコープの MCP サーバ hangar を削除しました。' };
}
