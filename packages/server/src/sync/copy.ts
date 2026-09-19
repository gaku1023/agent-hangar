import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backupsRoot } from '../config/cloud.ts';
import type { Db } from '../db/open.ts';
import { mangleCwd } from '../provider/claude-code/discover.ts';
import { remoteTranscriptPath } from './puller.ts';

export type CopyResult =
  | { kind: 'copied'; target: string; from: string; bytes: number; backedUp: string | null }
  | { kind: 'kept'; target: string }
  | { kind: 'ask'; localSize: number; remoteSize: number }
  | { kind: 'none' };

/** 手元に降ろした写しの選び方。Task 14 の RemotePuller.latestRemoteMain をそのまま渡せる形にしてある。 */
export type RemotePick = { deviceId: string; path: string; size: number; mtime: number };

export type CopyOptions = {
  db: Db;
  home: string;
  claudeDir: string;
  sessionId: string;
  overwrite: boolean;
  now?: () => number;
  /** 写しの選び方を差し替える口。既定は puller と同じ規則で file_sync を引く。 */
  pickRemote?: (sessionUuid: string) => RemotePick | null;
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** Claude Code の本文の名前として安全な UUID だけを通す。共有テーブルの値は他端末が書いたものなので、そのままパスに混ぜない。 */
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

const HASH_BUF = 1 << 20;

/** 競合ファイルの名前に入れる端末名の長さの上限。 */
const MAX_DEVICE_LABEL = 32;

/** バックアップと競合ファイルの名前に使う時刻。 */
export function timestampLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 端末の名前を、競合ファイルの名前に埋め込める形に畳む。
 *
 * 参加の入口は名前に空白と `.` を通すので（ホスト名が「さとうの Mac」のような形を取りうる）、
 * ここで英数字とハイフンとアンダースコアだけに落とす。
 * それ以外（空白、`.`、記号、制御文字、非 ASCII）は続く分をまとめて 1 文字のハイフンにする。
 *
 * 日本語だけの名前は畳むと何も残らないので、そのときは名前の SHA-256 の頭 8 桁を付けた
 * `device-<8 桁>` に倒す。既定の名前を 1 つに決めてしまうと、日本語名の端末が 2 台あったときに
 * 競合ファイルの名前が同じになって見分けが付かなくなる。指紋にしておけば端末ごとに別の名前になる。
 */
export function safeDeviceLabel(name: string): string {
  const trimmed = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const label = trimmed.slice(0, MAX_DEVICE_LABEL).replace(/-+$/g, '');
  if (label !== '') return label;
  return `device-${crypto.createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 8)}`;
}

/**
 * ファイルの SHA-256 を同期で取る。
 * 本文は数十 MB になりうるので、1MB ずつ読んで溜め込まない。
 */
function sha256File(file: string): string {
  const h = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(HASH_BUF);
  const fd = fs.openSync(file, 'r');
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * 選んだ写しが台帳の指紋と一致するか確かめる。
 * ここで通したものだけが ~/.claude の本物を置き換えるので、
 * 降ろした後に壊れた（あるいは差し替えられた）写しを上書きに使わない。
 * file_sync の sha256 と size は平文の jsonl のものである（uploader が上げる前に取り、puller が復号して展開した後に突き合わせる）。
 */
function verifiedAgainstLedger(db: Db, pick: RemotePick, sessionUuid: string): boolean {
  const row = db.prepare('select sha256, size from file_sync where key = ?')
    .get(`transcripts/${pick.deviceId}/${sessionUuid}.jsonl.gz`) as { sha256: string; size: number } | undefined;
  if (!row) return false;
  let stat: fs.Stats;
  try { stat = fs.statSync(pick.path); } catch { return false; }
  if (stat.size !== row.size) return false;
  try { return sha256File(pick.path) === row.sha256; } catch { return false; }
}

/**
 * 台帳と食い違う写しを飛ばしながら、使える写しを 1 つ選ぶ。
 * 置き場の組み立ては puller の remoteTranscriptPath に任せる。規則を 2 か所に持つと、片方だけ変わったときに黙って外れる。
 */
function chooseRemote(o: CopyOptions, sessionUuid: string): RemotePick | null {
  if (o.pickRemote) {
    const pick = o.pickRemote(sessionUuid);
    return pick && verifiedAgainstLedger(o.db, pick, sessionUuid) ? pick : null;
  }
  const rows = o.db.prepare("select path, device_id, size, mtime from file_sync where kind = 'transcript' and key like ? order by mtime desc")
    .all(`transcripts/%/${sessionUuid}.jsonl.gz`) as { path: string; device_id: string; size: number; mtime: number }[];
  for (const r of rows) {
    let p: string;
    try { p = remoteTranscriptPath(o.home, r.device_id, r.path); } catch { continue; }
    if (!fs.existsSync(p)) continue;
    const pick: RemotePick = { deviceId: r.device_id, path: p, size: fs.statSync(p).size, mtime: r.mtime };
    if (verifiedAgainstLedger(o.db, pick, sessionUuid)) return pick;
  }
  return null;
}

/**
 * コピー先の入れ物に一時ファイルを作ってから rename で被せる。
 * 直に書くと、途中で落ちたときに切れた jsonl が本物として残り、Claude Code がそれを読む。
 * これは ~/.claude の本文を置き換えるためのもので、先にあるファイルを意図して潰す。
 * 潰してはいけない控えの側は backupBeforeOverwrite を使う。
 */
function copyOverAtomically(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.hangar-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.copyFileSync(from, tmp, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, to);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 片付けられなくても本物は無事である */ }
    throw e;
  }
}

