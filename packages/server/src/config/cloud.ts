import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fromBase64Url, type KeyPairRaw } from '@agent-hangar/shared';
import { ensureHome } from './paths.ts';

/**
 * ~/.agent-hangar/cloud.json（版 2）。
 * この PC の X25519 の鍵ペア、世代鍵、スマホ用の鍵、端末トークンを平文で持つので、入れ物を 0700、ファイルを 0600 で置く。
 * 鍵はどれも base64url の 32 バイトである。
 * 世代鍵を手元に持つので、pull のたびに keybox を読まずに済む。
 * この中身はログにも例外のメッセージにも出さない。
 */
export type CloudConfig = {
  v: 2;
  url: string;
  /** Worker が D1 を作ったときに置いた乱数。作り直した Worker を URL だけでは見分けられないので、これで見分ける。 */
  cloudId: string;
  deviceToken: string;
  keyPair: KeyPairRaw;
  /** 世代の番号の文字列から世代鍵へ。世代 1 から今の世代までを持つ。 */
  epochs: Record<string, string>;
  currentEpoch: number;
  /** スマホ用の鍵 M[m]。スマホをまだ接続していなければ null。 */
  phoneKey: { epoch: number; key: string } | null;
  /** 手元で最後に読んだ名簿の版。 */
  rosterVersion: number;
  workerName: string | null;
  accountId: string | null;
  dbName: string | null;
  bucketName: string | null;
  joinedAt: number;
};

/**
 * 版 1 の cloud.json（参加用の秘密 joinSecret を持つ形）。
 * サーバは同期にもスマホにも使わず、readCloudConfig は legacy と読む。
 * CLI の setup と参加が版 2 を書くようになるまで（Task 13）と、古い Worker を片付ける teardown（Task 26）のために読み書きを残す。
 */
export type LegacyCloudConfig = {
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
 * さらに未参加として参加し直すと別の鍵ペアが入って、既存の世代鍵の keybox が読めなくなる。
 * legacy は版 1（joinSecret を持つ形）で、同期を始めず、作り直しを待つ。
 */
export type CloudConfigRead = { config: CloudConfig | null; state: 'absent' | 'broken' | 'ok' | 'legacy' };

/** 版 1 の読み取りの結果。版 2 のファイルは broken と読む。 */
export type LegacyCloudConfigRead = { config: LegacyCloudConfig | null; state: 'absent' | 'broken' | 'ok' };

/** cloud.json の本文を読む。無ければ absent、読めなければ broken。 */
function readText(home: string): { text: string } | { state: 'absent' | 'broken' } {
  try {
    return { text: fs.readFileSync(cloudConfigPath(home), 'utf8') };
  } catch (e) {
    // 無いのは未参加である。読めないのは権限の事故なので、壊れている側に寄せる。
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'broken' };
  }
}

const isKey = (s: unknown): s is string => typeof s === 'string' && fromBase64Url(s)?.length === 32;
const isEpoch = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;
const strOrNull = (s: unknown): string | null => (typeof s === 'string' ? s : null);

