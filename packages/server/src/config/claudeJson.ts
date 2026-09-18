import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Claude Code の user スコープの設定（~/.claude.json）に、MCP サーバの登録だけを書く。
 *
 * `claude mcp add --header "Authorization: Bearer <64 桁>"` は値を argv で受け取るので、
 * 登録している間だけとはいえ、同じ利用者の権限で動く任意のプロセスが ps からトークンを読める。
 * `claude mcp add` にはトークンをファイルや標準入力から受ける口が無く、
 * `${VAR}` を書いても展開されずにそのまま保存されることを実物で確かめた。
 * そこで、claude が書くのと同じ形を自分で書く。トークンはどのプロセスの argv にも載らない。
 */

/** user スコープの設定ファイル。CLAUDE_CONFIG_DIR があればその下に置かれることを実物で確かめた。 */
export function claudeJsonPath(homeDir: string = os.homedir()): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(homeDir, '.claude.json');
}

type JsonObject = Record<string, unknown>;

/** 読めたオブジェクトを返す。ファイルが無ければ空。壊れていれば投げる（上書きしない）。 */
function readJsonObject(file: string): JsonObject {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 中身は他人の秘密を含みうるので、message には出さない。
    throw new Error(`${file} を読めませんでした。JSON として壊れています。`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} の中身がオブジェクトではありません。`);
  return parsed as JsonObject;
}

/** 同じディレクトリに書いてから rename する。途中で落ちても元のファイルが壊れない。 */
function writeJsonObject(file: string, value: JsonObject): void {
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.hangar-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** mcpServers.<name> だけを差し替える。他の項目には触らない。 */
export function upsertUserMcpServer(file: string, name: string, server: unknown): void {
  const cur = readJsonObject(file);
  const servers = cur.mcpServers && typeof cur.mcpServers === 'object' && !Array.isArray(cur.mcpServers) ? (cur.mcpServers as JsonObject) : {};
  writeJsonObject(file, { ...cur, mcpServers: { ...servers, [name]: server } });
}
