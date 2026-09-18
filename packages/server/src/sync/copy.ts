import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backupsRoot, remoteRoot } from '../config/cloud.ts';
import type { Db } from '../db/open.ts';
import { mangleCwd } from '../provider/claude-code/discover.ts';

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

/** バックアップと競合ファイルの名前に使う時刻。 */
export function timestampLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
 * 他端末から降ろした写しの置き場。
 * Task 14 の `remoteTranscriptPath` と同じ規則である。
 * puller.ts が入ったら、この関数を消してそちらを import する。
 */
function remoteCopyPath(home: string, deviceId: string, rel: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(deviceId)) throw new Error(`端末 ID が不正です: ${deviceId}`);
  const norm = path.posix.normalize(rel);
  if (!norm.startsWith('projects/') || norm.includes('..') || norm.startsWith('/')) throw new Error(`本文の相対パスが不正です: ${rel}`);
  return path.join(remoteRoot(home), deviceId, ...norm.split('/'));
}

/**
 * 選んだ写しが台帳の指紋と一致するか確かめる。
 * ここで通したものだけが ~/.claude の本物を置き換えるので、
 * 降ろした後に壊れた（あるいは差し替えられた）写しを上書きに使わない。
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

/** 台帳と食い違う写しを飛ばしながら、使える写しを 1 つ選ぶ。 */
function chooseRemote(o: CopyOptions, sessionUuid: string): RemotePick | null {
  if (o.pickRemote) {
    const pick = o.pickRemote(sessionUuid);
    return pick && verifiedAgainstLedger(o.db, pick, sessionUuid) ? pick : null;
  }
  const rows = o.db.prepare("select path, device_id, size, mtime from file_sync where kind = 'transcript' and key like ? order by mtime desc")
    .all(`transcripts/%/${sessionUuid}.jsonl.gz`) as { path: string; device_id: string; size: number; mtime: number }[];
  for (const r of rows) {
    let p: string;
    try { p = remoteCopyPath(o.home, r.device_id, r.path); } catch { continue; }
    if (!fs.existsSync(p)) continue;
    const pick: RemotePick = { deviceId: r.device_id, path: p, size: fs.statSync(p).size, mtime: r.mtime };
    if (verifiedAgainstLedger(o.db, pick, sessionUuid)) return pick;
  }
  return null;
}

/**
 * 同じ入れ物に一時ファイルを作ってから rename で被せる。
 * 直に書くと、途中で落ちたときに切れた jsonl が本物として残り、Claude Code がそれを読む。
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
    const now = o.now ? o.now() : Date.now();
    const dest = path.join(backupsRoot(o.home), 'transcripts', `${s.provider_session_id}-${timestampLabel(now)}.jsonl`);
    try {
      copyOverAtomically(target, dest);
    } catch (e) {
      // 控えが取れないなら書かない。何を消したか後から追えない上書きは作らない。
      throw new Error(`控えを取れなかったので本文を置き換えませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
    backedUp = dest;
  }
  copyOverAtomically(best.path, target);
  return { kind: 'copied', target, from: best.path, bytes: best.size, backedUp };
}
