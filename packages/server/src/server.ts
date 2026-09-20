import { serve } from '@hono/node-server';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listArtifacts } from './artifacts/queries.ts';
import { backupsRoot, readCloudConfig, remoteRoot } from './config/cloud.ts';
import { dbPath, defaultClaudeDir, ensureHome, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings, type Settings } from './config/paths.ts';
import { ensureStatuslineHeaderFile } from './config/statusline.ts';
import { resolveToolPaths, which } from './config/tools.ts';
import { encodeJoinToken, type FileEntry, type FileMetaIn, type LaunchResultDto, type LiveSessionDto, type ResumeHereConflictDto, type ServerEvent } from '@agent-hangar/shared';
import { openDb, type Db } from './db/open.ts';
import { getProject, getSession, listDevices, listProjects } from './db/queries.ts';
import { upsertShared } from './db/shared.ts';
import { openDirInTerminalApp, openInEditor, openInTerminalApp } from './external/open.ts';
import { createApp, type ExternalApi } from './http/app.ts';
import { writeBaselineIfNeeded } from './indexer/baseline.ts';
import { IndexerService } from './indexer/service.ts';
import { ensureWrapperScript } from './launch/wrapper.ts';
import { MemoStore } from './projects/memo.ts';
import { promoteSession } from './projects/promote.ts';
import { assignSession, assignSessions, checkProjectRoots, syncProjectsFromWorkspace } from './projects/registry.ts';
import { ensureScratchProject } from './projects/scratch.ts';
import { RegistryWatcher } from './provider/claude-code/registry.ts';
import { ensureSpawnHelper } from './pty/helper.ts';
import { nodePtySpawn } from './pty/nodePty.ts';
import { PtyRelay } from './pty/relay.ts';
import { RunError, RunManager } from './runs/manager.ts';
import { aliveRunForSession } from './runs/queries.ts';
import { ClaudeHeadlessSummarizer } from './summary/claude.ts';
import { SummaryJob } from './summary/job.ts';
import { LmStudioSummarizer } from './summary/lmstudio.ts';
import type { Summarizer } from './summary/types.ts';
import { writeMemoConflictCopy, type SessionMemoBackup } from './sync/apply.ts';
import { BACKUP_GENERATIONS, ClaudeConfigSync } from './sync/claudeConfig.ts';
import { HttpCloudClient, type CloudClient } from './sync/client.ts';
import { copyTranscriptForResume } from './sync/copy.ts';
import { deriveFileKey } from './sync/crypto.ts';
import { SyncEngine } from './sync/engine.ts';
import { RemotePuller } from './sync/puller.ts';
import { D1_WRITES_PER_DEVICE_TOUCH, type QuotaCounter } from './sync/quota.ts';
import { SyncStateStore } from './sync/state.ts';
import { TranscriptUploader } from './sync/uploader.ts';
import { Tmux } from './tmux/tmux.ts';
import { UsageTracker } from './usage/statusline.ts';
import { EventHub } from './ws/hub.ts';

export const VERSION = '0.3.0';

const ROOT_CHECK_MS = 30_000;
/** devices に最終確認を書き込む間隔。 */
const DEVICE_TOUCH_MS = 600_000;
/**
 * run の終了から 2 度目の flushSession までの待ち。
 * Claude は終了の直前まで本文に書き足すので、終了の直後の 1 回だけだと最後の数行が上がらない。
 */
const FLUSH_AGAIN_MS = 5_000;
/**
 * Claude Code 設定の定期 push の間隔。
 * 監視が張れない置き場所や、取りこぼした編集があっても、次の周期で揃うようにする。
 * fs.watch の recursive は Node 22 では Linux でも効く（容器で確かめた）ので、
 * これは監視そのものが張れなかったときの備えであって、Linux のための穴埋めではない。
 */
const CONFIG_PUSH_MS = 60_000;
/**
 * 上がっていない本文を拾い直す走査の間隔。
 * 索引は「変化したファイル」しか知らせないので、これが無いと参加より前に索引が済んでいた本文は
 * ファイルが動くまで永久に上がらない。設定の定期 push と同じ役目なので、間隔も揃えてある。
 */
export const UPLOAD_SWEEP_MS = 60_000;

/**
 * `files` の 1 行を書くときに動く索引の数。
 * `key text not null unique` に SQLite が自分で張る索引と、`files_kind` の 2 つである
 * （`packages/cloud/src/schema.ts`）。
 * `seq integer primary key` は rowid そのものなので索引を増やさない。
 */
const FILES_INDEXES = 2;
/**
 * `files` への insert が余分に動かす `sqlite_sequence` の 1 行。
 *
 * `seq` は `autoincrement` なので、insert のたびに `sqlite_sequence` の行が進む（delete では動かない）。
 * better-sqlite3 で実際に確かめた（insert 2 回で seq が 1 から 2 に進み、delete では変わらない）。
 * D1 の `rows_written` がこの内部の表を数えるかどうかは、公開の定義からは決められない。
 * 実測の 369 行は「数える」「数えない」のどちらの分け方でも同じ合計になるので、実物でも決着しない。
 * **決められないときは多い方で数える。** 少なく数えると枠を越えてから止まり、課金されない約束が崩れる。
 */
const D1_WRITES_PER_AUTOINCREMENT = 1;

/**
 * `PUT /files/<鍵>` が D1 に書く行数。
 *
 * Worker は R2 に置いた後、`files` の delete と insert、`devices` の last_seen_at を 1 つの batch で書く
 * （`packages/cloud/src/files.ts` の 242 行から 248 行）。
 * 無料枠が見ているのは文の数ではなく `rows_written` で、索引への書き込みも 1 行ずつ数える。
 * 内訳は delete が 1 + 索引 2、insert が 1 + 索引 2 + `sqlite_sequence` 1、`devices` の更新が 1 である。
 * 同じ鍵へ上げ直すたびに delete が当たるので、当たる方（多い方）で数える。
 */
