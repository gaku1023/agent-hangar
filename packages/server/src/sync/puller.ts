import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { PULL_LIMIT, type FileEntry } from '@agent-hangar/shared';
import { remoteRoot } from '../config/cloud.ts';
import type { Db } from '../db/open.ts';
import type { CloudClient } from './client.ts';
import { decryptStream, sha256Stream } from './crypto.ts';
import type { SyncStateStore } from './state.ts';

export type PullerDeps = {
  db: Db;
  deviceId: string;
  home: string;
  client: CloudClient;
  key: Buffer;
  state: SyncStateStore;
  onConfigEntries?: (entries: FileEntry[]) => Promise<void>;
  onError?: (key: string, message: string) => void;
};

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 同じ項目で続けて失敗してよい回数。これを超えたら飛ばして先に進む。
 * 1 件の直らない失敗（復号できない本文、書けない置き場）で filesSeq を止め続けると、
 * その後ろの本文が一生降りてこない。全部が止まるより、一部が降りてこない方がましである。
 */
const MAX_ATTEMPTS = 3;

/** 置き場は本人だけが読める。中身は他端末の会話の本文である。 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** 設定の取り込みの失敗を数えるときの鍵。本文の鍵（transcripts/... か config/...）と衝突しない名前にする。 */
const CONFIG_BATCH = '(config)';

/** 続けて失敗した回数。指紋が変わったら中身が変わったということなので、数え直して取り直す。 */
type Failure = { fingerprint: string; count: number; message: string };

/**
 * 他端末の本文の置き場。
 * 相対パスは projects/ の下に限り、端末 ID も名前として安全な文字だけを許す。
 * ここを通さずに R2 の申告した文字列で組み立てると、~/.claude のような外の場所へ書けてしまう。
 */
export function remoteTranscriptPath(home: string, deviceId: string, rel: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(deviceId) || deviceId === '.' || deviceId === '..') throw new Error(`端末 ID が不正です: ${deviceId}`);
  const norm = path.posix.normalize(rel);
  if (!norm.startsWith('projects/') || norm.split('/').includes('..') || norm.startsWith('/')) throw new Error(`本文の相対パスが不正です: ${rel}`);
  return path.join(remoteRoot(home), deviceId, ...norm.split('/'));
}

/**
 * R2 の鍵と相対パスが同じファイルを指していることを確かめる。
 * 形式の検査（復号と SHA-256）だけでは、正しく暗号化された別のファイルへ丸ごと差し替えられたときに気付けない。
 * 鍵は transcripts/<端末>/<projects の下の相対パス>.gz という形なので、この対応が崩れていれば受け取らない。
 */
function checkKeyMatchesPath(e: FileEntry): void {
  const parts = path.posix.normalize(e.path).split('/');
  const suffix = parts.slice(2).join('/');
  if (parts[0] !== 'projects' || parts.length < 3 || suffix === '') throw new Error(`本文の相対パスが不正です: ${e.path}`);
  if (e.key !== `transcripts/${e.deviceId}/${suffix}.gz`) throw new Error('本文の鍵と相対パスが食い違っています');
}

/**
 * 他端末が上げた本文を降ろして手元に展開する。
 * 設定ファイル（kind が config）は自分では書かず、呼び出し側（ClaudeConfigSync）に渡す。
 * 書き込む先は ~/.agent-hangar/remote の下だけで、~/.claude には一切触らない。
 */
export class RemotePuller {
  private readonly failures = new Map<string, Failure>();

  constructor(private readonly deps: PullerDeps) {}

  /** 降ろすのを諦めた項目。利用者に見せるために残す（同じ失敗を毎回の pull で鳴らさないため）。 */
  skippedEntries(): { key: string; attempts: number; message: string }[] {
    return [...this.failures.entries()]
      .filter(([, f]) => f.count >= MAX_ATTEMPTS)
      .map(([key, f]) => ({ key, attempts: f.count, message: f.message }));
  }

  /**
   * 1 件の失敗を数える。
   * まだ諦めていなければ true を返す（呼び手は filesSeq をこの項目の手前で止める）。
   * 鳴らすのは 1 回目と諦めたときだけである。間で毎回鳴らすと、2 秒ごとの pull が同じ失敗で埋まる。
   */
  private noteFailure(key: string, fingerprint: string, message: string): boolean {
    const prev = this.failures.get(key);
    const count = prev && prev.fingerprint === fingerprint ? prev.count + 1 : 1;
    this.failures.set(key, { fingerprint, count, message });
    if (count < MAX_ATTEMPTS) {
      if (count === 1) this.deps.onError?.(key, message);
      return true;
    }
    if (count === MAX_ATTEMPTS) this.deps.onError?.(key, `${MAX_ATTEMPTS} 回続けて失敗したので、この項目は飛ばします: ${message}`);
    return false;
  }