/** 版 2 の形を確かめて組み直す。形が違えば null。 */
function parseV2(v: Record<string, unknown>): CloudConfig | null {
  if (v.v !== 2) return null;
  if (typeof v.url !== 'string' || typeof v.cloudId !== 'string' || typeof v.deviceToken !== 'string') return null;
  const kp = v.keyPair as Partial<KeyPairRaw> | null | undefined;
  if (typeof kp !== 'object' || kp === null || !isKey(kp.pub) || !isKey(kp.priv)) return null;
  const raw = v.epochs;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const epochs: Record<string, string> = {};
  for (const [n, key] of Object.entries(raw)) {
    if (!/^[1-9][0-9]{0,8}$/.test(n) || !isKey(key)) return null;
    epochs[n] = key;
  }
  // 今の世代の鍵が手元に無ければ、書くことも読むこともできない。
  if (!isEpoch(v.currentEpoch) || !(String(v.currentEpoch) in epochs)) return null;
  let phoneKey: CloudConfig['phoneKey'] = null;
  if (v.phoneKey != null) {
    const p = v.phoneKey as { epoch?: unknown; key?: unknown };
    if (typeof p !== 'object' || !isEpoch(p.epoch) || !isKey(p.key)) return null;
    phoneKey = { epoch: p.epoch, key: p.key };
  }
  return {
    v: 2,
    url: v.url,
    cloudId: v.cloudId,
    deviceToken: v.deviceToken,
    keyPair: { pub: kp.pub, priv: kp.priv },
    epochs,
    currentEpoch: v.currentEpoch,
    phoneKey,
    rosterVersion: typeof v.rosterVersion === 'number' && Number.isSafeInteger(v.rosterVersion) ? v.rosterVersion : 0,
    workerName: strOrNull(v.workerName),
    accountId: strOrNull(v.accountId),
    dbName: strOrNull(v.dbName),
    bucketName: strOrNull(v.bucketName),
    joinedAt: typeof v.joinedAt === 'number' ? v.joinedAt : 0,
  };
}

/**
 * cloud.json（版 2）を読み、無いのか壊れているのか古い形なのかまで返す。
 * 壊れているときと古い形のときに返すのは state だけで、読めた断片は 1 文字も持ち出さない。
 * 断片には秘密鍵と世代鍵と deviceToken が混じりうるからである。
 */
export function readCloudConfig(home: string): CloudConfigRead {
  const t = readText(home);
  if (!('text' in t)) return { config: null, state: t.state };
  try {
    const v = JSON.parse(t.text) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { config: null, state: 'broken' };
    const o = v as Record<string, unknown>;
    // joinSecret を持つのは版 1 である。
    if (typeof o.joinSecret === 'string') return { config: null, state: 'legacy' };
    const config = parseV2(o);
    return config ? { config, state: 'ok' } : { config: null, state: 'broken' };
  } catch {
    // 例外の中身には壊れたファイルの断片が載りうるので、握って state だけにする。
    return { config: null, state: 'broken' };
  }
}

/**
 * cloud.json を読む。無いとき、壊れているとき、古い形のときは null を返す。
 * それらを分けたい呼び手は readCloudConfig を使う。
 */
export function loadCloudConfig(home: string): CloudConfig | null {
  return readCloudConfig(home).config;
}

/**
 * 版 1 の cloud.json を読む。
 * 壊れているときに返すのは state だけで、読めた断片は 1 文字も持ち出さない。
 */