export const D1_WRITES_PER_FILE_PUT = (1 + FILES_INDEXES) + (1 + FILES_INDEXES + D1_WRITES_PER_AUTOINCREMENT) + D1_WRITES_PER_DEVICE_TOUCH;
/**
 * `DELETE /files/<鍵>` が D1 に書く行数。
 * `files` から 1 行消すだけである（同 272 行）。本体 1 行と索引 2 行で 3 行になる。
 * `devices` は触らず、`sqlite_sequence` は delete では動かない。
 * R2 の削除は D1 に書かない。
 */
export const D1_WRITES_PER_FILE_DELETE = 1 + FILES_INDEXES;

/**
 * R2 への出し入れを無料枠の勘定に入れるための包み。
 *
 * 数えるのは **SyncEngine が自分で数えない経路だけ**である。
 * `pushChanges`、`pullChanges`、`snapshot` は engine が `request()` と `doPush` の中で数えるので、
 * ここで掛けると同じ要求を 2 回数えて、枠の見張りが実際の半分の位置で止める。
 * 止めるのは engine の `guardQuota` に任せる（止めた日を覚えていて、再開の直後に押し返さない）。
 */
export function countingClient(inner: CloudClient, quota: QuotaCounter): CloudClient {
  const note = <T>(rows: number, p: Promise<T>): Promise<T> => { quota.note({ requests: 1, rows }); return p; };
  return {
    health: () => note(0, inner.health()),
    // engine が数える 3 つは素通しにする。
    pushChanges: (c) => inner.pushChanges(c),
    pullChanges: (s, l) => inner.pullChanges(s, l),
    snapshot: (a, l) => inner.snapshot(a, l),
    putFile: (m: FileMetaIn, b) => note(D1_WRITES_PER_FILE_PUT, inner.putFile(m, b)),
    // 降ろすのと一覧は読むだけで、D1 には 1 行も書かない。
    getFile: (k) => note(0, inner.getFile(k)),
    listFiles: (s, l) => note(0, inner.listFiles(s, l)),
    deleteFile: (k) => note(D1_WRITES_PER_FILE_DELETE, inner.deleteFile(k)),
  };
}

/**
 * セッションのメモを他端末の新しい版で置き換えたときの知らせ。
 * 控えはもうファイルになっているので、利用者に伝えるのは「どこに残したか」である。
 */
export function sessionMemoBackupMessage(o: SessionMemoBackup): string {
  return `セッションのメモを ${o.deviceName} の新しい内容で置き換えました。手元の内容は ${o.backupFile} に残してあります`;
}

/**
 * Claude Code 設定の同期が外と話してよいか。
 * 切っているときはもちろん、一時停止のあいだも押し出さない。
 * 「一時停止」は外と話すのをやめることで、無料枠の 80% で自分から止まったときも同じである（決定 4）。
 * `ClaudeConfigSync` は `enabled()` しか見ないので、判定はこちらで組み立てて渡す。
 */
export function configSyncActive(o: { syncClaudeConfig: boolean; paused: boolean }): boolean {
  return o.syncClaudeConfig && !o.paused;
}

/**
 * WebSocket の upgrade を受け付ける経路。
 * ここに無い経路は番人が切る。attach する側とこの集合が食い違うと、
 * 101 を返した直後の接続を番人が切ってしまうので、定数を正本にして両方から参照する。
 */
export const WS_PATHS = new Set(['/ws', '/ws/pty']);
/** tmux の一覧を見て run の終了を拾う間隔。 */
const RUN_POLL_MS = 2000;

/**
 * run が終わったときの要約の受け付け方。
 * RunManager.kill は tmux kill-session の直後に同期で runEnded を出すが、
 * レジストリは ~/.claude/sessions を 500 ミリ秒周期で読んだキャッシュなので、
 * その瞬間は必ず「生きている」と出て受理を断ってしまう。
 * run の終了はこちらが知っているので、生存判定だけを飛ばす。
 * 土台かどうかと 5 ターンの判定は残す。
 */
export const RUN_ENDED_SUMMARY_OPTS = { ignoreLive: true } as const;

/**
 * 終了に使う時間の予算。
 *
 * 数を別々に持つと、片方だけ直されて必ず食い違う。
 * 実際に「close が最悪 14 秒、番犬が 3 秒、.app の猶予が 8 秒」という三すくみになり、
 * 番犬が close を切るので db.close() まで届かなかった。
 * これからは 1 本の締め切りを決め、残りをそこから導く。
 *
 * 1. `CLOSE_DEADLINE_MS` … `close()` 全体の締め切りである。
 *    段ごとに別々の上限を数えず、この 1 本の締め切りに対して待つので、待ちの和はこれを超えない。
 * 2. `STOP_WATCHDOG_MS` … SIGTERM を受けてから `process.exit(0)` を呼ぶ番犬である（`installShutdown`）。
 *    締め切りより後でなければ、`close()` を途中で切って `db.close()` に届かない。
 *    締め切りの後に残る仕事（WebSocket の畳み、listen の解放、WAL の畳み）のぶんの余裕を足してある。
 * 3. `.app` の `STOP_GRACE`（apps/desktop/src-tauri/src/server.rs） … SIGTERM から SIGKILL までの猶予である。
 *    番犬より後でなければ、サーバが自分で降りる前に殺される。
 *
 * 普段は待つものが無いので、⌘Q からウィンドウが消えるまでは数ミリ秒である。
 * この予算が効くのは、クラウドが応答しないときのように待ちが出た回だけである。
 * 3 つの大小関係は server.test.ts の「終了の時間の予算」が押さえている。
 * ここを変えるときは、必ず 3 つとも見直すこと。
 */
export const CLOSE_DEADLINE_MS = 5_000;

/**
 * SIGTERM か SIGINT を受けてから、後始末の終わりを待たずに `process.exit(0)` を呼ぶまで。
 * `CLOSE_DEADLINE_MS` より後でなければならない。
 */
export const STOP_WATCHDOG_MS = 8_000;