  async pullNow(): Promise<{ downloaded: number; configEntries: number }> {
    let since = this.deps.state.getNumber('filesSeq', 0);
    let advanceTo = since;
    let minFailed: number | null = null;
    let downloaded = 0;
    const configs: FileEntry[] = [];
    for (;;) {
      const page = await this.deps.client.listFiles(since, PULL_LIMIT);
      for (const e of page.files) {
        if (e.deviceId === this.deps.deviceId) continue;
        if (e.kind === 'config') { configs.push(e); continue; }
        try {
          if (await this.download(e)) downloaded++;
          this.failures.delete(e.key);
        } catch (err) {
          if (this.noteFailure(e.key, e.sha256, errorMessage(err))) minFailed = minFailed === null ? e.seq : Math.min(minFailed, e.seq);
        }
      }
      advanceTo = page.nextSeq;
      // 進まない応答で回り続けない。
      if (!page.more || page.nextSeq <= since) break;
      since = page.nextSeq;
    }
    if (configs.length > 0 && this.deps.onConfigEntries) {
      try {
        await this.deps.onConfigEntries(configs);
        this.failures.delete(CONFIG_BATCH);
      } catch (err) {
        // 設定の取り込みが落ちた回も、その項目より手前で止めて次の pull で渡し直す。
        // ここも諦める道が要る。取り込めない設定 1 件で本文まで止まる方が困る。
        const seqs = configs.map((c) => c.seq);
        if (this.noteFailure(CONFIG_BATCH, seqs.join(','), errorMessage(err))) {
          const first = Math.min(...seqs);
          minFailed = minFailed === null ? first : Math.min(minFailed, first);
        }
      }
    }
    // 失敗した項目より手前で止めて、次の pull で取り直す。
    this.deps.state.set('filesSeq', minFailed !== null ? minFailed - 1 : advanceTo);
    return { downloaded, configEntries: configs.length };
  }

  /** 1 件を降ろす。既に同じ指紋の実体があれば false を返して何もしない。 */
  private async download(e: FileEntry): Promise<boolean> {
    checkKeyMatchesPath(e);
    const target = remoteTranscriptPath(this.deps.home, e.deviceId, e.path);
    const prev = this.deps.db.prepare('select sha256 from file_sync where key = ?').get(e.key) as { sha256: string } | undefined;
    if (prev?.sha256 === e.sha256 && fs.existsSync(target)) return false;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: DIR_MODE });
    // 直接の宛先には書かない。
    // 切り詰められた入力では error が出る前に 1 チャンク分の平文が流れるので、
    // 途中まで書けたファイルが本物として残ると索引器がそれを読んでしまう。
    // 一時ファイルに書き切り、SHA-256 が合ったものだけを rename で本物にする。
    const tmp = `${target}.part`;
    try {
      // 前の回の残骸があると mode が引き継がれないので、必ず作り直す。
      fs.rmSync(tmp, { force: true });
      const body = await this.deps.client.getFile(e.key);
      const sink = () => fs.createWriteStream(tmp, { mode: FILE_MODE });
      // pipeline でつなぐ。裸の pipe だと復号の error が未処理になってプロセスごと落ちる。
      if (e.encrypted) await pipeline(body, decryptStream(this.deps.key), createGunzip(), sink());
      else await pipeline(body, createGunzip(), sink());
      const sha = await sha256Stream(fs.createReadStream(tmp));
      if (sha !== e.sha256) throw new Error(`本文の SHA-256 が一致しません: ${e.key}`);
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    // 索引化の選別が更新時刻で最新の写しを選ぶので、相手の mtime に合わせる。
    fs.utimesSync(target, new Date(e.mtime), new Date(e.mtime));
    this.deps.db.prepare(`insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)
      on conflict(key) do update set path = excluded.path, device_id = excluded.device_id, sha256 = excluded.sha256, size = excluded.size, mtime = excluded.mtime, remote_seq = excluded.remote_seq, synced_at = excluded.synced_at`)
      .run(e.key, 'transcript', e.path, e.deviceId, e.sha256, e.size, e.mtime, e.seq, Date.now());
    return true;
  }

  /** 手元に降ろした写しのうち、更新時刻が最新のもの。「この PC で再開」が使う。 */
  latestRemoteMain(sessionUuid: string): { deviceId: string; path: string; size: number; mtime: number } | null {
    const rows = this.deps.db
      .prepare("select path, device_id, size, mtime from file_sync where kind = 'transcript' and device_id <> ? and key like ? order by mtime desc")
      .all(this.deps.deviceId, `transcripts/%/${sessionUuid}.jsonl.gz`) as { path: string; device_id: string; size: number; mtime: number }[];
    for (const r of rows) {
      let p: string;
      try { p = remoteTranscriptPath(this.deps.home, r.device_id, r.path); } catch { continue; }
      if (fs.existsSync(p)) return { deviceId: r.device_id, path: p, size: r.size, mtime: r.mtime };
    }
    return null;
  }
}
