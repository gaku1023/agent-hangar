import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PULL_LIMIT, type FileEntry, type SyncDiskShortDto } from '@agent-hangar/shared';
import { remoteRoot } from '../config/cloud.ts';
import type { Db } from '../db/open.ts';
import { defaultLanguage, type GetLanguage } from '../i18n/language.ts';
import { errorText, msg, MessageError } from '../i18n/message.ts';
import { CompatError, LimitError, type CloudClient } from './client.ts';
import { sha256Stream } from './crypto.ts';
import { agentOfSyncPath, AGENT_SYNC } from './agentSync.ts';
import { ledgerKeyOfPath } from './ledgerKey.ts';
import type { SyncStateStore } from './state.ts';

/**
 * 本文の元の PC。上げた PC（deviceId）と違うのは、作り直しで remote/ の写しを上げ直したときである（sync/rebuild.ts）。
 * 写しは元の PC の ID の下（remote/<origin>/）に置き、台帳も元の PC の鍵で引く。上げた PC ごとに分けると、同じ本文が 2 か所に並ぶ。
 */
const originOf = (e: FileEntry): string => (typeof e.origin === 'string' && e.origin !== '' ? e.origin : e.deviceId);

/**
 * 写しの相対パス（projects/<フォルダ>/<uuid>.jsonl か projects/<フォルダ>/<uuid>/subagents/...）から、セッションの ID を取り出す。取れなければ空。
 * opencode の写し（opencode/<会話>.json）は、その会話の ID を返す。
 */
function uuidOfTranscript(rel: string): string {
  const own = agentOfSyncPath(rel);
  if (own !== null) return own.sessionId;
  const parts = path.posix.normalize(rel).split('/');
  return (parts[2] ?? '').replace(/\.jsonl$/, '');
}

export type PullerDeps = {
  db: Db;
  deviceId: string;
  home: string;
  /** 索引を開き、本文を復号して返す client（SealedCloudClient）。 */
  client: CloudClient;
  state: SyncStateStore;
  onError?: (key: string, message: string) => void;
  /** 写しを 1 つ以上置いた回の終わりに、置いた数を知らせる。索引が全件走査を予約する（boot/sync.ts）。 */
  onDownloaded?: (count: number) => void;
  now?: () => number;
  /**
   * いまの言語。諦めた項目の理由（利用者に見せる）を、この言語の文で残す。省くと日本語。
   * 残した理由は書いた時点の言語のままで、言語を変えても書き直さない（次の失敗で新しい言語になる）。
   */
  language?: GetLanguage;
  /**
   * 置き場のあるディスクの空き（free）と全体（total）のバイト数。測れなければ null で、そのときは空きを見ずに降ろす。
   * 省くと statfs で測る（diskSpaceAt）。試験が偽の空きを渡す。
   */
  diskSpace?: () => { free: number; total: number } | null;
  /** 空きが足りずに止めたとき（中身）と、空きが戻って解けたとき（null）に知らせる。画面へ同期の状態を配り直す（boot/sync.ts）。 */
  onDiskShortChanged?: (short: SyncDiskShortDto | null) => void;
};

const GB = 1024 ** 3;

/**
 * 降ろした後に残しておく空き。5 GB か、ディスクの 10% の小さい方である。
 * 小さいディスクで 5 GB を残そうとすると何も降ろせず、大きいディスクで 10% を残そうとすると 100 GB 単位で余らせる。
 */
export function diskReserve(total: number): number {
  return Math.min(5 * GB, Math.floor(total * 0.1));
}

