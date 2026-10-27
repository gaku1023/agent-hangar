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
  /**
   * ロックを取って読んだ中身を渡す。投げたら書かず、控えも取らない。
   * 承認の窓で見せた中身から変わっていないかを、書く直前に確かめるために使う（CLI の --expect）。
   */
  check?: (cur: JsonObject) => void;
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
function takeBackup(realFile: string, backupDir: string, now: Date, prefix = 'claude.json'): string | null {
  if (!fs.existsSync(realFile)) return null;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const base = path.join(backupDir, `${prefix}-${stamp(now)}`);
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
    o.check?.(readJsonObject(realFile));
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

/** mcpServers を読む。無いファイルと、鍵の無いときは null。壊れた JSON は投げる（読むだけで書かない）。 */
export function readUserMcpServers(file: string): JsonObject | null {
  const cur = readJsonObject(resolveRealFile(file));
  const s = cur.mcpServers;
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as JsonObject) : null;
}

/**
 * mcpServers.<name> だけを消す。登録と同じ 4 つの守り（ロック、リンクの実体、権限、控え）で書く。
 * 載っていなければ、書かずに控えも取らない。
 * 以前は claude mcp remove に任せていたが、承認の窓で見せた差分と書く中身を同じにするため、自分で書く。
 * 最後の 1 つを消しても、mcpServers の鍵は空の {} のまま残す。
 * Claude Code の claude mcp remove -s user も空の {} を残し、空の mcpServers を読んでも困らない（2.1.296 で確かめた）。
 * 登録の前に鍵が無かったのか、Claude Code や利用者が空で置いていたのかは見分けられないので、自分の足した hangar の項目だけを消す。
 */
export function removeUserMcpServer(file: string, name: string, o: UpsertOptions): { file: string; changed: boolean; backup: string | null } {
  const realFile = resolveRealFile(file);
  if (!fs.existsSync(realFile)) return { file: realFile, changed: false, backup: null };
  const release = acquireFileLock(realFile, o.lockWaitMs ?? 2000, o.staleLockMs ?? 10_000);
  try {
    const first = readJsonObject(realFile);
    o.check?.(first);
    const has = (cur: JsonObject) => !!cur.mcpServers && typeof cur.mcpServers === 'object' && !Array.isArray(cur.mcpServers) && Object.hasOwn(cur.mcpServers as JsonObject, name);
    if (!has(first)) return { file: realFile, changed: false, backup: null };
    const backup = takeBackup(realFile, o.backupDir, o.now ?? new Date());
    o.onBeforeWrite?.();
    const cur = readJsonObject(realFile);
    if (!has(cur)) return { file: realFile, changed: false, backup };
    const { [name]: _gone, ...rest } = cur.mcpServers as JsonObject;
    writeJsonObject(realFile, { ...cur, mcpServers: rest });
    return { file: realFile, changed: true, backup };
  } finally {
    release();
  }
}

/**
 * その置き場で動く claude が読む user スコープの設定ファイル。
 * configDir は起動に付ける CLAUDE_CONFIG_DIR で、付けない（最初のアカウント）なら null。
 * claudeJsonPath と違い、このプロセスの環境ではなく、起こす claude の環境で決める。
 */
export function claudeJsonFor(configDir: string | null, homeDir: string): string {
  return path.join(configDir ?? homeDir, '.claude.json');
}

/** 信頼の鍵の区切り。Claude Code は Windows でも / で書き、/ で引く（2.1.301 の配布物の判定のコードで確かめた）。 */
export function toTrustKey(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? p.replaceAll('\\', '/') : p;
}

/**
 * フォルダの信頼の鍵（projects の鍵）。
 * claude は作業フォルダを getcwd の実体のパスで引くので、リンクは実体まで解く。まだ無いフォルダは resolve の形にする。
 */
export function trustKeyOf(dir: string, platform: NodeJS.Platform = process.platform): string {
  let p: string;
  try {
    p = fs.realpathSync.native(dir);
  } catch {
    p = path.resolve(dir);
  }
  return toTrustKey(p, platform);
}

const projectsOf = (cur: JsonObject): JsonObject => (cur.projects && typeof cur.projects === 'object' && !Array.isArray(cur.projects) ? (cur.projects as JsonObject) : {});
const isTrusted = (projects: JsonObject, key: string): boolean => {
  const p = projects[key];
  return !!p && typeof p === 'object' && (p as JsonObject).hasTrustDialogAccepted === true;
};

/**
 * 置き場のフォルダがまだ無いか。
 * アカウントを登録しただけで、まだその置き場のフォルダが作られていないことがある。
 * resolveRealFile は親を realpath で解くので、そのままでは ENOENT で投げる。ファイルが無いときと同じく、書かずに済ませる。
 */
const parentMissing = (file: string): boolean => !fs.existsSync(path.dirname(file));