/**
 * この端末のルートの存在を確かめ、消えたものを知らせ、戻ったものの取りこぼしを拾う。
 * ルートが消えている間に現れたセッションは、解決済みのルートに当たらないので未分類のまま残る。
 * 戻ったときに紐づけ直さないと、次の起動まで未分類のままになり、プロジェクトにも出てこない。
 * 戻ったルートが無いときは何もしない。起動時の 1 回目はたいていこちらを通るので、全件を舐めない。
 * 消えたものの検出と project.unresolved の配信は前のままである。
 */
export function checkRoots(o: { db: Db; deviceId: string; live: () => LiveSessionDto[]; broadcast: (ev: ServerEvent) => void }): { unresolved: string[]; recovered: string[] } {
  const r = checkProjectRoots(o.db, o.deviceId);
  for (const id of r.unresolved) o.broadcast({ type: 'project.unresolved', projectId: id });
  if (r.recovered.length === 0) return r;
  const unassigned = (o.db.prepare('select id from sessions where project_id is null and deleted_at is null').all() as { id: string }[]).map((x) => x.id);
  assignSessions(o.db, o.deviceId);
  const live = o.live();
  // 戻ったプロジェクトと、紐づけ直しで中身が変わったプロジェクトを配る。
  const touched = new Set(r.recovered);
  for (const id of unassigned) {
    // ロックを出すために自端末の ID を渡す。渡さないと他端末の run が一切見えない。
    const s = getSession(o.db, live, id, { deviceId: o.deviceId });
    if (!s?.projectId) continue;
    touched.add(s.projectId);
    o.broadcast({ type: 'session.upsert', session: s });
  }
  for (const id of touched) {
    const p = getProject(o.db, o.deviceId, live, id);
    if (p) o.broadcast({ type: 'project.upsert', project: p });
  }
  return r;
}

/** idle() が返るまで待つ。上限までに空になれば真、諦めたら偽を返す。 */
export function waitForIdle(job: { idle(): Promise<void> }, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    job.idle().then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * 走っている本文の上げを待ってから止める。上限までに終われば真を返す。
 * 待たずに stop すると、デバウンスのタイマーが始めた putFile が途中で切れる。
 * 上限を超えたときも必ず止める。終了が転送に引きずられる方が困る。
 */
export async function stopUploader(up: { idle(): Promise<void>; stop(): void } | null, ms: number = CLOSE_DEADLINE_MS): Promise<boolean> {
  if (!up) return true;
  const done = await waitForIdle(up, ms);
  if (!done) console.warn(`[upload] 本文の送信を ${ms} ミリ秒待ちましたが終わらないので、待たずに閉じます`);
  up.stop();
  return done;
}

/**
 * 走っている仕事が終わるのを待ってから止める。上限までに終われば真を返す。
 *
 * タイマーから始まった push は誰も約束を持たないので、待たずに stop すると途中で切れる。
 * 設定の同期（ClaudeConfigSync）とメタデータの同期（SyncEngine）が、どちらもこの形である。
 * 上限を超えたときも必ず止める。終了が通信に引きずられる方が困る。
 */
export async function stopAfterIdle(job: { idle(): Promise<void>; stop(): void } | null, label: string, ms: number = CLOSE_DEADLINE_MS): Promise<boolean> {
  if (!job) return true;
  const done = await waitForIdle(job, ms);
  if (!done) console.warn(`[${label}] 走っている同期を ${ms} ミリ秒待ちましたが終わらないので、待たずに閉じます`);
  job.stop();
  return done;
}

/**
 * 控えを新しい方から数えて `keep` 件だけ残し、古いものを消す。消した数を返す。
 *
 * 設定の控え（`claudeConfig.ts` の `pruneBackups`）は名前が `yyyyMMdd-HHmmss` のディレクトリなので
 * 辞書順がそのまま時刻順になるが、本文の控え（`<uuid>-<時刻>.jsonl`）とメモの控え
 * （`session-<ID>-<時刻>.md`）は名前が ID で始まるので、辞書順では時刻の順に並ばない。
 * そこで更新時刻で並べ、同じ秒に並んだものは名前で決める（控えは作った時刻がそのまま更新時刻になる）。
 *
 * 入れ物の中のディレクトリは触らない。`backups/` の下には `claude-config/` のような入れ物も並ぶ。
 * 消せなかったものは数えない。掃除は次の機会に回す。
 */
export function pruneBackupFiles(dir: string, keep: number): number {
  // 控えを全部消す刈り込みは作らない。
  const limit = Math.max(1, keep);
  let names: string[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch (e) {
    // 入れ物がまだ無いのはふつうのことである（その種類の控えを 1 度も取っていない端末）。
    // それ以外は握り潰さない。握り潰すと、刈れていないことが誰にも見えないまま溜まり続ける。
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  if (names.length <= limit) return 0;
  const dated = names.map((n) => {
    // 読めないものは最も古いものとして扱う。次の機会に消える。
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, n)).mtimeMs; } catch { /* 上のとおり */ }
    return { n, mtime };
  });
  dated.sort((a, b) => b.mtime - a.mtime || (a.n < b.n ? 1 : a.n > b.n ? -1 : 0));
  let removed = 0;
  for (const { n } of dated.slice(limit)) {
    try { fs.rmSync(path.join(dir, n), { force: true }); removed++; } catch { /* 消せなくても控えは残る。 */ }
  }
  return removed;
}

/** 要約のジョブが空になるまで待つ。上限までに空になれば真、諦めたら偽を返す。 */
export function waitForSummaryIdle(job: { idle(): Promise<void> }, ms: number = CLOSE_DEADLINE_MS): Promise<boolean> {
  return waitForIdle(job, ms);
}

