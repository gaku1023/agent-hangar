import fs from 'node:fs';
import path from 'node:path';

/**
 * claude に渡す MCP の設定。
 *
 * この JSON には Bearer トークンが入る。
 * `--mcp-config` は JSON の文字列もファイルのパスも受けるが、文字列で渡すと claude の argv に載り、
 * 同じ利用者の権限で動く任意のプロセスが `ps -ww -o command=` で 64 桁をそのまま読める。
 * そこで 0600 のファイルに置き、argv にはパスだけを渡す。
 */

/** 設定ファイルを置くディレクトリの名前。<home> の下に作る。 */
export const MCP_CONFIG_DIR = 'mcp';

export function mcpConfigJson(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { hangar: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } });
}

/** ファイル名に使える形だけを通す。id は UUID のはずだが、外から来た値を素通しにしない。 */
function safeName(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw new Error('この id は設定ファイルの名前に使えません');
  return sessionId;
}

/** セッションごとの設定ファイルの置き場。URL がセッションごとに違うので、名前もセッションで分ける。 */
export function mcpConfigPath(home: string, sessionId: string): string {
  return path.join(home, MCP_CONFIG_DIR, `${safeName(sessionId)}.json`);
}

/** 0600 で書いて、そのパスを返す。既にあるファイルの mode も 0600 に直す。 */
export function writeMcpConfig(home: string, sessionId: string, url: string, token: string): string {
  const file = mcpConfigPath(home, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, mcpConfigJson(url, token), { mode: 0o600 });
  // mode は新しく作るときにしか効かないので、既にある分は chmod で直す。
  fs.chmodSync(file, 0o600);
  return file;
}

/** そのセッションの設定を消す。無くても何も言わない。 */
export function removeMcpConfig(home: string, sessionId: string): void {
  try {
    fs.rmSync(mcpConfigPath(home, sessionId), { force: true });
  } catch {
    // 消せなかった分は次の起動の掃除で当たる。
  }
}

/**
 * 生きている run のもの以外を消す。
 * run の終わりで消し損ねても、次の起動と起動時の回復でここが拾う。
 * 消せた名前を返す。
 */
export function pruneMcpConfigs(home: string, aliveSessionIds: Iterable<string>): string[] {
  const dir = path.join(home, MCP_CONFIG_DIR);
  const alive = new Set(aliveSessionIds);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const m = /^(.+)\.json$/.exec(name);
    if (!m || alive.has(m[1]!)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    } catch {
      // 掃除の失敗で起動を止めない。
    }
  }
  return removed;
}
