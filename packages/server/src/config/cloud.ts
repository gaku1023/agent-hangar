import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureHome } from './paths.ts';

/**
 * ~/.agent-hangar/cloud.json。
 * 参加用の秘密と端末トークンを平文で持つので、入れ物を 0700、ファイルを 0600 で置く。
 * この中身はログにも例外のメッセージにも出さない。
 */
export type CloudConfig = {
  url: string;
  joinSecret: string;
  deviceToken: string;
  workerName: string | null;
  accountId: string | null;
  dbName: string | null;
  bucketName: string | null;
  joinedAt: number;
};

export function cloudConfigPath(home: string): string { return path.join(home, 'cloud.json'); }

/** 他端末から降ろした本文の置き場。 */
export function remoteRoot(home: string): string { return path.join(home, 'remote'); }

/** ~/.claude へ書き戻す前に取る控えの置き場。 */
export function backupsRoot(home: string): string { return path.join(home, 'backups'); }

/**
 * cloud.json の読み取りの結果。
 * 「まだ参加していない」と「壊れている」を見分けるためにある。
 * 両方を null で返すと、権限の事故や書きかけの残骸で同期が黙って止まり、
 * さらに未参加として参加し直すと別の joinSecret が入って既存の暗号化ファイルが読めなくなる。
 */
export type CloudConfigRead = { config: CloudConfig | null; state: 'absent' | 'broken' | 'ok' };

/**
 * cloud.json を読み、無いのか壊れているのかまで返す。
 * 壊れているときに返すのは state だけで、読めた断片は 1 文字も持ち出さない。
 * 断片には joinSecret と deviceToken が混じりうるからである。
 */
export function readCloudConfig(home: string): CloudConfigRead {
  let text: string;
  try {
    text = fs.readFileSync(cloudConfigPath(home), 'utf8');
  } catch (e) {
    // 無いのは未参加である。読めないのは権限の事故なので、壊れている側に寄せる。
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { config: null, state: 'absent' };
    return { config: null, state: 'broken' };
  }
  try {
    const v = JSON.parse(text) as Partial<CloudConfig>;
    if (typeof v.url !== 'string' || typeof v.joinSecret !== 'string' || typeof v.deviceToken !== 'string') return { config: null, state: 'broken' };
    return {
      config: {
        url: v.url,
        joinSecret: v.joinSecret,
        deviceToken: v.deviceToken,
        workerName: v.workerName ?? null,
        accountId: v.accountId ?? null,
        dbName: v.dbName ?? null,
        bucketName: v.bucketName ?? null,
        joinedAt: typeof v.joinedAt === 'number' ? v.joinedAt : 0,
      },
      state: 'ok',
    };
  } catch {
    // 例外の中身には壊れたファイルの断片が載りうるので、握って state だけにする。
    return { config: null, state: 'broken' };
  }
}

/**
 * cloud.json を読む。無いときも壊れているときも null を返す。
 * その 2 つを分けたい呼び手は readCloudConfig を使う。
 */
export function loadCloudConfig(home: string): CloudConfig | null {
  return readCloudConfig(home).config;
}

/** 書きかけの一時ファイルの名前の頭。 */
const TMP_PREFIX = 'cloud.json.tmp-';

/** これより古い一時ファイルは、落ちて取り残されたものとみなす。 */
const TMP_STALE_MS = 60_000;

/**
 * 落ちて取り残された一時ファイルを掃く。
 * 中身は古い joinSecret と deviceToken の写しなので、置きっぱなしにしない。
 * setup cloud --rotate-secret で秘密を回した後も、残骸だけが古い秘密を持ち続けることになる。
 * いま別のプロセスが書いている最中のものは消さないよう、古いものだけに絞る。
 */
function sweepStaleTemps(home: string, now: number): void {
  let names: string[];
  try { names = fs.readdirSync(home); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const file = path.join(home, name);
    try {
      if (now - fs.statSync(file).mtimeMs < TMP_STALE_MS) continue;
      fs.rmSync(file, { force: true });
    } catch { /* 掃けなくても本題は続ける */ }
  }
}

/**
 * cloud.json を書く。
 * 同じ入れ物の中に 0600 の一時ファイルを新しく作ってから rename で被せる。
 * 切り詰めて書き直すと、途中で落ちたときに壊れた cloud.json が残る。
 * joinSecret は deriveFileKey の入力なので、それを失うと R2 の本文を誰も復号できなくなる。
 * 一時ファイルを最初から 0600 で作るので、既にある緩い権限のファイルへ平文を晒す一瞬も無くなる。
 * 書く前に、前に落ちて取り残された一時ファイルも掃く。
 */
export function saveCloudConfig(home: string, c: CloudConfig): void {
  ensureHome(home);
  sweepStaleTemps(home, Date.now());
  const file = cloudConfigPath(home);
  const tmp = path.join(home, `${TMP_PREFIX}${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  let fd: number | null = null;
  try {
    // wx は既にある名前では失敗する。symlink を追って別の場所へ書くこともない。
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(c, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 閉じられないなら諦める */ } }
    try { fs.rmSync(tmp, { force: true }); } catch { /* 片付けられなくても元のファイルは無事である */ }
    // fs の例外が持つのはパスだけで、秘密は載らない。
    throw e;
  }
}