export function readLegacyCloudConfig(home: string): LegacyCloudConfigRead {
  const t = readText(home);
  if (!('text' in t)) return { config: null, state: t.state };
  try {
    const v = JSON.parse(t.text) as Partial<LegacyCloudConfig>;
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

/** 版 1 の cloud.json を読む。無いときも壊れているときも null を返す。 */
export function loadLegacyCloudConfig(home: string): LegacyCloudConfig | null {
  return readLegacyCloudConfig(home).config;
}

/** 書きかけの一時ファイルの名前の頭。 */
const TMP_PREFIX = 'cloud.json.tmp-';

/** これより古い一時ファイルは、落ちて取り残されたものとみなす。 */
const TMP_STALE_MS = 60_000;

/**
 * 落ちて取り残された一時ファイルを掃く。
 * 中身は古い鍵と deviceToken の写しなので、置きっぱなしにしない。
 * 鍵を回した後も、残骸だけが古い鍵を持ち続けることになる。
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
 * 秘密鍵と世代鍵を失うと、この PC は keybox も R2 の本文も開けなくなる。
 * 一時ファイルを最初から 0600 で作るので、既にある緩い権限のファイルへ平文を晒す一瞬も無くなる。
 * 書く前に、前に落ちて取り残された一時ファイルも掃く。
 */
export function saveCloudConfig(home: string, c: CloudConfig): void {
  writeCloudJson(home, c);
}

/** 版 1 の cloud.json を書く。書き方は saveCloudConfig と同じ。 */
export function saveLegacyCloudConfig(home: string, c: LegacyCloudConfig): void {
  writeCloudJson(home, c);
}

function writeCloudJson(home: string, c: CloudConfig | LegacyCloudConfig): void {
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

/** cloud.json の権限の確かめの結果。detail は開発者向けの英語の短い説明で、秘密は載らない。 */
export type CloudConfigPerms = { ok: true } | { ok: false; detail: string };

/** 読み取りを許してよい相手。自分のほかは SYSTEM と Administrators だけである。 */
const TRUSTED_NAMES = new Set(['system', 'administrators']);
const TRUSTED_SIDS = new Set(['s-1-5-18', 's-1-5-32-544']);
/** 読み取りを含む権利。F は全部、M は変更、RX は読み取りと実行、R は読み取り、GR と GA は汎用、RD はデータの読み取り、MA は許される最大。 */
const READ_RIGHTS = new Set(['F', 'M', 'RX', 'R', 'GR', 'GA', 'RD', 'MA']);

/**
 * icacls の出力から、自分と SYSTEM と Administrators のほかに読み取りを許された相手の名前を返す。
 * 拒否の項目と、継承の元にだけ効く項目（IO）は数えない。
 * 名前は「ドメイン\名前」の後ろ側で照らす。名前を引けない SID（頭に * が付くこともある）は SID で照らす。
 * 名前が利用者の言語で訳される版の Windows では、SYSTEM と Administrators を他人と読むことがある（警告が出るだけで、漏れを見逃す側には倒れない）。
 */
export function icaclsReaders(output: string, file: string, user: string): string[] {
  const readers: string[] = [];
  const me = user.toLowerCase();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.startsWith(file) ? raw.slice(file.length) : raw;
    const m = /^\s*(.+?):((?:\([^)]*\))+)\s*$/.exec(line);
    if (!m) continue;
    const who = m[1]!.trim();
    const groups = [...m[2]!.matchAll(/\(([^)]*)\)/g)].map((g) => g[1]!);
    if (groups.includes('DENY') || groups.includes('IO')) continue;
    if (!groups.flatMap((g) => g.split(',')).some((r) => READ_RIGHTS.has(r))) continue;
    const name = who.slice(who.lastIndexOf('\\') + 1).toLowerCase();
    const sid = who.replace(/^\*/, '').toLowerCase();
    if (name === me || TRUSTED_NAMES.has(name) || TRUSTED_SIDS.has(sid)) continue;
    readers.push(who);
  }
  return readers;
}

function runIcacls(file: string): string {
  return execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
}

/**
 * cloud.json がほかの利用者に読めないかを確かめる。無ければ漏れるものも無いので ok。
 * mac と Linux は mode の group と other の桁を見る。
 * Windows の mode は ACL を映さないので、icacls の出力を読む。icacls を呼べなければ、確かめられないので ng にする。
 * 読めると分かったら、CLI と設定が警告を出す（直すのは利用者）。
 */
export function checkCloudConfigPerms(
  home: string,
  platform: NodeJS.Platform = process.platform,
  o: { icacls?: (file: string) => string; user?: string } = {},
): CloudConfigPerms {
  const file = cloudConfigPath(home);
  let mode: number;
  try {
    mode = fs.statSync(file).mode;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true };
    return { ok: false, detail: 'cloud.json could not be inspected' };
  }
  if (platform !== 'win32') {
    if ((mode & 0o077) === 0) return { ok: true };
    return { ok: false, detail: `cloud.json has mode ${(mode & 0o777).toString(8)}; other users may read it` };
  }
  let out: string;
  try {
    out = (o.icacls ?? runIcacls)(file);
  } catch {
    return { ok: false, detail: 'icacls could not be run on cloud.json' };
  }
  const readers = icaclsReaders(out, file, o.user ?? os.userInfo().username);
  if (readers.length === 0) return { ok: true };
  return { ok: false, detail: `cloud.json is readable by ${readers.join(', ')}` };
}
