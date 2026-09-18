import { createHash, type Hash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { isSafeRelPath, transcriptKey, type FileMetaIn } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import type { CloudClient } from './client.ts';
import { encryptStream, sha256Stream } from './crypto.ts';
import type { Timers } from './engine.ts';
import type { SyncStateStore } from './state.ts';

export type UploadTarget = { path: string; sessionId: string; agentId: string | null };
export type UploaderDeps = {
  db: Db; deviceId: string; claudeDir: string; client: CloudClient; key: Buffer; state: SyncStateStore;
  now?: () => number; debounceMs?: number; timers?: Timers; isPaused: () => boolean;
  onError?: (path: string, message: string) => void;
};

const REAL_TIMERS: Timers = { setTimeout, clearTimeout, setInterval, clearInterval };
/** 本文の変化のたびにファイル全体を上げ直すので、窓を短くすると転送量が跳ねる。 */
const DEBOUNCE_MS = 30_000;
const toPosix = (p: string): string => p.split(path.sep).join('/');
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const agentIdOfKey = (key: string): string | null => /\/subagents\/agent-([0-9a-zA-Z]+)\.jsonl\.gz$/.exec(key)?.[1] ?? null;
/** LIKE のパターンに使う前に、ワイルドカード（% と _）を無害にする。端末 ID には _ が入りうる。 */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * 何度やり直しても上がらない失敗。
 * 鍵に使えない ID がそれで、待ち行列に残して繰り返しても結果は変わらない。
 * 黙って落とさず onError には必ず流す。
 */
class PermanentUploadError extends Error {}

/** 流れていくバイト列の指紋を取るだけの通り道。中身は持たない。 */
const hashTap = (h: Hash): Transform =>
  new Transform({
    transform(chunk: Buffer, _enc, cb) { h.update(chunk); cb(null, chunk); },
  });

/**
 * 手元の本文を gzip と AES-256-GCM で包んで R2 に上げる。
 * 鍵は端末ごとに分かれているので、他端末の本文を上書きすることはない。
 * ログを一切出さない（本文も鍵も秘密も、例外の文言にも載せない）。
 */
export class TranscriptUploader {
  private readonly pending = new Map<string, UploadTarget>();
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: UploaderDeps) {}

  private get timers(): Timers { return this.deps.timers ?? REAL_TIMERS; }
  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  /** 索引化が変化を見たファイルを待ち行列に入れる。1 件目から 30 秒後にまとめて上げる。 */
  noteChanged(f: UploadTarget): void {
    if (this.stopped) return;
    this.pending.set(f.path, f);
    if (this.timer) return;
    // 窓はずらさない。書き込みが続くセッションでも、30 秒に 1 度は上がる。
    this.timer = this.timers.setTimeout(() => { this.timer = null; void this.flushAll(); }, this.deps.debounceMs ?? DEBOUNCE_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** 上げる仕事は 1 本の鎖に並べ、同じファイルに対する putFile が重ならないようにする。 */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  flushAll(): Promise<void> {
    return this.enqueue(async () => { for (const f of [...this.pending.values()]) await this.attempt(f); });
  }

  /** run の終了と「この PC で再開」から呼ぶ。待ち行列と、既に上げたことのある鍵の両方を見る。 */
  flushSession(sessionUuid: string): Promise<void> {
    return this.enqueue(async () => {
      const targets = new Map<string, UploadTarget>();
      for (const f of this.pending.values()) if (f.sessionId === sessionUuid) targets.set(f.path, f);
      for (const f of this.knownTargets(sessionUuid)) if (!targets.has(f.path)) targets.set(f.path, f);
      for (const f of targets.values()) await this.attempt(f);
    });
  }

  /** file_sync に残っている自端末の鍵から、そのセッションの手元のファイルを引き直す。 */
  private knownTargets(sessionUuid: string): UploadTarget[] {
    if (!this.safeKey(sessionUuid, null)) return [];
    const head = `transcripts/${this.deps.deviceId}/${sessionUuid}`;
    const rows = this.deps.db
      .prepare("select key, path from file_sync where kind = 'transcript' and device_id = ? and (key = ? or key like ? escape '\\')")
      .all(this.deps.deviceId, `${head}.jsonl.gz`, `${escapeLike(head)}/subagents/%`) as { key: string; path: string }[];
    return rows
      .filter((r) => isSafeRelPath(r.path))
      .map((r) => ({ path: path.join(this.deps.claudeDir, r.path), sessionId: sessionUuid, agentId: agentIdOfKey(r.key) }));
  }

  private safeKey(sessionUuid: string, agentId: string | null): string | null {
    try { return transcriptKey(this.deps.deviceId, sessionUuid, agentId); } catch { return null; }
  }

  private async attempt(f: UploadTarget): Promise<void> {
    try {
      await this.upload(f);
      this.pending.delete(f.path);
    } catch (e) {
      // 送信の失敗は待ち行列に残して次の機会に送り直す。直りようのない失敗だけ下ろす。
      if (e instanceof PermanentUploadError) this.pending.delete(f.path);
      this.deps.onError?.(f.path, errorMessage(e));
    }
  }

  async uploadFile(f: UploadTarget): Promise<'uploaded' | 'unchanged' | 'skipped'> {
    return this.enqueue(async () => {
      try {
        const r = await this.upload(f);
        this.pending.delete(f.path);
        return r;
      } catch (e) {
        if (e instanceof PermanentUploadError) this.pending.delete(f.path);
        this.deps.onError?.(f.path, errorMessage(e));
        return 'skipped' as const;
      }
    });
  }

  private async upload(f: UploadTarget): Promise<'uploaded' | 'unchanged' | 'skipped'> {
    if (this.deps.isPaused()) return 'skipped';
    // 「この PC で再開」で譲ったセッションは、相手が持ち主なので上げない。
    if (this.deps.state.isYielded(f.sessionId)) return 'skipped';
    let st: fs.Stats;
    try { st = fs.statSync(f.path); } catch { return 'skipped'; }
    if (!st.isFile()) return 'skipped';
    const rel = toPosix(path.relative(this.deps.claudeDir, f.path));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !isSafeRelPath(rel)) return 'skipped';
    // 鍵の組み立ては shared に任せる。形が通らない ID は上げ損ねとして知らせる（黙って skipped にしない）。
    let key: string;
    try { key = transcriptKey(this.deps.deviceId, f.sessionId, f.agentId); } catch (e) { throw new PermanentUploadError(errorMessage(e)); }

    // 指紋も本文も「stat した時点の長さ」までに限って読む。
    // 実行中のセッションは読んでいる最中に伸びるので、限らないと sha256 と中身が食い違う。
    const size = st.size;
    const source = (): Readable => (size === 0 ? Readable.from([]) : fs.createReadStream(f.path, { start: 0, end: size - 1 }));
    const sha = await sha256Stream(source());
    const prev = this.deps.db.prepare('select sha256 from file_sync where key = ?').get(key) as { sha256: string } | undefined;
    if (prev?.sha256 === sha) return 'unchanged';

    const meta: FileMetaIn = { key, path: rel, kind: 'transcript', sha256: sha, size, mtime: Math.floor(st.mtimeMs), encrypted: true };
    // R2 は部分更新ができないので、変化のたびにファイル全体を gzip して上げ直す。
    const body = new PassThrough();
    const sent = createHash('sha256');
    let pumpError: unknown = null;
    // pipeline で繋ぐ（裸の pipe だと途中の error が誰にも拾われずプロセスごと落ちる）。
    // 先に putFile が倒れたときも body を壊して確実に畳む。
    const pump = pipeline(source(), hashTap(sent), createGzip(), encryptStream(this.deps.key), body)
      .catch((e: unknown) => { pumpError = e; });
    let seq: number;
    try {
      const r = await this.deps.client.putFile(meta, body);
      await pump;
      if (pumpError) throw pumpError;
      seq = r.seq;
    } catch (e) {
      body.destroy();
      await pump;
      throw e;
    }
    // 送ったバイト列そのものの指紋を meta と突き合わせる。
    // 食い違ったら file_sync に書かない。書くと「上げ済み」と見なして二度と直らない。
    if (sent.digest('hex') !== sha) throw new Error('上げている最中に本文が入れ替わりました');

    // file_sync の sha256 は平文の指紋である。降ろす側（puller）は R2 の鍵とこの値を突き合わせて、
    // 丸ごと別の暗号文に差し替えられていないことを確かめる（形式の検査だけでは検出できない）。
    this.deps.db.prepare(`insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)
      on conflict(key) do update set path = excluded.path, sha256 = excluded.sha256, size = excluded.size, mtime = excluded.mtime, remote_seq = excluded.remote_seq, synced_at = excluded.synced_at`)
      .run(key, 'transcript', rel, this.deps.deviceId, sha, size, meta.mtime, seq, this.now());
    return 'uploaded';
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
