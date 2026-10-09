import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireFileLock, resolveRealFile, writeFileAtomically } from './claudeFileWrite.ts';
import { isLoose, modeOf } from '../../../platform/secure.ts';
import { MessageError, msg } from '../../../i18n/message.ts';

export { resolveRealFile } from './claudeFileWrite.ts';

/**
 * Claude Code の user スコープの設定（~/.claude.json）に、MCP サーバの登録だけを書く。
 *
 * `claude mcp add --header "Authorization: Bearer <64 桁>"` は値を argv で受け取るので、
 * 登録している間だけとはいえ、同じ利用者の権限で動く任意のプロセスが ps からトークンを読める。
 * `claude mcp add` にはトークンをファイルや標準入力から受ける口が無く、
 * `${VAR}` を書いても展開されずにそのまま保存されることを実物で確かめた。
 * そこで、claude が書くのと同じ形を自分で書く。トークンはどのプロセスの argv にも載らない。
 *
 * ここは hangar が利用者の設定を書き換える数少ない場所なので、次の 4 つを守る。
 * 1. ロックを取ってから読み、書く直前にもう一度読む（Claude Code の同時書き込みを潰さない）。
 * 2. シンボリックリンクは実体まで解いてから、その隣の一時ファイルを rename する（リンクを切らない）。
 * 3. 新しく作るときは 0600。既にあるときは利用者が決めた権限を保つ（他人に読める分だけは狭める）。
 * 4. 書く前に控えを取る。取れなければ書かない。
 */

/** user スコープの設定ファイル。CLAUDE_CONFIG_DIR があればその下に置かれることを実物で確かめた。 */
export function claudeJsonPath(homeDir: string = os.homedir()): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(homeDir, '.claude.json');
}

type JsonObject = Record<string, unknown>;

export type UpsertOptions = {
  /** 控えの置き場。~/.agent-hangar/backups を渡す。hangar 自身の置き場なので ~/.claude の外である。 */
  backupDir: string;
  /** 控えの名前に使う時刻。 */
  now?: Date;
  /** ロックが取れるまで待つ上限。既定は 2 秒。 */
  lockWaitMs?: number;
  /** これより古いロックは、落ちたプロセスの残骸とみなして消す。既定は 10 秒。 */
  staleLockMs?: number;
  /** 書く直前に呼ぶ。テストが割り込みの書き込みを差すための穴である。 */
  onBeforeWrite?: () => void;
};

export type UpsertResult = {
  /** 実際に書いたファイル。リンクだったときは実体の側。 */
  file: string;
  /** 取った控え。もとのファイルが無かったときは null。 */
  backup: string | null;
  /** 他人にも読める権限だったので 0600 に狭めたかどうか。 */
  tightened: boolean;
};

/** 読めたオブジェクトを返す。ファイルが無ければ空。壊れていれば投げる（上書きしない）。 */
function readJsonObject(file: string): JsonObject {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 中身は他人の秘密を含みうるので、message には出さない。
    throw new MessageError(msg('config.file.brokenJson', { file }));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MessageError(msg('config.file.notObject', { file }));
  return parsed as JsonObject;
}

const stamp = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

/**
 * 書く前の中身を控えとして残す。もとのファイルが無ければ、失うものが無いので何もしない。
 * 控えにもトークンが入るので 0600 で置く。
 */
function takeBackup(realFile: string, backupDir: string, now: Date): string | null {
  if (!fs.existsSync(realFile)) return null;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const base = path.join(backupDir, `claude.json-${stamp(now)}`);
  let dest = base;
  for (let i = 2; fs.existsSync(dest); i++) dest = `${base}-${i}`;
  fs.copyFileSync(realFile, dest);
  fs.chmodSync(dest, 0o600);
  return dest;
}

/** 権限を決めて、実体の隣の一時ファイルから rename する。 */
function writeJsonObject(realFile: string, value: JsonObject): { tightened: boolean } {
  const exists = fs.existsSync(realFile);
  const cur = exists ? modeOf(realFile) : null;
  // 新しく作るときは 0600。既にあるときは利用者が決めた権限をそのまま使う。
  // ただしここにはトークンを書くので、他人にも読める権限のままでは書かない。
  // Windows ではモードを読めないので、狭めたとは言わない。
  const tightened = exists && isLoose(realFile);
  const mode = cur === null || tightened ? 0o600 : cur;
  writeFileAtomically(realFile, `${JSON.stringify(value, null, 2)}\n`, mode);
  return { tightened };
}

/** mcpServers.<name> だけを差し替える。他の項目には触らない。 */
export function upsertUserMcpServer(file: string, name: string, server: unknown, o: UpsertOptions): UpsertResult {
  const realFile = resolveRealFile(file);
  const release = acquireFileLock(realFile, o.lockWaitMs ?? 2000, o.staleLockMs ?? 10_000);
  try {
    // 壊れた JSON は、控えを取る前に弾く。
    readJsonObject(realFile);
    const backup = takeBackup(realFile, o.backupDir, o.now ?? new Date());
    o.onBeforeWrite?.();
    // 読んでから書くまでの間に Claude Code が書いたかもしれないので、書く直前にもう一度読む。
    const cur = readJsonObject(realFile);
    const servers = cur.mcpServers && typeof cur.mcpServers === 'object' && !Array.isArray(cur.mcpServers) ? (cur.mcpServers as JsonObject) : {};
    const { tightened } = writeJsonObject(realFile, { ...cur, mcpServers: { ...servers, [name]: server } });
    return { file: realFile, backup, tightened };
  } finally {
    release();
  }
}