/** 同じ秒に取る控えの上限。ここまで当たるのは異常なので、無限に回さずに投げる。 */
const MAX_BACKUP_TRIES = 100;

/**
 * 上書きの前に控えを取り、置けた場所を返す。
 *
 * 名前は `<uuid>-<yyyyMMdd-HHmmss>.jsonl` で、時刻は秒までしか持たない。
 * 同じ秒に 2 度上書きすると名前が当たるので、`-2`、`-3` と連番を足す。
 * 控えは「上書きする前の姿を残す」ためのものなので、控えが控えを潰すとその回の直前の姿が失われる。
 * 空いている名前は `wx`（無ければ作る、あれば失敗）で押さえる。
 * `existsSync` で見てから書くと、その隙に割り込まれて同じことが起きる。
 *
 * 控えも一時ファイルと rename で置く。途中までの控えは履歴として当てにならない。
 * 置けなければ投げる。呼び手は ~/.claude を触らずに戻る。
 * この形は claudeConfig.ts の `backupBeforeWrite` と apply.ts の `writeMemoConflictCopy` と揃えてある。
 */
function backupBeforeOverwrite(target: string, home: string, sessionUuid: string, now: number): string {
  const dir = path.join(backupsRoot(home), 'transcripts');
  fs.mkdirSync(dir, { recursive: true });
  const base = `${sessionUuid}-${timestampLabel(now)}`;
  for (let i = 1; i <= MAX_BACKUP_TRIES; i++) {
    const dest = path.join(dir, i === 1 ? `${base}.jsonl` : `${base}-${i}.jsonl`);
    const tmp = `${dest}.hangar-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
      fs.copyFileSync(target, tmp, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 残っても控えの置き場の中である */ }
      throw e;
    }
    try {
      // 空いている名前を wx で押さえてから被せる。rename だけだと先にある控えを潰す。
      fs.closeSync(fs.openSync(dest, 'wx', 0o600));
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 同上 */ }
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    try {
      const fd = fs.openSync(tmp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, dest);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 同上 */ }
      throw e;
    }
    return dest;
  }
  throw new Error('控えを置く名前が空いていません');
}

/**
 * 他端末の本文を ~/.claude にコピーして claude -r で再開できるようにする。
 * ~/.claude への書き込みはここと Claude Code 設定の取り込みだけで、どちらも利用者の明示の操作から呼ぶ。
 * 上書きするのは手元の方が小さいときだけで、しかも控えを取れたときだけである。
 */
export function copyTranscriptForResume(o: CopyOptions): CopyResult {
  const s = o.db.prepare('select provider_session_id, cwd from sessions where id = ? and deleted_at is null')
    .get(o.sessionId) as { provider_session_id: string; cwd: string } | undefined;
  if (!s) return { kind: 'none' };
  if (!UUID_RE.test(s.provider_session_id)) throw new Error('セッションの識別子がファイル名として不正です');
  const target = path.join(o.claudeDir, 'projects', mangleCwd(s.cwd), `${s.provider_session_id}.jsonl`);
  const best = chooseRemote(o, s.provider_session_id);
  if (!best) return fs.existsSync(target) ? { kind: 'kept', target } : { kind: 'none' };
  const local = fs.existsSync(target) ? fs.statSync(target) : null;
  // 手元の方が大きいか同じなら、頼まれていても上書きしない。減らす向きの書き込みは作らない。
  if (local && local.size >= best.size) return { kind: 'kept', target };
  if (local && !o.overwrite) return { kind: 'ask', localSize: local.size, remoteSize: best.size };

  let backedUp: string | null = null;
  if (local) {
    try {
      backedUp = backupBeforeOverwrite(target, o.home, s.provider_session_id, o.now ? o.now() : Date.now());
    } catch (e) {
      // 控えが取れないなら書かない。何を消したか後から追えない上書きは作らない。
      throw new Error(`控えを取れなかったので本文を置き換えませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  copyOverAtomically(best.path, target);
  return { kind: 'copied', target, from: best.path, bytes: best.size, backedUp };
}