/** dirs のうち、まだ自分の鍵で信頼済みになっていないものの鍵。ファイル（か置き場のフォルダ）が無ければ null。読むだけで書かない。 */
export function untrustedFolders(file: string, dirs: string[]): string[] | null {
  if (parentMissing(file)) return null;
  const realFile = resolveRealFile(file);
  if (!fs.existsSync(realFile)) return null;
  const projects = projectsOf(readJsonObject(realFile));
  return [...new Set(dirs.map((d) => trustKeyOf(d)))].filter((k) => !isTrusted(projects, k));
}

export type TrustResult = {
  /** 実際に書いたファイル。リンクだったときは実体の側。 */
  file: string;
  /** 新しく信頼済みにした鍵。 */
  added: string[];
  /** 取った控え。書かなかったときは null。 */
  backup: string | null;
  /** 設定ファイルが無かったので書かなかったか。 */
  missing: boolean;
};

/** 信頼の書き込みの控えの名前の頭。MCP の登録の控え（claude.json-<時刻>）と分け、こちらだけを数を決めて残す。 */
const TRUST_BACKUP_PREFIX = 'claude.json-trust';
/** 信頼の書き込みの控えを、新しいものから何個残すか。 */
export const TRUST_BACKUPS_KEPT = 5;

/** 控えの名前を、取った順に並べられる形にする（時刻、同じ秒の通し番号）。 */
function backupOrder(name: string): [string, number] {
  const m = /^claude\.json-trust-(\d{14})(?:-(\d+))?$/.exec(name);
  return m ? [m[1]!, m[2] ? Number(m[2]) : 1] : ['', 0];
}

/** 信頼の書き込みの控えのうち、新しいものから keep 個を残して消す。ほかの控えには触らない。 */
function pruneTrustBackups(backupDir: string, keep: number): void {
  const mine = fs.readdirSync(backupDir).filter((n) => backupOrder(n)[0] !== '');
  mine.sort((x, y) => {
    const [a, i] = backupOrder(x);
    const [b, j] = backupOrder(y);
    return a === b ? j - i : a < b ? 1 : -1;
  });
  for (const n of mine.slice(keep)) fs.rmSync(path.join(backupDir, n), { force: true });
}

/**
 * Claude Code の「このフォルダを信頼しますか」を、答えたのと同じ形（projects.<path>.hasTrustDialogAccepted = true）で書く。
 * 同じ行のほかの項目（allowedTools など）とほかの鍵には触らない。
 * MCP の登録と同じ 4 つの守り（ロック、リンクの実体、権限、控え）で書く。
 * 全部すでに信頼済みなら、書かず、控えも取らない（起動のたびに呼ばれても控えが溜まらない）。
 * ファイルが無ければ作らない。まだ一度も claude を起こしていない置き場で、Claude Code の初回の流れより先にファイルを置かないためである。置き場のフォルダが無いときも同じ。
 * 控えは claude.json-trust-<時刻> の名前で取り、新しいものから TRUST_BACKUPS_KEPT 個だけ残す（起動のたびに書くことがあるので、溜めない）。
 * 読み直したら書き足すものが無くなっていたときは、書かず、取った控えも消す。
 */
export function trustFolders(file: string, dirs: string[], o: UpsertOptions): TrustResult {
  if (parentMissing(file)) return { file: path.resolve(file), added: [], backup: null, missing: true };
  const realFile = resolveRealFile(file);
  if (!fs.existsSync(realFile)) return { file: realFile, added: [], backup: null, missing: true };
  const keys = [...new Set(dirs.map((d) => trustKeyOf(d)))];
  const release = acquireFileLock(realFile, o.lockWaitMs ?? 2000, o.staleLockMs ?? 10_000);
  try {
    const first = readJsonObject(realFile);
    o.check?.(first);
    if (keys.every((k) => isTrusted(projectsOf(first), k))) return { file: realFile, added: [], backup: null, missing: false };
    const backup = takeBackup(realFile, o.backupDir, o.now ?? new Date(), TRUST_BACKUP_PREFIX);
    o.onBeforeWrite?.();
    // 読んでから書くまでの間に Claude Code が書いたかもしれないので、書く直前にもう一度読む。
    const cur = readJsonObject(realFile);
    const projects = { ...projectsOf(cur) };
    const added: string[] = [];
    for (const k of keys) {
      if (isTrusted(projects, k)) continue;
      const prev = projects[k];
      projects[k] = { ...(prev && typeof prev === 'object' && !Array.isArray(prev) ? (prev as JsonObject) : {}), hasTrustDialogAccepted: true };
      added.push(k);
    }
    if (added.length === 0) {
      // 割り込みで信頼済みになっていた。書かないので、控えも残さない。
      if (backup) fs.rmSync(backup, { force: true });
      return { file: realFile, added, backup: null, missing: false };
    }
    writeJsonObject(realFile, { ...cur, projects });
    if (backup) pruneTrustBackups(o.backupDir, TRUST_BACKUPS_KEPT);
    return { file: realFile, added, backup, missing: false };
  } finally {
    release();
  }
}