/**
 * SIGINT と SIGTERM の受け口を立て、止める手続きを返す。
 *
 * **`startServer()` を待たずに呼ぶこと。**
 * HTTP の待ち受けと `/health` は `startServer()` の途中で先に生きる。
 * `.app` はその `/health` を準備完了の合図にしてウィンドウを移すので、
 * 解決を待ってから受け口を立てると、その間に届いた SIGTERM が既定の扱いでプロセスを即座に殺し、
 * `close()` が 1 行も走らない（`db.close()` も走らない）。
 * 起動の途中で信号が来たときは、起動が終わり次第 `close()` を走らせる。
 *
 * 番犬は後始末が終わらなくても必ず降りるための保険である。
 * `CLOSE_DEADLINE_MS` より後に置く（その理由は同じところに書いてある）。
 *
 * process への依存は引数で差し替えられる。試験は偽の受け口と偽の exit を渡す。
 */
export function installShutdown(
  startup: Promise<{ close(): Promise<void> }>,
  o: {
    on?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
    exit?: (code: number) => void;
    setTimeout?: typeof setTimeout;
    watchdogMs?: number;
  } = {},
): () => void {
  const on = o.on ?? ((signal, handler) => { process.on(signal, handler); });
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const setTimer = o.setTimeout ?? setTimeout;
  const watchdogMs = o.watchdogMs ?? STOP_WATCHDOG_MS;
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    // 後始末が終わらなくても必ず降りる。
    // unref してあるので、これ 1 本だけのためにイベントループは生き延びない。
    const timer = setTimer(() => exit(0), watchdogMs);
    (timer as { unref?: () => void }).unref?.();
    // 起動の途中なら、起動が終わってから閉じる。起動そのものが転んだ回は閉じるものが無い。
    void startup.then((s) => s.close(), () => undefined).catch(() => undefined).finally(() => exit(0));
  };
  on('SIGINT', stop);
  on('SIGTERM', stop);
  // 起動が転んだときに、誰も受け取らない拒否を残さない。呼び手は自分の分を別に受け取る。
  void startup.catch(() => undefined);
  return stop;
}

/** createApp が返すアプリの fetch。listen した後に差し込むために型だけ取る。 */
type Fetch = ReturnType<typeof createApp>['fetch'];

export type StartOptions = {
  /** 0 を渡すと空いているポートを使い、実際の番号を返り値の port に入れる。 */
  port?: number;
  host?: string;
  home?: string;
  /** 設定ファイルより優先する Claude Code のディレクトリ。テストがフィクスチャの複製を指すために使う。 */
  claudeDir?: string;
  uiDist?: string;
};

/**
 * DB、索引、実行中セッションの監視、run の管理、HTTP と WebSocket をまとめて起動する。
 * ~/.claude は読むだけで、書き込みは home 配下に限る。
 */
