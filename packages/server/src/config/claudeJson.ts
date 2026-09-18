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

/** ロックが取れないときの文言。相手はたいてい Claude Code なので、次の一手を書く。 */
const BUSY = 'Claude Code が設定を書いている最中のようです。閉じてからもう一度試してください。';

const LOCK_SUFFIX = '.hangar-lock';
const TMP_SUFFIX = '.hangar-tmp';

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

/**
 * リンクを解いて、実体のパスを返す。
 * 途中のディレクトリも解く。リンク先がまだ無いときも、リンクではなく実体の側を指す。
 * dotfiles のリポジトリへ ~/.claude.json をリンクしている人の設定を、実ファイルで置き換えないためである。
 */
export function resolveRealFile(file: string): string {
  const parent = fs.realpathSync(path.dirname(file));
  let p = path.join(parent, path.basename(file));
  for (let i = 0; i < 16; i++) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return p; // まだ無い。その場所に作る。
    }
    if (!st.isSymbolicLink()) return p;
    p = path.resolve(path.dirname(p), fs.readlinkSync(p));
    try {
      p = path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
  throw new Error(`${file} のシンボリックリンクが深すぎます。`);
}

/** 同期で少し待つ。ロックが空くのを待つだけなので、数十ミリ秒で足りる。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * O_EXCL でロックファイルを作る。取れなければ待ち直し、上限を超えたら書かずに投げる。
 * 落ちたプロセスが残したロックで永久に失敗しないよう、古いものだけは消して取り直す。
 */
function acquireLock(realFile: string, waitMs: number, staleMs: number): () => void {
  const lock = `${realFile}${LOCK_SUFFIX}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try {
        fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          fs.unlinkSync(lock);
        } catch {
          // 既に消えていてもよい。
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let removedStale = false;
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
        fs.unlinkSync(lock);
        removedStale = true;
      }
    } catch {
      // 見に行った時点で消えていた、または消せなかった。どちらも取り直しで扱う。
    }
    if (removedStale) continue;
    if (Date.now() >= deadline) throw new Error(BUSY);
    sleepSync(20);
  }
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

/** 実体と同じディレクトリに書いてから rename する。途中で落ちても元のファイルが壊れない。 */
function writeJsonObject(realFile: string, value: JsonObject): { tightened: boolean } {
  const cur = fs.existsSync(realFile) ? fs.statSync(realFile).mode & 0o777 : null;
  // 新しく作るときは 0600。既にあるときは利用者が決めた権限をそのまま使う。
  // ただしここにはトークンを書くので、他人にも読める権限のままでは書かない。
  const tightened = cur !== null && (cur & 0o077) !== 0;
  const mode = cur === null || tightened ? 0o600 : cur;
  const tmp = `${realFile}${TMP_SUFFIX}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, realFile);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 一時ファイルが作られる前に落ちた。
    }
    throw e;
  }
  return { tightened };
}

/** mcpServers.<name> だけを差し替える。他の項目には触らない。 */
export function upsertUserMcpServer(file: string, name: string, server: unknown, o: UpsertOptions): UpsertResult {
  const realFile = resolveRealFile(file);
  const release = acquireLock(realFile, o.lockWaitMs ?? 2000, o.staleLockMs ?? 10_000);
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
