import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ensureHome, readOrCreateToken, upsertUserMcpServer } from '@agent-hangar/server';
import { probeAuthorized, type AuthProbe } from './probe.ts';

/** notFound は、コマンド自体を起こせなかったこと。終了コードでは区別できない。 */
export type CliResult = { status: number; stdout: string; stderr: string; notFound?: boolean };
export type CliExec = (cmd: string, args: string[]) => CliResult;
/** 書いたトークンが、そのポートのサーバに通るかを確かめる関数。テストは偽物を渡せる。 */
export type PortProbe = AuthProbe;

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
 *
 * 書いた後の確かめは、書いたトークンそのもので認証の要る経路を 1 回叩く。
 * `/health` は認証を通さないので、通っても「そのポートで何かが応答する」ことしか分からず、
 * `HANGAR_HOME` がサーバとずれていれば、別のトークンを書いたまま成功と言ってしまう。
 *
 * 書き換えは利用者の設定に手を入れる操作なので、控えを ~/.agent-hangar/backups に取ってから行う。
 * 控えが取れないときと、別のプロセスが書いている最中のときは、何も書かずに失敗として返す。
 */
export async function runMcpInstall(o: { home: string; port: number; claudeJson: string; exec?: CliExec; probe?: PortProbe; lockWaitMs?: number }): Promise<{ ok: boolean; message: string }> {
  ensureHome(o.home);
  const token = readOrCreateToken(o.home);
  if ((o.exec ?? execCli)('claude', ['--version']).notFound) return { ok: false, message: CLAUDE_MISSING };
  const lines: string[] = [];
  try {
    const server = { type: 'http', url: `http://127.0.0.1:${o.port}/mcp`, headers: { Authorization: `Bearer ${token}` } };
    const r = upsertUserMcpServer(o.claudeJson, 'hangar', server, { backupDir: path.join(o.home, 'backups'), lockWaitMs: o.lockWaitMs });
    if (r.backup) lines.push(`書き換える前の控え: ${r.backup}`);
    if (r.tightened) lines.push(`${r.file} は他人にも読める権限だったので、トークンを書く前に 0600 へ狭めました。`);
  } catch (e) {
    return { ok: false, message: `${o.claudeJson} の書き換えに失敗しました: ${e instanceof Error ? e.message : String(e)}` };
  }
  const done = `user スコープに MCP サーバ hangar をポート ${o.port} で登録しました。`;
  const tail = lines.length ? `\n${lines.join('\n')}` : '';
  const probed = await (o.probe ?? probeAuthorized)(o.port, token);
  // 書いたトークンで実際に通ったときだけ「確認できます」と言う。
  if (probed.ok) return { ok: true, message: `${done}書いたトークンで ${o.port} の認証を通せました。claude mcp list で Connected を確認できます。${tail}` };
  // ポートがずれていても気付く手掛かりが無いので、ここで言う。
  if (probed.reason === 'down') {
    return { ok: true, message: `${done}\nただし、そのポートで hangar が応答しません。\`hangar start --port ${o.port}\` で起動してから、claude mcp list で Connected を確認してください。${tail}` };
  }
  if (probed.reason === 'unauthorized') {
    // 登録の取り消しはしない。どちらのトークンが正しいかは、こちらには決められない。
    return {
      ok: false,
      message: [
        done,
        `ただし、書いたトークンでは ${o.port} の認証を通せませんでした（${probed.status}）。`,
        `書いたのは ${path.join(o.home, 'token')} のトークンです。ポート ${o.port} のサーバは別のデータディレクトリで動いています。`,
        `HANGAR_HOME がサーバと同じところを指しているか確かめてから、もう一度 hangar mcp install を実行してください。`,
      ].join('\n') + tail,
    };
  }
  return { ok: false, message: `${done}\nただし、確かめの問い合わせに ${probed.status} が返りました。ポート ${o.port} で動いているのが hangar か確かめてください。${tail}` };
}

export async function runMcpUninstall(o: { exec?: CliExec } = {}): Promise<{ ok: boolean; message: string }> {
  const r = (o.exec ?? execCli)('claude', mcpRemoveArgs());
  if (r.notFound) return { ok: false, message: CLAUDE_MISSING };
  if (r.status !== 0) return { ok: false, message: failure('claude mcp remove', r) };
  return { ok: true, message: 'user スコープの MCP サーバ hangar を削除しました。' };
}