export async function startServer(opts: StartOptions = {}): Promise<{ close(): Promise<void>; port: number }> {
  const home = opts.home ?? hangarHome();
  ensureHome(home);
  const token = readOrCreateToken(home);
  // statusline が curl に読ませるヘッダのファイルは、トークンと同じところで用意する。
  // install のときにしか置かないと、置き場を消した利用者の使用量が何も言わずに止まる。
  ensureStatuslineHeaderFile(home, token);
  const device = readOrCreateDevice(home);
  // tmux と code のパスが設定に無ければここで探して書き戻す。GUI 起動の貧弱な PATH でも見つけられる。
  let settings: Settings = resolveToolPaths(loadSettings(home));
  saveSettings(home, settings);
  ensureWrapperScript(home);
  const fixed = ensureSpawnHelper();
  if (fixed.length) console.log('[pty] spawn-helper に実行権限を付けました:', fixed.join(', '));

  const claudeDir = opts.claudeDir ?? (settings.claudeDir || defaultClaudeDir());
  const db = openDb(dbPath(home));
  const hub = new EventHub(VERSION);
  const registry = new RegistryWatcher(claudeDir);

  // クラウド同期。cloud.json が無ければ client は null で、同期の状態は off になる。
  const cloudRead = readCloudConfig(home);
  const cloud = cloudRead.config;
  if (cloudRead.state === 'broken') {
    // 「壊れている」を「未参加」と同じに扱わない。
    // 参加し直すと別の joinSecret が入り、R2 にある既存の暗号化ファイルを誰も復号できなくなる。
    console.error('[sync] ~/.agent-hangar/cloud.json を読めませんでした。同期は止めたままにします。hangar cloud status で確かめてください（参加し直すと既存の本文を復号できなくなります）');
  }
  const toast = (level: 'info' | 'error', message: string) => hub.broadcast({ type: 'toast', level, message });
  const syncState = new SyncStateStore(db);
  /** 同期が止まっているか。利用者が押した一時停止も、枠の 80% で自分から止まった分もここに出る。 */
  const isPaused = (): boolean => engine.status().state === 'paused';
  /**
   * 本文とメモの控えの世代を刈る。
   *
   * 残す数は設定の控えと同じ `BACKUP_GENERATIONS`（20）にする。
   * 覚える数が 1 つで済み、「控えは直近 20 回ぶん」という説明が 3 種類すべてで同じになる。
   * 本文の控えはセッション 1 本ぶんの大きさがあるので、これ以上は溜めない。
   *
   * 刈るのは控えを取った後だけなので、「控えを取れなかったときは書き戻さない」という決まりには触らない。
   * いま取った控えは最も新しいので、この刈り込みで消えることはない。
   */
  const pruneBackups = (kind: 'transcripts' | 'memos'): void => {
    try { pruneBackupFiles(path.join(backupsRoot(home), kind), BACKUP_GENERATIONS); }
    catch (e) { console.error('[backups]', e instanceof Error ? e.message : e); }
  };
  const rawClient = cloud ? new HttpCloudClient({ url: cloud.url, token: cloud.deviceToken }) : null;
  const fileKey = cloud ? deriveFileKey(cloud.joinSecret) : Buffer.alloc(32);
  const engine = new SyncEngine({
    db, deviceId: device.id, client: rawClient, url: cloud?.url ?? null, home,
    // 負けた手元のメモは隣に残す。名前の組み立ても既存の写しの守りも writeMemoConflictCopy が持っている。
    // ここで投げれば、その行は適用されない（控えの無いまま利用者の文章を消さない）。
    onMemoConflict: (o) => {
      const file = writeMemoConflictCopy(memos.memoPath(o.projectId), o);
      toast('info', `メモが競合しました。手元の内容を ${path.basename(file)} に残しました`);
    },
    // 控えはもうファイルになっている。ここでやるのは置き場を知らせることだけである。
    onSessionMemoBackup: (o) => { toast('info', sessionMemoBackupMessage(o)); pruneBackups('memos'); },
  });
  // 本文と設定の出し入れは engine を通らないので、無料枠の勘定に入るように包んでから渡す。
  const client = rawClient ? countingClient(rawClient, engine.quota) : null;
  const uploader = client
    ? new TranscriptUploader({
        db, deviceId: device.id, claudeDir, client, key: fileKey, state: syncState,
        isPaused,
        onError: (p, m) => console.error('[upload]', p, m),
      })
    : null;
  const configSync = client
    ? new ClaudeConfigSync({
        db, deviceId: device.id, deviceName: device.name, claudeDir, home, client, key: fileKey, state: syncState,
        // 切っているときと一時停止のあいだは押し出さない。fs.watch からの push もここを通る。
        enabled: () => configSyncActive({ syncClaudeConfig: settings.syncClaudeConfig, paused: isPaused() }), onToast: toast,
      })
    : null;
  const puller = client
    ? new RemotePuller({
        db, deviceId: device.id, home, client, key: fileKey, state: syncState,
        onConfigEntries: async (entries: FileEntry[]) => { await configSync?.applyPull(entries); },
        // 鳴るのは 1 回目と諦めたときだけなので、そのままトーストに出してよい。
        // 見逃した利用者のために、諦めた項目は同期の状態（syncSkipped）にも残る。
        onError: (k, m) => { console.error('[pull]', k, m); toast('error', `本文を降ろせませんでした（${k}）: ${m}`); },
      })
    : null;

  const indexer = new IndexerService({
    db, deviceId: device.id, claudeDir,
    isRunning: (id) => registry.current().some((l) => l.sessionId === id),
    // 他端末から降ろした本文も索引化の対象にする。譲ったセッションは相手が持ち主なので見ない。
    remoteRoot: remoteRoot(home),
    isYielded: (uuid) => syncState.isYielded(uuid),
  });

  // 起動の途中かどうか。最初の全走査では未分類のセッションを数えきれないほど流すので、知らせるのは起動後だけにする。
  let started = false;
  // 未分類だと知らせたセッション。本文が伸びるたびに同じ知らせを出さないために持つ。
  const toldUnassigned = new Set<string>();
  /**
   * どのルートの配下でもない cwd のセッションは「未分類」に残る（設計どおり）。
   * ただし黙って残ると利用者は気付けないので、セッションごとに 1 度だけ知らせる。
   * ここで勝手にプロジェクトを作ることはしない。紐づけは利用者が決める。
   */
  const tellUnassigned = (sessionId: string, cwd: string): void => {
    if (!started || toldUnassigned.has(sessionId)) return;
    toldUnassigned.add(sessionId);
    hub.broadcast({ type: 'toast', level: 'info', message: `どのプロジェクトにも属さないセッションが現れました（${cwd}）。未分類のまま置いてあります` });
  };

  indexer.on({
    progress: (p) => hub.broadcast({ type: 'index.progress', progress: p }),
    sessionChanged: (e) => {
      // 手元のファイルだけを上げる。他端末の写し（deviceId が入っているもの）は持ち主が上げる。
      if (e.deviceId === null) uploader?.noteChanged({ path: e.path, sessionId: e.providerSessionId, agentId: e.agentId });
      // 起動後に現れたセッションは project_id が空のままなので、ここで紐づけてから配る。
      const row = db.prepare('select project_id from sessions where id = ?').get(e.sessionId) as { project_id: string | null } | undefined;
      const assigned = row && row.project_id === null ? assignSession(db, device.id, e.sessionId) : null;
      // ロックを出すために自端末の ID を渡す。
      const s = getSession(db, registry.current(), e.sessionId, { deviceId: device.id });
      if (!s) return;
      hub.broadcast({ type: 'session.upsert', session: s });
      if (assigned) {
        const p = getProject(db, device.id, registry.current(), assigned);
        if (p) hub.broadcast({ type: 'project.upsert', project: p });
      } else if (row && row.project_id === null) {
        tellUnassigned(e.sessionId, s.cwd);
      }
      if (e.appended > 0) hub.broadcast({ type: 'transcript.appended', sessionId: e.sessionId, count: e.appended });
      // 索引化が拾ったアーティファクトを配る。
      for (const a of listArtifacts(db, { ids: e.artifactIds })) hub.broadcast({ type: 'artifact.upsert', artifact: a });
    },
    error: (e) => console.error('[indexer]', e.path, e.message),
  });
  // 実行中だったセッションの id。出入りを見て土台の要約の状態を書き替えるために持つ。
  let liveIds = new Set<string>();
  const sessionIdOf = (providerSessionId: string): string | null =>
    (db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ?").get(providerSessionId) as { id: string } | undefined)?.id ?? null;
  registry.onChange((live) => {
    hub.broadcast({ type: 'live.update', live });
    // Claude の最後の書き込みは登録ファイルの削除より前に起きるので、索引の側では終了に気付けない。
    // 出入りしたセッションだけ、ここで土台の要約を書き直す。
    const now = new Set(live.map((l) => l.sessionId));
    const moved = [...new Set([...now, ...liveIds])].filter((id) => now.has(id) !== liveIds.has(id));
    liveIds = now;
    for (const providerSessionId of moved) {
      const sessionId = sessionIdOf(providerSessionId);
      if (!sessionId) continue;
      writeBaselineIfNeeded(db, sessionId, device.id, now.has(providerSessionId));
      const s = getSession(db, live, sessionId, { deviceId: device.id });
      if (s) hub.broadcast({ type: 'session.upsert', session: s });
    }
    for (const p of listProjects(db, device.id, live)) hub.broadcast({ type: 'project.upsert', project: p });
    // hangar が起こした run に Claude の pid を書き込むのはここだけである。
    runs.linkRegistry(live);
  });

  const host = opts.host ?? '127.0.0.1';
  // 実際のポート番号は listen するまで決まらない（port: 0 のとき）。
  // MCP の URL と run の起動はその番号を使うので、先に listen してから app を組み立てて差し込む。
  let handler: Fetch | null = null;
  const serving: Fetch = (req, env, ctx) => (handler ? handler(req, env, ctx) : new Response('starting', { status: 503 }));
  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = serve({ fetch: serving, port: opts.port ?? 4177, hostname: host }, () => resolve(s as http.Server)) as http.Server;
    s.once('error', reject);
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : opts.port ?? 4177;

  const tmuxOf = (s: Settings): Tmux | null => (s.tmuxPath ? new Tmux({ tmuxPath: s.tmuxPath }) : null);
  const runs = new RunManager({
    db, deviceId: device.id, home, tmux: tmuxOf(settings), port, token,
    claudeBin: process.env.HANGAR_CLAUDE_BIN ?? 'claude',
    // 起動に失敗した run の後始末で、本文の jsonl があるかを実体で確かめるために要る。
    claudeDir,
    // hangar の外で動いている Claude を再開すると二重起動になるので、レジストリを見て弾く。
    isLive: (providerSessionId) => registry.current().some((l) => l.sessionId === providerSessionId),
  });
  const usage = new UsageTracker(db);
  const memos = new MemoStore({ db, deviceId: device.id, home });
  const claudeBin = process.env.HANGAR_CLAUDE_BIN ?? which('claude');
  // Claude への切り替えの件数はプロセスの寿命で数えるので、要約器はここで 1 度だけ作り、
  // 設定の変更は列の組み立てで反映する。毎回作り直すと 1 時間の窓が空になる。
  const claudeSummarizer = () => new ClaudeHeadlessSummarizer({ claudeBin, hourlyCap: settings.summaryHourlyCap, usage: () => usage.current() });
  let claude = claudeSummarizer();
  const summarizers = (): Summarizer[] => {
    const list: Summarizer[] = [new LmStudioSummarizer({ baseUrl: settings.lmStudioUrl, model: settings.lmStudioModel })];
    if (settings.summaryFallback) list.push(claude);
    return list;
  };
  const summary = new SummaryJob({ db, deviceId: device.id, summarizers, live: () => registry.current(), hub });

  // 終了した run の Claude のタブには繋がせない。attachTarget がその判断を持つ。
  const relay = new PtyRelay({ token, port, tmux: tmuxOf(settings), resolveTab: (id) => runs.attachTarget(id)?.tmuxName ?? null, spawn: nodePtySpawn });

  runs.on({
    runStarted: (r) => {
      hub.broadcast({ type: 'run.started', run: r.run, tabs: r.tabs });
      const s = getSession(db, registry.current(), r.sessionId, { deviceId: device.id });
      if (s) hub.broadcast({ type: 'session.upsert', session: s });
    },
    runUpdated: (run) => hub.broadcast({ type: 'run.upsert', run }),
    // run が終わったときは事後要約の契機になる。受け付けの可否は SummaryJob が決める。
    runEnded: (run) => { hub.broadcast({ type: 'run.ended', run }); summary.enqueue(run.sessionId, RUN_ENDED_SUMMARY_OPTS); },
    tabChanged: (tab) => hub.broadcast({ type: 'tab.upsert', tab }),
  });

  /**
   * ファイルの取り込みを頼む。
   * 重なりは RemotePuller が自分の鎖で防ぐので、ここでは頼むだけでよい。
   */
  const pullFiles = (): void => {
    // 一時停止のあいだは降ろしにも行かない。止めた意味が無くなる。
    if (isPaused()) return;
    void puller?.pullNow().catch((e: unknown) => console.error('[files]', e instanceof Error ? e.message : e));
  };

  // 同期のイベントを hub に流す。pull で入れ替わった行は、そのまま画面に届ける。
  engine.on({
    status: (s) => hub.broadcast({ type: 'sync.status', status: s }),
    toast: (level, message) => toast(level, message),
    applied: (c) => {
      hub.broadcast({ type: 'sync.applied', table: c.tableName, rowId: c.rowId });
      if (c.tableName === 'sessions' || c.tableName === 'runs' || c.tableName === 'session_summaries') {
        const sessionId = c.tableName === 'runs'
          ? (db.prepare('select session_id s from runs where id = ?').get(c.rowId) as { s: string } | undefined)?.s ?? null
          : c.rowId;
        const s = sessionId ? getSession(db, registry.current(), sessionId, { deviceId: device.id }) : null;
        if (s) hub.broadcast({ type: 'session.upsert', session: s });
      }
      if (c.tableName === 'projects' || c.tableName === 'project_roots') {
        for (const p of listProjects(db, device.id, registry.current())) hub.broadcast({ type: 'project.upsert', project: p });
      }
      if (c.tableName === 'devices') hub.broadcast({ type: 'devices.update', devices: listDevices(db, device.id) });
    },
    // メタデータの pull の後に、ファイルの新着を取りに行く。
    pulled: () => { pullFiles(); },
  });

  /** 他端末の本文を手元に写してから再開する。~/.claude への本文の書き込みはここだけを通る。 */
  const resumeHere = (sessionId: string, overwrite: boolean): LaunchResultDto | ResumeHereConflictDto => {
    const r = copyTranscriptForResume({ db, home, claudeDir, sessionId, overwrite });
    if (r.kind === 'ask') return { error: 'local_smaller', localSize: r.localSize, remoteSize: r.remoteSize };
    if (r.kind === 'none') throw new RunError(400, 'このセッションの本文がありません');
    // 控えを取った回だけ刈る。控えはもうファイルになっているので、ここで転んでも書き戻しには響かない。
    if (r.kind === 'copied' && r.backedUp !== null) pruneBackups('transcripts');
    return runs.resume(sessionId);
  };

  // RunManager.on は listener を足せるので、上の登録はそのまま残して 2 つ目として足す。
  runs.on({
    runEnded: (r) => {
      const uuid = (db.prepare('select provider_session_id p from sessions where id = ?').get(r.sessionId) as { p: string } | undefined)?.p;
      if (!uuid) return;
      // 終了の直後に 1 回。Claude は終わる直前まで書き足すので、少し置いてもう 1 回上げ直す。
      void uploader?.flushSession(uuid);
      const again = setTimeout(() => { void uploader?.flushSession(uuid); }, FLUSH_AGAIN_MS);
      again.unref();
    },
  });

  // 設定は書き替わるので、外部連携は呼ばれた時点の settings を読む。
  const external: ExternalApi = {
    openTerminal: ({ tmuxName }) => {
      if (!settings.tmuxPath) throw new Error('tmux が見つかりません。Settings で tmuxPath を設定してください');
      return openInTerminalApp({ home, tmuxPath: settings.tmuxPath, tmuxName, app: settings.terminalApp });
    },
    openDirTerminal: ({ dir }) => openDirInTerminalApp({ home, dir, app: settings.terminalApp }),
    openEditor: ({ target }) => openInEditor({ codePath: settings.codePath, target }),
    openUrl: (url) => new Promise<void>((resolve, reject) => execFile('open', [url], (err) => (err ? reject(err) : resolve()))),
  };

  // 配布版（Tauri のバンドル）では UI の置き場所を環境変数で受ける。
  // 無ければリポジトリ内の packages/ui/dist を使う。
  const uiDist = opts.uiDist ?? process.env.HANGAR_UI_DIST ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui/dist');
  const app = createApp({
    db, deviceId: device.id, deviceName: device.name, token, home, port, version: VERSION,
    settings: () => settings,
    updateSettings: (patch) => {
      const wasSyncingConfig = settings.syncClaudeConfig;
      settings = { ...settings, ...patch };
      saveSettings(home, settings);
      // 設定の同期を切ったら、取り込みの確認も降ろす。
      // configPullConfirmed は sync_state に残るので、降ろさないと入れ直したときに確認が出ない。
      // ~/.claude を書き換える同期なので、入れるたびに改めて確認を取る（決定 2）。
      if (wasSyncingConfig && !settings.syncClaudeConfig) configSync?.unconfirm();
      // tmuxPath が変われば、これから起こす run も新しい attach も新しいパスを使う。
      const t = tmuxOf(settings);
      runs.setTmux(t);
      relay.setTmux(t);
      // 上限だけは要約器が内側に持つので、変わったときに作り直す。
      if (patch.summaryHourlyCap !== undefined) claude = claudeSummarizer();
      // Claude Code 設定の同期の入り切りは、ヘッダと Settings の表示に載せる。
      engine.setClaudeConfigStatus({ enabled: settings.syncClaudeConfig, confirmed: syncState.get('configPullConfirmed') === '1' });
      return settings;
    },
    live: () => registry.current(), indexer, hub, runs, external, usage, memos,
    summary: {
      enqueue: (id, opts) => summary.enqueue(id, opts),
      pending: () => summary.pending(),
      test: () => summary.test(),
      // 一覧は設定のモデルに依らないので、その場限りの問い合わせ用に作る。
      listModels: () => new LmStudioSummarizer({ baseUrl: settings.lmStudioUrl, model: null }).listModels(),
    },
    promote: (o) => promoteSession({
      db, deviceId: device.id, home, workspaceRoot: settings.workspaceRoot,
      // hangar の run だけでなく、hangar の外で動いている Claude も「実行中」と見なす。
      runAlive: (id) => {
        if (aliveRunForSession(db, id) !== null) return true;
        const s = db.prepare('select provider_session_id p from sessions where id = ?').get(id) as { p: string } | undefined;
        return !!s && registry.current().some((l) => l.sessionId === s.p);
      },
    }, o),
    sync: engine,
    // 降ろすのを諦めた項目。onError は 1 度しか鳴らないので、状態にも載せて後から見られるようにする。
    syncSkipped: () => puller?.skippedEntries() ?? [],
    resumeHere,
    // ClaudeConfigSync に pull() は無いので、確認を立ててから applyPull(pendingRemote()) を呼ぶ形に包む。
    configSync: configSync ? { preview: () => configSync.preview(), pull: async () => { const entries = configSync.pendingRemote(); configSync.confirm(); return configSync.applyPull(entries); } } : null,
    // 参加トークンは全セッションの読み書き権を持つ。作るのはここだけで、ログにも例外にも出さない。
    joinToken: () => (cloud ? encodeJoinToken({ url: cloud.url, secret: cloud.joinSecret }) : null),
    devices: () => listDevices(db, device.id),
    uiDist,
  });
  handler = app.fetch;

  hub.attach(server, { path: '/ws', token, port });
  relay.attach(server, '/ws/pty');
  // 経路を握る側は path が違えば黙って返すので、最後に未知の経路を切る番人を置く。
  // upgrade を受けた時点でこの接続は HTTP 側の管理から外れるため、誰も引き取らないと相手が待ち続ける。
  server.on('upgrade', (req, socket) => {
    if (!WS_PATHS.has(new URL(req.url ?? '/', 'http://x').pathname)) socket.destroy();
  });

  registry.start();
  liveIds = new Set(registry.current().map((l) => l.sessionId));
  await indexer.start();
  syncProjectsFromWorkspace(db, device.id, settings.workspaceRoot);
  assignSessions(db, device.id);
  ensureScratchProject(db, device.id, home);
  // メモは DB とファイルの両方にある。起動時に食い違いを直し、以後はファイルの外部編集を監視で取り込む。
  for (const m of memos.reconcileAll()) hub.broadcast({ type: 'memo.update', memo: m });
  const stopMemoWatch = memos.watch((m) => {
    hub.broadcast({ type: 'memo.update', memo: m });
    const p = listProjects(db, device.id, registry.current()).find((x) => x.id === m.projectId);
    if (p) hub.broadcast({ type: 'project.upsert', project: p });
  });
  const checkRootsNow = () => checkRoots({ db, deviceId: device.id, live: () => registry.current(), broadcast: (ev) => hub.broadcast(ev) });
  checkRootsNow();
  const rootTimer = setInterval(checkRootsNow, ROOT_CHECK_MS);
  rootTimer.unref();
  // 前回の終了時に生きていた run のうち、tmux セッションが残っていないものを lost で閉じる。
  const lost = runs.recoverAtStartup();
  if (lost.length) console.log(`[runs] tmux セッションの無い run を ${lost.length} 件 lost で閉じました`);
  runs.startPolling(RUN_POLL_MS);
  // ここまでで既存のセッションの紐づけは済んでいる。以後に現れた未分類だけを知らせる。
  started = true;

  /** 自端末の生存を devices に刻む。他端末の Settings の一覧と、ロックの端末名がここから出る。 */
  const touchDevice = (): void => {
    const row = db.prepare('select * from devices where id = ?').get(device.id) as Record<string, unknown> | undefined;
    upsertShared(db, 'devices', { ...(row ?? {}), id: device.id, name: device.name, platform: device.platform, last_seen_at: Date.now(), deleted_at: null }, device.id);
    hub.broadcast({ type: 'devices.update', devices: listDevices(db, device.id) });
  };
  touchDevice();
  const deviceTimer = setInterval(touchDevice, DEVICE_TOUCH_MS);
  deviceTimer.unref();

  engine.setClaudeConfigStatus({ enabled: settings.syncClaudeConfig, confirmed: syncState.get('configPullConfirmed') === '1' });
  // 最初の同期の完了を待たない。
  // クラウドが応答しないと push と pull がそれぞれ 30 秒待つので、待つと startServer の解決が 90 秒遅れる。
  // その間 /health は 200 を返しているので、準備完了だと見た相手からの SIGTERM が受け口の無い時刻に届く。
  // 走り出した push と pull は engine.idle() が掴んでいるので、close() は取りこぼさない。
  void engine.start().catch((e: unknown) => console.error('[sync]', e instanceof Error ? e.message : e));
  pullFiles();
  configSync?.start();
  // 監視だけに頼らず、定期の push も足しておく。
  // 監視が張れない置き場所や、取りこぼした編集があっても、次の周期で揃う。
  // ここには以前「fs.watch の recursive は Linux では効かない」と書いてあったが、
  // Node 22 では Linux でも効くことを容器で確かめたので直した。
  // 一時停止のあいだは押し出さない（pushChanged 自身も enabled() で同じ判定を通る）。
  const configTimer = configSync
    ? setInterval(() => {
        if (isPaused()) return;
        void configSync.pushChanged().catch((e: unknown) => console.error('[config]', e instanceof Error ? e.message : e));
      }, CONFIG_PUSH_MS)
    : null;
  configTimer?.unref();
  /**
   * 索引が済んでいるのにまだ上がっていない本文を拾い直す。
   * 起動で 1 度と、そのあとは一定間隔で回す。
   * 1 回に積む数は uploader が抑えるので、初回の一括でも少しずつ流れる。
   */
  const sweepUploads = (): void => {
    if (!uploader) return;
    try { uploader.sweep(); } catch (e) { console.error('[upload]', e instanceof Error ? e.message : e); }
  };
  sweepUploads();
  // 起動のときにも 1 度刈る。
  // 控えを作る経路を通らないまま動かし続けた端末や、この刈り込みが入る前から溜めていた端末も、ここで揃う。
  pruneBackups('transcripts');
  pruneBackups('memos');
  const uploadTimer = uploader ? setInterval(sweepUploads, UPLOAD_SWEEP_MS) : null;
  uploadTimer?.unref();

  console.log(`agent-hangar listening on http://${host}:${port}${settings.tmuxPath ? '' : '（tmux が見つからないため起動は使えません）'}`);
  return {
    port,
    close: async () => {
      // 待ちの上限は 1 本の締め切りで持つ。
      // 段ごとに数えると和が番犬の上限を超え、db.close() まで届かない（レビューの指摘 2）。
      const deadline = Date.now() + CLOSE_DEADLINE_MS;
      const left = (): number => Math.max(0, deadline - Date.now());
      clearInterval(rootTimer);
      clearInterval(deviceTimer);
      if (configTimer) clearInterval(configTimer);
      if (uploadTimer) clearInterval(uploadTimer);
      // 走っている押し出しを待ってから止める。待たずに止めると putFile と pushChanges が途中で切れる。
      await stopAfterIdle(configSync, 'config', left());
      await stopUploader(uploader, left());
      await stopAfterIdle(engine, 'sync', left());
      // 降ろしも同じ作法で、走っているものを待ってから止める。
      // engine を先に止めてあるので、pulled の合図で新しい降ろしが積まれることはもう無い。
      // 待ち切れなくても必ず止める。降ろしは一時ファイルに書いてから置き換えるので、切れても半端は残らない。
      await stopAfterIdle(puller, 'files', left());
      stopMemoWatch();
      runs.stop();
      indexer.stop();
      registry.stop();
      relay.close();
      // WebSocket を先に畳み、残った keep-alive の接続を切ってから listen を閉じる。
      // この順でないと server.close が開いたままの接続を待ち続ける。
      await hub.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      // 走っている要約は DB に書き込む。閉じた DB に触れさせないよう、ここで待ち切ってから閉じる。
      // 新しい受け付けは HTTP も run の終了も止まった後なので、待ち行列はもう増えない。
      const summaryWait = left();
      if (!(await waitForSummaryIdle(summary, summaryWait))) {
        console.warn(`[summary] 要約の終了を ${summaryWait} ミリ秒待ちましたが終わらないので、待たずに閉じます`);
      }
      db.close();
    },
  };
}
