import { createHash, type Hash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { isSafeKeyId, isSafeRelPath, transcriptKey, type FileMetaIn } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { CloudError, type CloudClient } from './client.ts';
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
/**
 * 取り残しの走査が 1 度に積む数。
 * 本文は 1 件が数 MB になるので、初回の一括（フェーズ 0 の実測で gzip 後 750MB 前後）を
 * 一気に積まず、少しずつ流す。上げる仕事は 1 本の鎖に並ぶので、同時に流れるのは常に 1 件である。
 */
const SWEEP_BATCH = 20;
/** 走査で読む行数の余裕。諦めた記録で落ちる分を見越して多めに引き、上限まで詰めてから積む。 */
const SWEEP_SCAN_MULT = 5;
const toPosix = (p: string): string => p.split(path.sep).join('/');
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const agentIdOfKey = (key: string): string | null => /\/subagents\/agent-([0-9a-zA-Z]+)\.jsonl\.gz$/.exec(key)?.[1] ?? null;
/** LIKE のパターンに使う前に、ワイルドカード（% と _）を無害にする。端末 ID には _ が入りうる。 */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const SKIP_PREFIX = 'skipped:';
/**
 * 諦めた項目をもう一度試す間隔。
 * RemotePuller と同じ値にしてある（降ろす側と上げる側で挙動を揃える）。
 */
export const RETRY_SKIPPED_AFTER_MS = 30 * 60_000;

/**
 * 何度やり直しても同じ答えが返る失敗かどうか。
 * 4xx は相手が「この要求は受け取らない」と言っているので、送り直しても結果は変わらない。
 * 408（時間切れ）と 429（多すぎる）は後で通るので除く。
 * 5xx と 0（繋がらなかった）は一時の失敗として待ち行列に残す。
 */
const isPermanentStatus = (status: number): boolean => status >= 400 && status < 500 && status !== 408 && status !== 429;

/**
 * 何度やり直しても上がらない失敗。
 * 鍵に使えない ID と、4xx で断られた本文がそれで、待ち行列に残して繰り返しても結果は変わらない。
 * silent は「同じ相手で既に知らせた」印で、そのときだけ onError を鳴らさない。
 */
class PermanentUploadError extends Error {
  constructor(message: string, readonly silent = false) { super(message); }
}

/**
 * 上げるのを諦めた項目の控え。
 * sync_state の skipped:<R2 の鍵> に JSON で残す。
 * メモリに置くと起こし直した時点で消え、諦めたことを利用者に答えられなくなる。
 * RemotePuller の控えと同じ鍵の並びに置くが、鍵に自端末の ID が入るので互いの行は交わらない
 * （形も違うので、取り違えて読んでも parse ではじかれる）。
 */
type SkipRecord = { sha: string; size: number; status: number; message: string; at: number };

/** 控えを読む。手で書き換えられた行や、降ろす側の形の行は、同期を止めずに黙って捨てる。 */
function parseSkip(raw: string): SkipRecord | null {
  try {
    const v = JSON.parse(raw) as Partial<SkipRecord>;
    if (typeof v.sha !== 'string' || !v.sha) return null;
    if (typeof v.size !== 'number' || !Number.isFinite(v.size)) return null;
    return {
      sha: v.sha,
      size: v.size,
      status: typeof v.status === 'number' ? v.status : 0,
      message: typeof v.message === 'string' ? v.message : '',
      at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0,
    };
  } catch {
    return null;
  }
}

/** 取り残しの走査が引く 1 行。uuid は Claude のセッション ID（R2 の鍵に入る方）である。 */
type SweepRow = { path: string; uuid: string; agentId: string | null; size: number };

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
  /** この処理系で、諦めた項目を試し直した鍵。起こし直すと空に戻る。 */
  private readonly retriedSinceBoot = new Set<string>();
  private sweepStmt: ReturnType<Db['prepare']> | null = null;
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
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.startFlush(); }, this.deps.debounceMs ?? DEBOUNCE_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** 上げる仕事は 1 本の鎖に並べ、同じファイルに対する putFile が重ならないようにする。 */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * いま鎖に並んでいる仕事が終わるまで待つ。
   * タイマー越しに始まった上げ（`noteChanged` の窓）は誰も約束を持たないので、
   * テストと終了処理はここで待ち合わせる。マイクロタスクの回数に頼らない。
   */
  async idle(): Promise<void> {
    for (;;) {
      const c = this.chain;
      await c.then(() => undefined, () => undefined);
      if (this.chain === c) return; // 待っている間に新しい仕事が並んだら、それも待つ。
    }
  }

  /** 誰も戻り値を待たない上げを始める。約束を捨てるので、拾い漏れた失敗で落ちないように畳んでおく。 */
  private startFlush(): void { void this.flushAll().catch(() => {}); }

  /**
   * 取り残しの走査。
   * 手元の台帳（transcript_files）と上げた台帳（file_sync）を突き合わせ、まだ上がっていない本文を積む。
   * 索引は「変化したファイル」しか知らせないので、これが無いと参加より前に索引が済んでいた本文は
   * ファイルが動くまで永久に上がらない（設定の同期の pushChanged と同じ役目である）。
   * 戻り値は新たに積んだ件数である。
   */
  sweep(limit: number = SWEEP_BATCH): number {
    if (this.stopped || limit <= 0) return 0;
    // 止まっているあいだは外と話さない。走査で積んでも上げずに捨てるだけなので、そもそも引かない。
    if (this.deps.isPaused()) return 0;
    if (!isSafeKeyId(this.deps.deviceId)) return 0;
    const rows = this.sweepStatement().all({ head: `transcripts/${this.deps.deviceId}/`, limit: limit * SWEEP_SCAN_MULT }) as SweepRow[];
    let queued = 0;
    for (const r of rows) {
      if (queued >= limit) break;
      if (this.pending.has(r.path)) continue; // 既に並んでいる。
      const key = this.safeKey(r.uuid, r.agentId);
      if (key === null) continue; // 鍵に使えない ID は上げようがない。走査では黙って飛ばす。
      const rec = this.readSkip(key);
      // 諦めた項目を毎回また積まない。窓が開くまでは引かない。
      if (rec && !this.mayRetrySkipped(key, rec, r.size, null)) continue;
      this.noteChanged({ path: r.path, sessionId: r.uuid, agentId: r.agentId });
      queued++;
    }
    // 走査で拾ったものは、もう遅れている。デバウンスの窓を待たずに流す。
    if (queued > 0) this.startFlush();
    return queued;
  }

  /**
   * 取り残しが何件あるかを数える。数えられないときは null を返す。
   *
   * 画面に出す「未送信の本文 N」は、これから上がるものの数である。
   * 走査は 1 回 20 件ずつなので、この数は「追いつくまでに何周かかるか」の目安になる。
   * 端末の ID が鍵に使えない形のときは、そもそも上げようがないので数えない。
   */
  pendingSweep(): number | null {
    if (!isSafeKeyId(this.deps.deviceId)) return null;
    try {
      const row = this.countStatement().get({ head: `transcripts/${this.deps.deviceId}/`, skip: SKIP_PREFIX }) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch {
      // 数えられないことは、同期そのものを止める理由にはならない。
      return null;
    }
  }

  private countStmt: ReturnType<Db['prepare']> | null = null;

  /**
   * 取り残しを数える 1 文。
   * 土台は sweepStatement と同じ突き合わせだが、数えないものが 2 つある。
   *
   * 1 つは消したセッションの本文である。
   * 消したセッションは掘り起こさないと決めたので（論理削除）、その本文は上がる予定に入らない。
   * 2 つめは諦めた本文である。
   * 走査は sync_state の `skipped:` の控えに当たるものを飛ばし続けるので、
   * 数に残しておくと「未送信の本文 N」が N のまま永久に減らない。
   *
   * なお sweepStatement の側はどちらの条件も持たない。
   * 消したセッションの本文はいまも雲へ上がるので、その食い違いは別に閉じる必要がある。
   */
  private countStatement(): ReturnType<Db['prepare']> {
    this.countStmt ??= this.deps.db.prepare(`
      select count(*) as n
      from transcript_files t
      join sessions s on s.id = t.session_id
      left join file_sync fs on fs.key = (case when t.agent_id is null
        then @head || s.provider_session_id || '.jsonl.gz'
        else @head || s.provider_session_id || '/subagents/agent-' || t.agent_id || '.jsonl.gz' end)
      left join sync_state sk on sk.key = @skip || (case when t.agent_id is null
        then @head || s.provider_session_id || '.jsonl.gz'
        else @head || s.provider_session_id || '/subagents/agent-' || t.agent_id || '.jsonl.gz' end)
      where t.device_id is null and s.deleted_at is null and sk.key is null
        and (fs.key is null or fs.size < t.size)`);
    return this.countStmt;
  }

  /**
   * 上がっていない本文を引く 1 文。
   * file_sync に行が無いものと、索引が見た大きさより小さいものしか上げていないものを拾う。
   * 本文は末尾に足されるだけなので、上げた大きさが索引の見た大きさ以上なら取り残しは無い。
   * 突き合わせを大きさで先に絞っておくと、走査のたびに全部の指紋を取り直さずに済む。
   */
  private sweepStatement(): ReturnType<Db['prepare']> {
    this.sweepStmt ??= this.deps.db.prepare(`
      select t.path as path, s.provider_session_id as uuid, t.agent_id as agentId, t.size as size
      from transcript_files t
      join sessions s on s.id = t.session_id
      left join file_sync fs on fs.key = (case when t.agent_id is null
        then @head || s.provider_session_id || '.jsonl.gz'
        else @head || s.provider_session_id || '/subagents/agent-' || t.agent_id || '.jsonl.gz' end)
      where t.device_id is null and (fs.key is null or fs.size < t.size)
      order by t.mtime desc
      limit @limit`);
    return this.sweepStmt;
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

  private readSkip(key: string): SkipRecord | null {
    const raw = this.deps.state.get(`${SKIP_PREFIX}${key}`);
    return raw === null ? null : parseSkip(raw);
  }

  private clearSkip(key: string): void { this.deps.state.set(`${SKIP_PREFIX}${key}`, null); }

  /**
   * 諦めた項目を残し、知らせるかどうかを決める。
   * 同じ中身で同じ相手に断られたときは鳴らさない（30 分ごとに同じ知らせが出ると、本当の失敗が埋もれる）。
   */
  private noteSkip(key: string, rec: SkipRecord, prev: SkipRecord | null): boolean {
    this.deps.state.set(`${SKIP_PREFIX}${key}`, JSON.stringify(rec));
    this.retriedSinceBoot.add(key); // いま試したので、この処理系での「起こし直しの 1 回」は使い切っている。
    return !prev || prev.sha !== rec.sha || prev.status !== rec.status;
  }

  /**
   * 諦めた項目を、もう一度雲に出してよいか。
   * 直りようのない失敗なので、次のどれかに当たるまでは雲に触らない。
   * 1. この処理系で起こしてから一度も試していない（起こし直したら 1 度だけ試す）。
   * 2. 前の失敗から 30 分たった。
   * 3. 中身が入れ替わって前より小さくなった（大きすぎて断られた相手が、通るようになりうる唯一の変化である）。
   */
  private mayRetrySkipped(key: string, rec: SkipRecord, size: number, sha: string | null): boolean {
    // 数えるのは noteSkip の側だけにする。ここで印を付けると、走査の判定が上げる側の 1 回分を食ってしまう。
    if (!this.retriedSinceBoot.has(key)) return true;
    if (this.now() - rec.at >= RETRY_SKIPPED_AFTER_MS) return true;
    return size < rec.size && sha !== rec.sha;
  }

  /**
   * 上げるのを諦めた項目。利用者に見せるために残してある。
   * sync_state から読むので、サーバを起こし直した後も答えられる。
   */
  skippedUploads(): { key: string; status: number; message: string; at: number }[] {
    const rows = this.deps.db.prepare('select key, value from sync_state where key like ? order by key').all(`${SKIP_PREFIX}%`) as { key: string; value: string }[];
    const out: { key: string; status: number; message: string; at: number }[] = [];
    for (const r of rows) {
      const rec = parseSkip(r.value);
      if (rec) out.push({ key: r.key.slice(SKIP_PREFIX.length), status: rec.status, message: rec.message, at: rec.at });
    }
    return out;
  }

  /** 失敗を利用者へ知らせる。同じ相手で既に知らせた諦めだけは、鳴らさずに控えの更新で済ませる。 */
  private report(p: string, e: unknown): void {
    if (e instanceof PermanentUploadError && e.silent) return;
    this.deps.onError?.(p, errorMessage(e));
  }

  private async attempt(f: UploadTarget): Promise<void> {
    try {
      await this.upload(f);
      this.pending.delete(f.path);
    } catch (e) {
      // 送信の失敗は待ち行列に残して次の機会に送り直す。直りようのない失敗だけ下ろす。
      if (e instanceof PermanentUploadError) this.pending.delete(f.path);
      this.report(f.path, e);
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
        this.report(f.path, e);
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
    const skip = this.readSkip(key);
    const prev = this.deps.db.prepare('select sha256 from file_sync where key = ?').get(key) as { sha256: string } | undefined;
    if (prev?.sha256 === sha) { if (skip) this.clearSkip(key); return 'unchanged'; }
    // 直りようのない失敗で諦めた相手には、窓が開くまで雲に触らない。
    // 本文は変化のたびに全体を上げ直すので、送り直すたびに転送量を無料枠から削ることになる。
    if (skip && !this.mayRetrySkipped(key, skip, size, sha)) return 'skipped';

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
      // 4xx（408 と 429 を除く）は何度送っても同じ答えなので、ここで諦めて控えに残す。
      if (e instanceof CloudError && isPermanentStatus(e.status)) {
        const rec: SkipRecord = { sha, size, status: e.status, message: e.message, at: this.now() };
        const ring = this.noteSkip(key, rec, skip);
        throw new PermanentUploadError(`この本文は上げられないので、いったん諦めます（${e.status}）: ${e.message}`, !ring);
      }
      throw e;
    }
    if (skip) this.clearSkip(key);
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