/** dir（無ければ、在る親）のディスクの空きと全体を statfs で測る。測れなければ null。 */
export function diskSpaceAt(dir: string): { free: number; total: number } | null {
  let d = dir;
  for (;;) {
    try {
      const s = fs.statfsSync(d);
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {
      const up = path.dirname(d);
      if (up === d) return null;
      d = up;
    }
  }
}

/** 空きが足りずに、その項目を降ろさなかった。項目のせいではないので、諦めには数えない。 */
class DiskShortError extends Error {
  constructor(readonly freeBytes: number, readonly reserveBytes: number) { super('disk short'); }
}

/** 止めたときの事実と、空きが戻ったかを見るための先頭の項目の大きさ。 */
type ShortState = SyncDiskShortDto & { firstSize: number };

/** 会話のまとまりの鍵。元の PC とセッションの ID で、本文の主線とサブエージェントを 1 つにまとめる。 */
const sessionGroupOf = (e: FileEntry): string => `${originOf(e)}\0${uuidOfTranscript(e.path)}`;

/**
 * 降ろす順に並べ替える。新しい会話（まとまりの中の最新の mtime が新しい方）から順で、まとまりの中も新しい写しから。
 * 新しく参加した PC は一覧の頭（いちばん古い本文）から降ろしていたので、いま続けたい会話がいちばん後に届いていた。
 * 同じ写し（元の PC とパス）の版が並んでいれば、最新の 1 件だけを残す。古い版を後から降ろすと、新しい版を上書きする。
 * 最新は mtime で決め、同じなら連番の大きい方（世代を回して鍵名だけ変わった行）を採る。
 * 上げ直した写し（sync/rebuild.ts）は連番が大きくても中身が古いことがあるので、連番より mtime を先に見る。
 */
function newestFirst(entries: FileEntry[]): FileEntry[] {
  const latest = new Map<string, FileEntry>();
  for (const e of entries) {
    const id = `${originOf(e)}\0${e.path}`;
    const prev = latest.get(id);
    if (!prev || prev.mtime < e.mtime || (prev.mtime === e.mtime && prev.seq < e.seq)) latest.set(id, e);
  }
  const top = new Map<string, number>();
  for (const e of latest.values()) {
    const g = sessionGroupOf(e);
    top.set(g, Math.max(top.get(g) ?? -Infinity, e.mtime));
  }
  const byNewest = (a: FileEntry, b: FileEntry) => b.mtime - a.mtime || b.seq - a.seq;
  return [...latest.values()].sort((a, b) => {
    const ga = sessionGroupOf(a);
    const gb = sessionGroupOf(b);
    if (ga === gb) return byNewest(a, b);
    return top.get(gb)! - top.get(ga)! || (ga < gb ? -1 : 1);
  });
}

/**
 * 同じ項目で続けて失敗してよい回数。これを超えたら飛ばして先に進む。
 * 1 件の直らない失敗（復号できない本文、書けない置き場）で filesSeq を止め続けると、
 * その後ろの本文が一生降りてこない。全部が止まるより、一部が降りてこない方がましである。
 */
const MAX_ATTEMPTS = 3;

/** 置き場は本人だけが読める。中身は他端末の会話の本文である。 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * 諦めた項目をもう一度試す間隔。
 * 起こし直したときと指紋が変わったときに加えて、動かしたままでも取り戻せるようにする。
 */
export const RETRY_SKIPPED_AFTER_MS = 30 * 60_000;

const SKIP_PREFIX = 'skipped:';

/**
 * 降ろすのを諦めた項目の控え。
 * sync_state に JSON で残す。メモリに置くと、起こし直した時点で痕跡ごと消えて二度と取り戻せない。
 * filesSeq は先へ進んでしまうので、一覧には二度と載らない。控えた項目そのものから降ろし直す。
 */
type SkipRecord = {
  /** 降ろし直すのに要る項目そのもの。 */
  entries: FileEntry[];
  /** 中身が変わったかを見る印。変われば数え直して取り直す。 */
  fingerprint: string;
  /** 続けて失敗した回数。起こし直しても引き継ぐので、起動のたびに鳴らし直さない。 */
  count: number;
  message: string;
  at: number;
};

/** 控えを読む。手で書き換えられた行や古い形の行は、同期を止めずに黙って捨てる。 */
function parseSkip(raw: string): SkipRecord | null {
  try {
    const v = JSON.parse(raw) as Partial<SkipRecord>;
    if (!Array.isArray(v.entries) || v.entries.length === 0) return null;
    // 封じたメタの前（世代を持たない）の控えは、降ろし直しようがないので捨てる。
    const first = v.entries[0] as Partial<FileEntry> | null;
    if (!first || typeof first.key !== 'string' || typeof first.epoch !== 'number' || typeof first.path !== 'string') return null;
    if (typeof v.fingerprint !== 'string' || typeof v.count !== 'number' || !Number.isFinite(v.count)) return null;
    return {
      entries: v.entries as FileEntry[],
      fingerprint: v.fingerprint,
      count: v.count,
      message: typeof v.message === 'string' ? v.message : '',
      at: typeof v.at === 'number' ? v.at : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 他端末の本文の置き場。
 * 相対パスは projects/ の下か、opencode の本文の写し（opencode/<会話>.json、会話の ID は鍵に使える形だけ）に限り、端末 ID も名前として安全な文字だけを許す。
 * ここを通さずに R2 の申告した文字列で組み立てると、~/.claude のような外の場所へ書けてしまう。
 */
export function remoteTranscriptPath(home: string, deviceId: string, rel: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(deviceId) || deviceId === '.' || deviceId === '..') throw new MessageError(msg('sync.pull.badDevice', { id: deviceId }));
  const own = agentOfSyncPath(rel);
  if (own !== null) return path.join(remoteRoot(home), deviceId, AGENT_SYNC[own.provider].remoteDir!, `${own.sessionId}.json`);
  const norm = path.posix.normalize(rel);
  if (!norm.startsWith('projects/') || norm.split('/').includes('..') || norm.startsWith('/')) throw new MessageError(msg('sync.pull.badPath', { path: rel }));
  return path.join(remoteRoot(home), deviceId, ...norm.split('/'));
}

/**
 * 世代の鍵が無くて越えた索引の行まで、本文の区切り（filesSeq）を巻き戻す。
 * 名簿と keybox の読み直しで新しい世代の鍵が届いたときに呼ぶ（Task 11 の名簿の層がつなぐ）。
 * 次の pull はその手前から一覧を読み直すので、越えた本文が降りてくる。降ろし済みの本文は指紋が同じなので降ろし直さない。
 * 区切りが控えより手前にいれば、その位置のまま（先へは進めない）。
 * 巻き戻したら true を返し、控えを消す。控えが無ければ何もせず false を返す。
 * 降ろしている最中に呼ぶと、その回の終わりの書き込みに上書きされうるので、動いている RemotePuller があれば rewindSkipped を使う。
 */
export function rewindSkippedFiles(state: SyncStateStore): boolean {
  const from = state.getNumber('filesSkippedFrom', 0);
  if (from <= 0) return false;
  state.set('filesSeq', Math.min(state.getNumber('filesSeq', 0), from - 1));
  state.set('filesSkippedFrom', null);
  return true;
}

/**
 * 他端末が上げた本文を降ろして手元に展開する。
 * 索引は client（SealedCloudClient）が開いて渡す。R2 の鍵名と中身のパスの対応は、client が開くときに確かめる（中身と違う鍵名の行は届かない）。
 * 手元の台帳（file_sync）は、R2 の鍵名ではなく、パスから求めた台帳の鍵（sync/ledgerKey.ts）で引く。
 * 設定ファイル（kind が config）は降ろさない。設定の同期（sync/config/）が、束の行から自分で取りに行く。
 * 書き込む先は ~/.agent-hangar/remote の下だけで、~/.claude には一切触らない。
 */
export class RemotePuller {
  /** この RemotePuller で最後に諦めた項目を試し直した時刻。null なら起こし直した直後である。 */
  private lastRetryAt: number | null = null;
  private readonly now: () => number;
  /**
   * 降ろす仕事を並べる 1 本の鎖。
   *
   * 降ろしは 2 か所から始まる。
   * 1 つは起動のときの 1 回で、もう 1 つはメタデータの pull が終わったときの合図である。
   * 並べずに走らせると、同じ鍵を 2 本の流れが同じ一時ファイルへ書き、filesSeq も互いに上書きし合う。
   * uploader と同じ作法で 1 本に並べる。
   */
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * `stop()` を通ったか。
   * 鎖に並んだ降ろしは、並んだ時点ではまだ走っていない。
   * 止めた後に走り出すと、閉じたデータベースと畳んだ通信に触れる（SyncEngine と同じ穴である）。
   * 起こす手続きを持たない作りなので、`started` ではなくこの向きで持つ。
   */
  private stopped = false;
  /**
   * 空きが足りずに止めている間の事実。null なら止めていない。
   * 起こし直すと消えるが、次の 1 回で一覧を読み直して同じ所でまた止まるので、残さなくてよい。
   */
  private short: ShortState | null = null;
  private readonly diskSpace: () => { free: number; total: number } | null;

  constructor(private readonly deps: PullerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.diskSpace = deps.diskSpace ?? (() => diskSpaceAt(remoteRoot(deps.home)));
  }

  /** 空きが足りずに降ろしていない会話の数と、要る大きさ。止めていなければ null。同期の状態に添えて画面へ出す。 */
  diskShort(): SyncDiskShortDto | null {
    if (this.short === null) return null;
    const { firstSize: _, ...dto } = this.short;
    return dto;
  }

  private setShort(next: ShortState | null): void {
    const was = this.diskShort();
    this.short = next;
    const now = this.diskShort();
    if (JSON.stringify(was) !== JSON.stringify(now)) this.deps.onDiskShortChanged?.(now);
  }

  /** size バイトを降ろしても、残す分を割らないか。割るなら DiskShortError を投げる。測れなければ通す。 */
  private ensureRoom(size: number): void {
    const d = this.diskSpace();
    if (d === null) return;
    const reserve = diskReserve(d.total);
    if (d.free - size < reserve) throw new DiskShortError(d.free, reserve);
  }

  /** 止めている間、空きが戻ったか。先頭の項目が入るだけの空きができたら戻ったとみなす。 */
  private roomBack(): boolean {
    if (this.short === null) return true;
    try { this.ensureRoom(this.short.firstSize); return true; } catch { return false; }
  }

  /** 失敗の理由を、いまの言語の文にする。辞書の文を持たない失敗（応答の本文、OS の失敗）は message のまま。 */
  private errorText(e: unknown): string { return errorText((this.deps.language ?? defaultLanguage)(), e); }

  /** 仕事を鎖の末尾につなぐ。前の仕事が転んでも次は走る。 */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * いま鎖に並んでいる仕事が終わるまで待つ。
   *
   * 合図から始まった降ろしは誰も約束を持たないので、テストと終了処理はここで待ち合わせる。
   * マイクロタスクを何回流したかに頼って待つと、zlib のように別の糸で進む処理の終わる回が
   * 端末によって変わり、macOS では通って Linux では落ちる試験になる。
   */
  async idle(): Promise<void> {
    for (;;) {
      const c = this.chain;
      await c.then(() => undefined, () => undefined);
      if (this.chain === c) return; // 待っている間に新しい仕事が並んだら、それも待つ。
    }
  }

  /**
   * 止める。
   * 印を立てると、鎖に並んでいる降ろしは先頭の検査で譲るので、以後は 1 件も要求を出さない。
   * 既に走り出している降ろしは最後まで走る。呼び手は `idle()` で待ち合わせてから止める。
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * 世代の鍵が無くて越えた行まで区切りを巻き戻す（rewindSkippedFiles）。
   * 降ろしと同じ鎖に並べるので、走っている pull の終わりの書き込みと食い違わない。巻き戻したら true。
   */
  rewindSkipped(): Promise<boolean> {
    return this.enqueue(async () => rewindSkippedFiles(this.deps.state));
  }

  private skipKey(key: string): `skipped:${string}` { return `${SKIP_PREFIX}${key}`; }

  private readSkip(key: string): SkipRecord | null {
    const raw = this.deps.state.get(this.skipKey(key));
    return raw === null ? null : parseSkip(raw);
  }

  private writeSkip(key: string, rec: SkipRecord): void { this.deps.state.set(this.skipKey(key), JSON.stringify(rec)); }

  private clearSkip(key: string): void { this.deps.state.set(this.skipKey(key), null); }

  /** 控えを全部読む。壊れた行は飛ばす。 */
  private allSkips(): { key: string; rec: SkipRecord }[] {
    const rows = this.deps.db.prepare('select key, value from sync_state where key like ? order by key').all(`${SKIP_PREFIX}%`) as { key: string; value: string }[];
    const out: { key: string; rec: SkipRecord }[] = [];
    for (const r of rows) {
      const rec = parseSkip(r.value);
      if (rec) out.push({ key: r.key.slice(SKIP_PREFIX.length), rec });
    }
    return out;
  }

  /**
   * 降ろすのを諦めた項目。利用者に見せるために残す。
   * sync_state から読むので、サーバを起こし直した後も答えられる。
   */
  skippedEntries(): { key: string; attempts: number; message: string }[] {
    return this.allSkips()
      .filter(({ rec }) => rec.count >= MAX_ATTEMPTS)
      .map(({ key, rec }) => ({ key, attempts: rec.count, message: rec.message }));
  }

  /**
   * 1 件の失敗を数える。
   * まだ諦めていなければ true を返す（呼び手は filesSeq をこの項目の手前で止める）。
   * 鳴らすのは 1 回目と諦めたときだけである。間で毎回鳴らすと、2 秒ごとの pull が同じ失敗で埋まる。
   * 数は sync_state に残るので、起こし直しても 1 から数え直さない。
   */
  private noteFailure(key: string, entries: FileEntry[], fingerprint: string, message: string): boolean {
    const prev = this.readSkip(key);
    const count = prev && prev.fingerprint === fingerprint ? prev.count + 1 : 1;
    this.writeSkip(key, { entries, fingerprint, count, message, at: this.now() });
    if (count < MAX_ATTEMPTS) {
      if (count === 1) this.deps.onError?.(key, message);
      return true;
    }
    if (count === MAX_ATTEMPTS) this.deps.onError?.(key, `${MAX_ATTEMPTS} 回続けて失敗したので、この項目はいったん飛ばします: ${message}`);
    return false;
  }

  /**
   * 諦めた項目をもう一度試す。
   * filesSeq は先へ進んでいて一覧には載らないので、控えた項目そのものから降ろし直す。
   * 失敗しても鳴らさない（諦めたときに 1 度鳴らしてある）。数だけ足して控えに残し続ける。
   * 版や上限で断られたら投げる。呼び手（sync/statusFeed.ts の pullFiles と、sync/oncePass.ts の 1 巡の files の段）は受け止めてログに残す。
   */
  private async retrySkipped(): Promise<number> {
    let downloaded = 0;
    for (const { key, rec } of this.allSkips()) {
      // まだ諦めていないものは filesSeq が手前で止まっているので、通常の経路で取り直される。
      if (rec.count < MAX_ATTEMPTS) continue;
      try {
        if (await this.download(rec.entries[0]!)) downloaded++;
        this.clearSkip(key);
      } catch (err) {
        // 空きが足りないのも、この項目のせいではない。数を足さずに、残りの取り直しを次の機会へ回す。
        if (err instanceof DiskShortError) break;
        // 版が合わずに断られたのと、上限で断られたのは、この項目のせいではない。
        // 諦めた回数と理由を書き換えずに、その回の残りの取り直しも打ち切る（呼び手の pullNow ごと投げる）。
        if (err instanceof CompatError || err instanceof LimitError) throw err;
        this.writeSkip(key, { ...rec, count: rec.count + 1, message: this.errorText(err), at: this.now() });
      }
    }
    return downloaded;
  }

  /**
   * 新着を降ろす。
   * 呼び手が誰であっても鎖に並ぶので、起動の 1 回と pulled の合図が重なっても重ならない。
   */
  async pullNow(): Promise<{ downloaded: number }> {
    return this.enqueue(() => (this.stopped ? Promise.resolve({ downloaded: 0 }) : this.pullNowInner()));
  }

  private async pullNowInner(): Promise<{ downloaded: number }> {
    let downloaded = 0;
    const startedAt = this.now();
    // 空きが足りずに止めている間は、一覧も読みに行かない。
    // 区切りは止めた項目の手前にあるので、読みに行くと 2 秒ごとに降ろせない一覧を頭から読み直し、D1 の読み取りを使い続ける。
    if (!this.roomBack()) return { downloaded: 0 };
    // 諦めた項目を取り戻す機会。起こし直した直後（lastRetryAt が無い）と、間隔が空いたときに試す。
    if (this.lastRetryAt === null || startedAt - this.lastRetryAt >= RETRY_SKIPPED_AFTER_MS) {
      this.lastRetryAt = startedAt;
      downloaded += await this.retrySkipped();
    }
    let since = this.deps.state.getNumber('filesSeq', 0);
    let advanceTo = since;
    let minFailed: number | null = null;
    let minUnreadable: number | null = null;
    // 一覧を先に読み切ってから、新しい会話から順に降ろす（newestFirst）。
    const candidates: FileEntry[] = [];
    for (;;) {
      const page = await this.deps.client.listFiles(since, PULL_LIMIT);
      // 世代の鍵が無くて開けなかった行は、区切りを止めずに越え、いちばん小さい連番を控える。
      // 止めると後ろの本文がすべて止まる。鍵が届いたら rewindSkippedFiles がここまで巻き戻す。
      for (const u of page.unreadable) minUnreadable = minUnreadable === null ? u.seq : Math.min(minUnreadable, u.seq);
      for (const e of page.files) {
        // 自分が上げたものと、他の PC が上げ直した自分の本文の写しは降ろさない（原本が手元にある）。
        if (e.deviceId === this.deps.deviceId || originOf(e) === this.deps.deviceId) continue;
        // 設定（kind が config）は降ろさない。束の本体は設定の同期が、束の行を見て自分で取りに行く。
        if (e.kind === 'config') continue;
        // 削除したセッション（sessions/trash.ts）の写しは降ろさない。印を受け取る前の持ち主が上げた分でも、置けば消し直すだけになる。
        if (this.isTrashed(e.path)) continue;
        candidates.push(e);
      }
      // その回の出発点より下がらないようにする。
      // 壊れた応答（手前を指す nextSeq）で filesSeq を巻き戻すと、降ろし済みの項目を延々と読み直す。
      // 呼び手が意図して filesSeq を 0 に戻す道（全件の取り直し）は、出発点そのものが 0 なので邪魔しない。
      advanceTo = Math.max(advanceTo, page.nextSeq);
      // 進まない応答で回り続けない。
      if (!page.more || page.nextSeq <= since) break;
      since = page.nextSeq;
    }
    const order = newestFirst(candidates);
    let short: ShortState | null = null;
    for (let i = 0; i < order.length; i++) {
      const e = order[i]!;
      try {
        if (await this.download(e)) { downloaded++; this.clearSkip(e.key); }
      } catch (err) {
        // 空きが足りなければ、ここで止める。古い会話ほど後ろにあるので、残るのは古い方である。
        // 残りのいちばん小さい連番の手前で区切りを止め、空きが戻ったらそこから読み直す。
        if (err instanceof DiskShortError) {
          const rest = order.slice(i);
          short = this.shortOf(rest, err);
          const minRest = Math.min(...rest.map((r) => r.seq));
          minFailed = minFailed === null ? minRest : Math.min(minFailed, minRest);
          break;
        }
        // 版が合わずに断られたのと、上限で断られたのは、この項目のせいではない。諦めに数えずに回ごと止め、filesSeq も進めない。
        if (err instanceof CompatError || err instanceof LimitError) throw err;
        if (this.noteFailure(e.key, [e], e.sha256, this.errorText(err))) minFailed = minFailed === null ? e.seq : Math.min(minFailed, e.seq);
      }
    }
    this.setShort(short);
    // 失敗した項目より手前で止めて、次の pull で取り直す。
    this.deps.state.set('filesSeq', minFailed !== null ? minFailed - 1 : advanceTo);
    if (minUnreadable !== null) {
      const prev = this.deps.state.getNumber('filesSkippedFrom', Infinity);
      this.deps.state.set('filesSkippedFrom', Math.min(prev, minUnreadable));
    }
    if (downloaded > 0) this.deps.onDownloaded?.(downloaded);
    return { downloaded };
  }

  /**
   * 写しの相対パス（projects/<フォルダ>/<uuid>.jsonl か projects/<フォルダ>/<uuid>/subagents/...）のセッションに、削除の印があるか。
   * 印は session_states.trashed_at にある（版 25）。
   */
  private isTrashed(rel: string): boolean {
    const uuid = uuidOfTranscript(rel);
    if (uuid === '') return false;
    return this.deps.db.prepare(`select 1 from sessions s join session_states st on st.session_id = s.id and st.deleted_at is null
      where s.provider_session_id = ? and st.trashed_at is not null`).get(uuid) !== undefined;
  }

  /**
   * そのセッション（Claude Code のセッション ID）の写しを降ろし直す。削除したセッションがほかの PC で戻されたときに呼ぶ（sessions/trash.ts）。
   * 台帳（file_sync）には頼らず、写しの一覧を先頭から引き直して、そのセッションの項目の最新を降ろす。
   * 印の後に一覧を見た PC や、後から参加した PC は、印のある写しを飛ばしたので台帳に行が無い。行があっても、消えている間に上がった続きの指紋とは食い違う。
   * 一覧の区切り（filesSeq）は動かさない。失敗は onError に流し、次の項目へ進む。
   */
  refetchSession(uuid: string): Promise<{ downloaded: number }> {
    return this.enqueue(async () => {
      if (this.stopped) return { downloaded: 0 };
      const latest = new Map<string, FileEntry>();
      let since = 0;
      for (;;) {
        const page = await this.deps.client.listFiles(since, PULL_LIMIT);
        for (const e of page.files) {
          if (e.deviceId === this.deps.deviceId || originOf(e) === this.deps.deviceId || e.kind !== 'transcript' || uuidOfTranscript(e.path) !== uuid) continue;
          // 世代を回すと同じ写しが別の鍵名でもう 1 件並ぶので、元の PC とパスで 1 件にまとめる。
          const id = `${originOf(e)}\0${e.path}`;
          const prev = latest.get(id);
          if (!prev || prev.seq < e.seq) latest.set(id, e);
        }
        if (!page.more || page.nextSeq <= since) break;
        since = page.nextSeq;
      }
      let downloaded = 0;
      for (const e of latest.values()) {
        try {
          if (await this.download(e)) downloaded++;
        } catch (err) {
          if (err instanceof CompatError || err instanceof LimitError) throw err;
          // 空きが足りなければ残りも入らない。止めた事実は、いつもの降ろし（pullNow）が知らせる。
          if (err instanceof DiskShortError) break;
          this.deps.onError?.(e.key, this.errorText(err));
        }
      }
      if (downloaded > 0) this.deps.onDownloaded?.(downloaded);
      return { downloaded };
    });
  }

  /**
   * 止めたときの事実。降ろさずに残した項目のうち、降ろす要るものの会話の数と大きさを数える。
   * firstSize は止めた項目の大きさで、空きが戻ったかをこれで見る（roomBack）。
   */
  private shortOf(rest: FileEntry[], err: DiskShortError): ShortState {
    const need = rest.filter((e) => { try { return this.needsDownload(e) !== null; } catch { return false; } });
    return {
      sessions: new Set(need.map(sessionGroupOf)).size,
      needBytes: need.reduce((n, e) => n + e.size, 0),
      freeBytes: err.freeBytes,
      reserveBytes: err.reserveBytes,
      firstSize: rest[0]!.size,
    };
  }

  /**
   * 降ろす要るか。要るなら置き場のパスと台帳の鍵を返し、既に同じ指紋の実体があるなどで要らなければ null を返す。
   * パスが不正なら投げる。
   */
  private needsDownload(e: FileEntry): { target: string; ledger: string } | null {
    const origin = originOf(e);
    const ledger = ledgerKeyOfPath(origin, e.path);
    if (ledger === null) throw new MessageError(msg('sync.pull.badPath', { path: e.path }));
    const target = remoteTranscriptPath(this.deps.home, origin, e.path);
    const prev = this.deps.db.prepare('select sha256, mtime from file_sync where key = ?').get(ledger) as { sha256: string; mtime: number } | undefined;
    if (prev?.sha256 === e.sha256 && fs.existsSync(target)) return null;
    // 上げ直した写し（上げた PC と元の PC が違う）は、元の PC の上げた本文より古いことがある。手元の写しの方が新しければ残す。
    if (origin !== e.deviceId && prev && prev.mtime > e.mtime && fs.existsSync(target)) return null;
    return { target, ledger };
  }

  /**
   * 1 件を降ろす。既に同じ指紋の実体があれば false を返して何もしない。
   * 書く前に空きを見て、降ろした後の空きが残す分を割るなら DiskShortError を投げる（呼び手がそこで止める）。
   */
  private async download(e: FileEntry): Promise<boolean> {
    const origin = originOf(e);
    const need = this.needsDownload(e);
    if (need === null) return false;
    const { target, ledger } = need;
    this.ensureRoom(e.size);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: DIR_MODE });
    // 直接の宛先には書かない。
    // 切り詰められた入力では error が出る前に 1 チャンク分の平文が流れるので、
    // 途中まで書けたファイルが本物として残ると索引器がそれを読んでしまう。
    // 一時ファイルに書き切り、SHA-256 が合ったものだけを rename で本物にする。
    const tmp = `${target}.part`;
    try {
      // 前の回の残骸があると mode が引き継がれないので、必ず作り直す。
      fs.rmSync(tmp, { force: true });
      // 本文は索引の世代の鍵で、client が復号して gzip を解いて渡す。
      const body = await this.deps.client.getFile(e.key, e.epoch);
      // pipeline でつなぐ。裸の pipe だと復号の error が未処理になってプロセスごと落ちる。
      await pipeline(body, fs.createWriteStream(tmp, { mode: FILE_MODE }));
      const sha = await sha256Stream(fs.createReadStream(tmp));
      if (sha !== e.sha256) throw new MessageError(msg('sync.pull.shaMismatch', { key: e.key }));
      // 本物の名前を付ける前に落とし切る。電源が落ちても、中身の無いファイルが本物として残らない。
      // copy.ts の copyOverAtomically と同じ規則である。
      const fd = fs.openSync(tmp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    // 索引化の選別が更新時刻で最新の写しを選ぶので、相手の mtime に合わせる。
    fs.utimesSync(target, new Date(e.mtime), new Date(e.mtime));
    this.deps.db.prepare(`insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)
      on conflict(key) do update set path = excluded.path, device_id = excluded.device_id, sha256 = excluded.sha256, size = excluded.size, mtime = excluded.mtime, remote_seq = excluded.remote_seq, synced_at = excluded.synced_at`)
      .run(ledger, 'transcript', e.path, origin, e.sha256, e.size, e.mtime, e.seq, this.now());
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
