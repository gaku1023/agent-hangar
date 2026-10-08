import { serve } from '@hono/node-server';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listArtifacts } from './artifacts/queries.ts';
import { backupsRoot, readCloudConfig, remoteRoot } from './config/cloud.ts';
import { dbPath, defaultClaudeDir, ensureHome, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings, type Settings } from './config/paths.ts';
import { ensureShellScript, shellHookLine, shellHookState, shellInstallCommand, shellWrapSupported, zshrcPath } from './config/shellHook.ts';
import { claudeJsonPath } from './config/claudeJson.ts';
import { createReadiness, ToolVersions } from './config/readiness.ts';
import { defaultManagedDir, RetentionService } from './config/retention.ts';
import { ensureStatuslineHeaderFile } from './config/statusline.ts';
import { resolveToolPaths, which } from './config/tools.ts';
import { encodeJoinToken, PRIMARY_ACCOUNT_ID, type FileEntry, type FileMetaIn, type LaunchResultDto, type LiveSessionDto, type ResumeHereConflictDto, type ServerEvent, type ShellHookDto, type SyncSkippedDto, type SyncStatusDto } from '@agent-hangar/shared';
import { openDb, type Db } from './db/open.ts';
import { accountOfSession, getProject, getSession, listDevices, listProjects } from './db/queries.ts';
import { upsertShared } from './db/shared.ts';
import { openDirInTerminalApp, openInEditor, openInTerminalApp } from './external/open.ts';
import { announceAccountsOnRunStarted, buildAccountsDto, type AccountsDeps } from './http/accounts.ts';
import { createApp, type ExternalApi } from './http/app.ts';
import { writeBaselineIfNeeded } from './indexer/baseline.ts';
import { IndexerService } from './indexer/service.ts';
import { ensureWrapperScript } from './launch/wrapper.ts';
import { MemoStore } from './projects/memo.ts';
import { promoteSession } from './projects/promote.ts';
import { assignSession, assignSessions, checkProjectRoots, registerWorkspaceChildOf, syncProjectsFromWorkspace } from './projects/registry.ts';
import { ensureScratchProject } from './projects/scratch.ts';
import { readRegistry, RegistryWatcher } from './provider/claude-code/registry.ts';
import { BUILTIN_SUBCOMMANDS, readClaudeHelp, subcommandsFromHelp } from './provider/claude-code/compat/cli.ts';
import { ClaudeDirWatch } from './provider/claude-code/compat/claudeDir.ts';
import { CompatLog, compatPath } from './provider/claude-code/compat/log.ts';
import type { Drift } from './provider/claude-code/compat/types.ts';
import { VERIFIED_CLAUDE_VERSION } from './provider/claude-code/compat/version.ts';
import { AsideReader } from './live/aside.ts';
import { ensureSpawnHelper } from './pty/helper.ts';
import { nodePtySpawn } from './pty/nodePty.ts';
import { PtyRelay } from './pty/relay.ts';
import { AccountAuth } from './config/accountAuth.ts';
import { AccountStore } from './config/accounts.ts';
import { RunError, RunManager } from './runs/manager.ts';
import { aliveRunForSession } from './runs/queries.ts';
import { ParkWatch, parkedSessionIds, statusChanged } from './sessions/park.ts';
import { processStartOfPrompt } from './sessions/promptProcess.ts';
import { ClaudeHeadlessSummarizer } from './summary/claude.ts';
import { SummaryJob } from './summary/job.ts';
import { LmStudioSummarizer } from './summary/lmstudio.ts';
import type { Summarizer } from './summary/types.ts';
import { sessionIdOfChange, writeMemoConflictCopy, type SessionMemoBackup } from './sync/apply.ts';
import { BACKUP_GENERATIONS, ClaudeConfigSync } from './sync/claudeConfig.ts';
import { HttpCloudClient, type CloudClient } from './sync/client.ts';
import { copyTranscriptForResume } from './sync/copy.ts';
import { deriveFileKey } from './sync/crypto.ts';
import { SyncEngine } from './sync/engine.ts';
import { PausedPass } from './sync/pausedPass.ts';
import { RemotePuller } from './sync/puller.ts';
import { D1_WRITES_PER_DEVICE_TOUCH, D1_WRITES_PER_METER_NOTE, type QuotaCounter } from './sync/quota.ts';
import { SyncStateStore } from './sync/state.ts';
import { markTranscriptsFrom } from './sync/transcriptsFrom.ts';
import { TranscriptUploader } from './sync/uploader.ts';
import { CloudUsagePoller } from './sync/usage.ts';
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
/** 一時停止のまま頼まれた 1 巡の最中に、進み（未送信の件数）を画面へ配る間隔。手元の DB を数えるだけで、外とは話さない。 */
const PASS_TICK_MS = 1_000;
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
 * これに Worker の台帳の 1 文（`D1_WRITES_PER_METER_NOTE`）が乗る。
 */
export const D1_WRITES_PER_FILE_PUT =
  (1 + FILES_INDEXES) + (1 + FILES_INDEXES + D1_WRITES_PER_AUTOINCREMENT) + D1_WRITES_PER_DEVICE_TOUCH + D1_WRITES_PER_METER_NOTE;
/**
 * `DELETE /files/<鍵>` が D1 に書く行数。
 * `files` から 1 行消すだけである（同 272 行）。本体 1 行と索引 2 行で 3 行になる。
 * `devices` は触らず、`sqlite_sequence` は delete では動かない。
 * R2 の削除は D1 に書かないが、Worker の台帳の 1 文は乗る。
 */
export const D1_WRITES_PER_FILE_DELETE = 1 + FILES_INDEXES + D1_WRITES_PER_METER_NOTE;

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
    // 使用量は読むだけで、D1 には 1 行も書かない（Worker の /usage は認証の検査で読むだけ）。
    usage: () => note(0, inner.usage()),
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
 * 利用者が「今すぐ同期」で頼んだ 1 巡の最中は、呼び手が paused を false にして渡す（startServer の isPaused）。
 * `ClaudeConfigSync` は `enabled()` しか見ないので、判定はこちらで組み立てて渡す。
 */
export function configSyncActive(o: { syncClaudeConfig: boolean; paused: boolean }): boolean {
  return o.syncClaudeConfig && !o.paused;
}

/**
 * 本文と設定の出し入れ、他端末の本文の取り込み、使用量の取りに行きを止めるか。
 * 互換の版で止まっているときは、利用者が頼んだ 1 巡の最中でも止める（その 1 巡のメタデータの送受信が先に試し直し、まだ合わなければまた止まっている）。
 * 一時停止のあいだは止めるが、利用者が「今すぐ同期」で頼んだ 1 巡の最中だけは通す（PausedPass）。
 */
export function syncHalted(o: { paused: boolean; oncePass: boolean; compatBlocked: boolean }): boolean {
  return o.compatBlocked || (o.paused && !o.oncePass);
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
export function pruneBackupFiles(root: string, kind: string, keep: number): number {
  // 控えを全部消す刈り込みは作らない。
  const limit = Math.max(1, keep);
  // 入れ物そのものがリンクだと、readdir がリンクの先を開き、rm がその先のファイルを消す。
  // 控えを書く側（copy.ts の resolveUnder）はリンクを 1 区切りも辿らない決まりなので、消す側も揃える。
  if (kind === '' || kind === '.' || kind === '..' || kind.includes('/')) throw new Error('控えの種類の形が不正です');
  const dir = path.join(root, kind);
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) return 0;
  if (st.isSymbolicLink()) throw new Error(`backups/${kind} がシンボリックリンクなので刈りません`);
  if (!st.isDirectory()) throw new Error(`backups/${kind} がディレクトリではありません`);
  let names: string[];
  try {
    // ここでのリンクは読み飛ばす。控えとして置いた覚えのないものを消さない。
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
    log?: (line: string) => void;
  } = {},
): (reason?: string) => void {
  const on = o.on ?? ((signal, handler) => { process.on(signal, handler); });
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const setTimer = o.setTimeout ?? setTimeout;
  const watchdogMs = o.watchdogMs ?? STOP_WATCHDOG_MS;
  const log = o.log ?? ((line: string) => console.log(line));
  let stopping = false;
  // 何で止まったかを 1 行残す。.app が起動から数秒で終わる件を、ログだけで切り分けられるようにする。
  const stop = (reason = 'stop'): void => {
    if (stopping) return;
    stopping = true;
    log(`[shutdown] ${reason}`);
    // 後始末が終わらなくても必ず降りる。
    // unref してあるので、これ 1 本だけのためにイベントループは生き延びない。
    const timer = setTimer(() => exit(0), watchdogMs);
    (timer as { unref?: () => void }).unref?.();
    // 起動の途中なら、起動が終わってから閉じる。起動そのものが転んだ回は閉じるものが無い。
    void startup.then((s) => s.close(), () => undefined).catch(() => undefined).finally(() => exit(0));
  };
  on('SIGINT', () => stop('SIGINT'));
  on('SIGTERM', () => stop('SIGTERM'));
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
  /**
   * Claude の登録のうち、消えたプロセスの残りと見る pid。既定は OS で決める（provider/claude-code/registry.ts の goneOn）。
   * テストの見本の登録は実在しない pid を持つので、テストは「残りは無い」を渡す。
   */
  registryIsGone?: (pid: number) => boolean;
};

/**
 * DB、索引、実行中セッションの監視、run の管理、HTTP と WebSocket をまとめて起動する。
 * ~/.claude は原則として読むだけで、書き込みは home 配下に限る（例外は docs/design.md の「読み取り専用」にある 4 つ）。
 */
export async function startServer(opts: StartOptions = {}): Promise<{ close(): Promise<void>; port: number }> {
  const bootAt = performance.now();
  const home = opts.home ?? hangarHome();
  ensureHome(home);
  const token = readOrCreateToken(home);
  // statusline が curl に読ませるヘッダのファイルは、トークンと同じところで用意する。
  // install のときにしか置かないと、置き場を消した利用者の使用量が何も言わずに止まる。
  ensureStatuslineHeaderFile(home, token);
  const device = readOrCreateDevice(home);
  // tmux、code、claude のパスが設定に無ければここで探して書き戻す。GUI 起動の貧弱な PATH でも見つけられる。
  let settings: Settings = resolveToolPaths(loadSettings(home));
  saveSettings(home, settings);
  ensureWrapperScript(home);
  const fixed = ensureSpawnHelper();
  if (fixed.length) console.log('[pty] spawn-helper に実行権限を付けました:', fixed.join(', '));

  const claudeDir = opts.claudeDir ?? (settings.claudeDir || defaultClaudeDir());
  const db = openDb(dbPath(home));
  const hub = new EventHub(VERSION);
  // 閉じたかどうか。閉じた後に届いた裏の読み取り（claude --help と --version）が、消えた置き場に書かないようにする。
  let closed = false;
  // Claude Code の形式のずれの記録（provider/claude-code/compat/）。端末ごとのファイルで、同期しない。
  // 手元の claude の版は listen の後に裏で読む。読めるまでは、版の無いずれを null で記録する。
  let claudeVersion: string | null = null;
  const compatLog = new CompatLog({ file: compatPath(home), localVersion: () => claudeVersion });
  compatLog.start();
  // 裏でサブエージェントだけが動いているものに、読み直しのたびに印を足す（live/aside.ts）。
  const aside = new AsideReader(db);
  const registry = new RegistryWatcher(claudeDir, undefined, opts.registryIsGone, (live) => aside.apply(live, Date.now()), compatLog);

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
  // 本文をどこから上げるかの床が無ければ、ここで刻む。
  // 本筋は CLI の側で、setup cloud と join が cloud.json を書くのと同じ時点で刻んでいる。
  // ここは、cloud.json はあるのに DB に床の行が無い端末のための保険で、古い版のための分岐ではない。
  // 古い版の CLI で参加した端末のほか、DB を作り直した端末や、cloud.json だけを写した試しの HANGAR_HOME もこれに当たる。
  // 床の行が無いまま走ると 0（床なし）と読み、手元の本文を全部上げてしまう。
  // 床には cloud.json の joinedAt を使い、読めないときは今の時刻にする（0 を刻むと床なしになる）。
  // joinedAt は参加し直しと秘密の作り直しで今の時刻へ書き換わるが、床が無いときにしか読まないので、書き換わった値が使われるのは床の行が無い端末に限られる。
  // 以後、本文の取り残しの走査はこの時刻より後に動いた転記だけを拾う（sync/transcriptsFrom.ts）。
  // メタデータの同期はこの刻みを見ないので、今までどおり全部が揃う。
  if (cloud) markTranscriptsFrom(syncState, cloud.joinedAt > 0 ? cloud.joinedAt : Date.now());
  /**
   * 同期が止まっているか。利用者が押した一時停止も、枠の 80% で自分から止まった分もここに出る。
   * 止まっていても、利用者が「今すぐ同期」で頼んだ 1 巡の最中だけは止まっていないと答える（pausedPass）。
   * 互換の版が合わずに止まっているときも止まっていると答える（1 巡の最中でも）。
   * 本文と設定の出し入れはどれもここを見るので、その 1 巡だけ通る。
   */
  const isPaused = (): boolean => syncHalted({ paused: engine.status().state === 'paused', oncePass: pausedPass.active(), compatBlocked: engine.compatBlocked() });
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
    try { pruneBackupFiles(backupsRoot(home), kind, BACKUP_GENERATIONS); }
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
  // 設定の「使用量と費用」。数える client を通すので、要求は無料枠の勘定に入る。
  const cloudUsage = new CloudUsagePoller({ client, quota: engine.quota, isPaused, broadcast: (usage) => hub.broadcast({ type: 'sync.usage', usage }) });
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
  // Claude Code の保持期間。値と使用量を持ち、変わったときだけ配る。書き込みは確認を経た PUT /api/retention からだけ来る。
  const retention = new RetentionService({ claudeDir, home, managedDir: defaultManagedDir(), broadcast: (r) => hub.broadcast({ type: 'retention.changed', retention: r }) });
  const puller = client
    ? new RemotePuller({
        db, deviceId: device.id, home, client, key: fileKey, state: syncState,
        onConfigEntries: async (entries: FileEntry[]) => { await configSync?.applyPull(entries); },
        // 鳴るのは 1 回目と諦めたときだけなので、そのままトーストに出してよい。
        // 見逃した利用者のために、諦めた項目は同期の状態（syncSkipped）にも残る。
        onError: (k, m) => { console.error('[pull]', k, m); toast('error', `本文を降ろせませんでした（${k}）: ${m}`); },
      })
    : null;

  /** 1 段ずつ失敗を畳む。繋がらない段があっても、残りの段は試す。 */
  const passStep = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    try { await work(); } catch (e) { console.error(`[${label}]`, e instanceof Error ? e.message : e); }
  };
  /**
   * 一時停止のまま「今すぐ同期」を押したときの 1 巡。
   * メタデータの送受信、他端末の本文と設定の受け取り、設定の押し出し、取り残した本文の全部、の順に回す。
   * 本文は走査の上限（1 回 20 件）を外して上げきる。次の走査は止まっていて来ないからである。
   * 上げ直しの間隔（10 分）は外さないので、続けて押しても同じ本文を運び直さない。
   * 終わりに使用量を取り直す。止まっている間は取りに行かないので、押した分の枠がここでしか見えない。
   */
  const pausedPass = new PausedPass({
    metadata: () => engine.syncNow({ evenIfPaused: true }),
    rest: async () => {
      // 版で断られた後は本文の降ろしにも行かない（1 巡の最中でも isPaused は版の止まりで真になる）。
      await passStep('files', async () => { if (!isPaused()) await puller?.pullNow(); });
      await passStep('config', async () => { await configSync?.pushChanged(); });
      await passStep('upload', async () => { if (uploader) { uploader.sweep(Infinity); await uploader.idle(); } });
      await passStep('usage', () => cloudUsage.refresh());
    },
    done: () => {
      // 件数は 1 巡で動いているが、状態は paused のままなのでエンジンは配り直さない。ここで配る。
      // 進みを配っていたタイマーも、ここで止める。
      if (passTicker) { clearInterval(passTicker); passTicker = null; }
      const status = engine.status();
      const sweepPending = syncSweep();
      broadcastSync(status);
      // 版で断られた 1 巡は何も同期していない。成功や残りの件数の知らせは出さず、同期の状態と同じ版の文で知らせる。
      if (engine.compatBlocked()) {
        toast('error', status.error ?? 'クラウドと互換の版が合わないので、同期できませんでした');
        return;
      }
      // 一時停止の間は状態が paused に隠れて失敗が画面に出ないので、残りの件数で伝える。
      const left = [status.pending > 0 ? `未送信 ${status.pending} 件` : null, (sweepPending ?? 0) > 0 ? `未送信の本文 ${sweepPending} 件` : null].filter((t) => t !== null);
      if (left.length > 0) toast('error', `1 回だけ同期しましたが、${left.join('、')}が残りました。同期は一時停止のままです`);
      else toast('info', '1 回だけ同期しました。同期は一時停止のままです');
    },
  });
  /**
   * 1 巡の最中に、進みを画面へ配るタイマー。
   * そのあいだも状態は paused のままで、エンジンは送信中や受信中を名乗らない。
   * 始まったこと（oncePass）と、減っていく未送信の件数を、ここから配る。
   */
  let passTicker: ReturnType<typeof setInterval> | null = null;
  /** 利用者が押した「今すぐ同期」。止まっていれば 1 巡だけ通し、止まっていなければ今までどおり。 */
  const syncNow = (): Promise<void> => {
    // 一時停止しているかは、止めた印でも見る。版で止まっている間は、一時停止していても状態が error になるからである。
    // 印で見ないと、一時停止のまま版で止まった後の押下が 1 巡の道に回らず、何も送らない。
    const paused = engine.status().state === 'paused' || (engine.compatBlocked() && engine.state.get('paused') === '1');
    if (!paused) return engine.syncNow();
    const done = pausedPass.run();
    if (pausedPass.active() && !passTicker) {
      // 押した直後に 1 度配る。応答が返るのはメタデータの送受信の後なので、待たせるとボタンが効いていないように見える。
      broadcastSync(engine.status());
      passTicker = setInterval(() => { broadcastSync(engine.status()); }, PASS_TICK_MS);
      passTicker.unref();
    }
    return done;
  };

  const indexer = new IndexerService({
    db, deviceId: device.id, claudeDir,
    isRunning: (id) => registry.current().some((l) => l.sessionId === id),
    // 他端末から降ろした本文も索引化の対象にする。譲ったセッションは相手が持ち主なので見ない。
    remoteRoot: remoteRoot(home),
    isYielded: (uuid) => syncState.isYielded(uuid),
    // 状態を外すのは resume した後の発言だけである。発言を出したプロセスの起動時刻を、登録と runs から引く。
    processStartOf: (q) => processStartOfPrompt(db, device.id, registry.current(), q),
    // 手元の本文の行を見張る。手元の claude の版より古い行は昔の形として見ない。版が読めるまでは確かめた版を床にする。
    compat: { sink: compatLog, since: () => claudeVersion ?? VERIFIED_CLAUDE_VERSION },
  });

  // 起動の途中かどうか。最初の全走査では未分類のセッションを数えきれないほど流すので、知らせるのは起動後だけにする。
  let started = false;
  // 未分類だと知らせたセッション。本文が伸びるたびに同じ知らせを出さないために持つ。
  const toldUnassigned = new Set<string>();
  // その場の自動登録を試したセッション。本文が伸びるたびにディスクを見に行かないために持つ。
  const triedRegister = new Set<string>();
  /**
   * どのルートの配下でもない cwd のセッションは「未分類」に残る（設計どおり）。
   * ただし黙って残ると利用者は気付けないので、セッションごとに 1 度だけ知らせる。
   * ワークスペース直下のフォルダは、sessionChanged がその場でプロジェクトにするので、ここへ来るのはワークスペースの外だけである。
   * 外のフォルダで勝手にプロジェクトを作ることはしない。紐づけは利用者が決める。
   */
  const tellUnassigned = (sessionId: string, cwd: string): void => {
    if (!started || toldUnassigned.has(sessionId)) return;
    toldUnassigned.add(sessionId);
    hub.broadcast({ type: 'toast', level: 'info', message: `どのプロジェクトにも属さないセッションが現れました（${cwd}）。未分類のまま置いてあります` });
  };

  indexer.on({
    progress: (p) => hub.broadcast({ type: 'index.progress', progress: p }),
    // Claude Code が本文を消して索引を片付けた。hasTranscript が偽に変わったことを配る。
    transcriptGone: (e) => {
      const s = getSession(db, registry.current(), e.sessionId, { deviceId: device.id });
      if (s) hub.broadcast({ type: 'session.upsert', session: s });
    },
    sessionChanged: (e) => {
      // 手元のファイルだけを上げる。他端末の写し（deviceId が入っているもの）は持ち主が上げる。
      if (e.deviceId === null) uploader?.noteChanged({ path: e.path, sessionId: e.providerSessionId, agentId: e.agentId });
      // 起動後に現れたセッションは project_id が空のままなので、ここで紐づけてから配る。
      const row = db.prepare('select project_id from sessions where id = ?').get(e.sessionId) as { project_id: string | null } | undefined;
      let assigned = row && row.project_id === null ? assignSession(db, device.id, e.sessionId) : null;
      // 当たるルートが無ければ、ワークスペース直下の新しいフォルダかを見て、起動時と同じ規則でその場でプロジェクトにする。
      // 起動の途中は syncProjectsFromWorkspace が受け持つので行わない。同じセッションで何度も試さない。
      if (row && row.project_id === null && !assigned && started && !triedRegister.has(e.sessionId)) {
        triedRegister.add(e.sessionId);
        const cwd = (db.prepare('select cwd from sessions where id = ?').get(e.sessionId) as { cwd: string }).cwd;
        if (registerWorkspaceChildOf(db, device.id, settings.workspaceRoot, cwd)) assigned = assignSession(db, device.id, e.sessionId);
      }
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
  // 会話ごとの直前の動き。動きが変わった印付きのセッションを配り直すために持つ。
  let liveStatus = new Map<string, LiveSessionDto['status']>();
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
      // 終わったセッションの問いにはもう答えられない。
      // 行を残すと、再開した直後の要対応の札に前の run の問いが出てしまうので、問いだけを消す。
      if (!now.has(providerSessionId)) db.prepare('update session_activity set question = null where session_id = ?').run(sessionId);
      writeBaselineIfNeeded(db, sessionId, device.id, now.has(providerSessionId));
      const s = getSession(db, live, sessionId, { deviceId: device.id });
      if (s) hub.broadcast({ type: 'session.upsert', session: s });
    }
    // 区切りを付けたセッションは、動きが変わると実行中に数えるか（parked）も変わる。
    // UI は live.update から動きしか直せないので、印の付いたものだけ行ごと配り直す。
    for (const providerSessionId of statusChanged(liveStatus, live)) {
      const sessionId = sessionIdOf(providerSessionId);
      if (!sessionId) continue;
      // 動きが変わったら、休みの数え直しにする。
      parkWatch.reset(sessionId);
      const s = getSession(db, live, sessionId, { deviceId: device.id });
      if (s?.state?.status) hub.broadcast({ type: 'session.upsert', session: s });
    }
    liveStatus = new Map(live.map((l) => [l.sessionId, l.status]));
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
  // 待ち受けは起動の手続きより先に始まる。/health はこの時点から返るので、ここで一度知らせる。
  console.log(`agent-hangar listening on http://${host}:${port}${settings.tmuxPath ? '' : '（tmux が見つからないため起動は使えません）'}`);

  const tmuxOf = (s: Settings): Tmux | null => (s.tmuxPath ? new Tmux({ tmuxPath: s.tmuxPath }) : null);
  /**
   * claude の場所。run を起こす tmux のペインは hangar の PATH を継ぐので、
   * 裸の `claude` では .app から起こしたときに引けない（PATH は /usr/bin:/bin:/usr/sbin:/sbin だけになる）。
   * 起動と要約の両方が同じ絶対パスを使う。
   */
  const claudeBinOf = (s: Settings): string | null => process.env.HANGAR_CLAUDE_BIN ?? s.claudePath ?? which('claude');
  // 手元の claude の版。ずれの記録の既定の版と、GET /api/compat の手元の版に使う。同じファイルなら起こし直さない。
  const claudeVersions = new ToolVersions();
  // 裏で void で走らせるので、決して拒否しない（捕まらない拒否は Node ごと落とす）。
  // パスが普通のファイルの下を指すと stat が ENOTDIR で投げるので、読めないもの（null）として扱う。
  // 待つ間に閉じたか、claude のパスが変わったときは、遅れて届いた古い版で上書きしない。
  // 読めた版はずれの記録にも知らせる。版が変わっていれば記録が空になるので、1 度しか数えない元から数え直す。
  const refreshClaudeVersion = async (): Promise<string | null> => {
    const bin = claudeBinOf(settings);
    let v: string | null = null;
    try {
      v = bin ? await claudeVersions.get(bin, ['--version']) : null;
    } catch {
      v = null;
    }
    if (!closed && claudeBinOf(settings) === bin) {
      claudeVersion = v;
      if (compatLog.setLocalVersion(v)) renoteCompat(bin);
    }
    return v;
  };
  // 最後に claude --help から作り直したときのずれ。読んだ claude のパスと組で持つ。
  let lastSubcommandDrifts: { bin: string | null; drifts: readonly Drift[] } | null = null;
  /**
   * 版の変化でずれの記録を空にしたあと、1 度しか数えない元から数え直す。
   * 置き場の項目はサーバの寿命で 1 度、サブコマンドは --help を読んだときに 1 度、登録は登録が変わったときに 1 度しか数えないので、
   * ここで数え直さないと、次に起動し直すか登録が変わるまで一覧から消えたままになる。
   * トランスクリプトは新しい行を読むたびに数えるので、ここでは何もしない。
   * 呼ばれるのは版の読み取りを待った後なので、下で作る claudeDirWatch はもうできている。
   */
  const renoteCompat = (bin: string | null): void => {
    if (lastSubcommandDrifts && lastSubcommandDrifts.bin === bin) for (const d of lastSubcommandDrifts.drifts) compatLog.note(d);
    registry.renoteDrifts();
    claudeDirWatch.reset();
    claudeDirWatch.check();
  };
  // 包みがそのまま渡すサブコマンド。起動のたびと claude のパスを変えたときに claude --help から作り直す。
  let shellSubcommands: readonly string[] = BUILTIN_SUBCOMMANDS;
  // 同梱の hangar。アプリの中では server.mjs の隣の bin/hangar にある。リポジトリから動かすときは無い。
  const bundledHangar = ((): string | null => {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'hangar');
    return fs.existsSync(p) ? p : null;
  })();
  // 包み方の本体は hangar の版と揃える。~/.zshrc の 1 行はこのファイルを読むだけなので、更新はここで行き渡る。
  // 本体には実際に待ち受けているポートと tmux のパスを埋め込むので、listen の後に書き、tmux のパスが変われば書き直す。
  const writeShellScript = () => {
    try {
      ensureShellScript(home, { url: `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`, tokenFile: path.join(home, 'token'), tmuxPath: settings.tmuxPath, subcommands: shellSubcommands });
    } catch (e) {
      console.error('[shell] 包み方の本体を書けませんでした', e instanceof Error ? e.message : e);
    }
  };
  /**
   * 包みがそのまま渡すサブコマンドを claude --help から作り直し、包みを書き直す。
   * 読めなければ組み込みの一覧を使う。組み込みとの差は Claude Code との互換のずれとして記録する。
   * 起動を待たせないよう裏で走らせ、決して拒否しない。
   * 閉じた後に届いたときと、待つ間に claude のパスが変わったときは何もしない（新しいパスの読み取りが書く）。
   */
  const refreshSubcommands = async (): Promise<void> => {
    try {
      const bin = claudeBinOf(settings);
      const text = bin ? await readClaudeHelp(bin) : null;
      if (closed || claudeBinOf(settings) !== bin) return;
      const r = subcommandsFromHelp(text);
      for (const d of r.drifts) compatLog.note(d);
      lastSubcommandDrifts = { bin, drifts: r.drifts };
      shellSubcommands = r.subcommands;
      writeShellScript();
    } catch (e) {
      console.error('[shell] claude --help からサブコマンドを作り直せませんでした', e instanceof Error ? e.message : e);
    }
  };
  writeShellScript();
  void refreshSubcommands();
  void refreshClaudeVersion();
  // 包めるかは tmux を実行できるかで見る。ファイルを見るだけなので、毎回測る。
  const shellHook = (): ShellHookDto => {
    const shellSupported = shellWrapSupported(settings.tmuxPath);
    const zshrc = zshrcPath();
    return { state: shellHookState(zshrc, shellSupported), zshrc, line: shellHookLine(home), command: shellInstallCommand({ hangarOnPath: which('hangar'), bundledHangar }) };
  };
  // Claude Code のアカウント。置き場ごとのログインを切り替えるだけで、認証の中身は持たない。
  const accountStore = new AccountStore({ home, primaryDir: claudeDir });
  const accountAuth = new AccountAuth({ claudeBin: () => claudeBinOf(settings), compat: compatLog });
  // 2 つ目以降のアカウントの置き場に、Claude Code が新しい項目を足していないかを見る。起動のときと、確認リストを開いたときに見る。
  const claudeDirWatch = new ClaudeDirWatch({ dirs: () => accountStore.list().filter((a) => a.id !== PRIMARY_ACCOUNT_ID).map((a) => a.dir), sink: compatLog });
  claudeDirWatch.check();
  const runs = new RunManager({
    db, deviceId: device.id, home, tmux: tmuxOf(settings), port, token,
    claudeBin: claudeBinOf(settings),
    // 起動に失敗した run の後始末で、本文の jsonl があるかを実体で確かめるために要る。
    claudeDir,
    // hangar の外で動いている Claude を再開すると二重起動になるので、レジストリを見て弾く。
    isLive: (providerSessionId) => registry.current().some((l) => l.sessionId === providerSessionId),
    // 引き取りと attach が、外で動く claude の pid とバックグラウンドの id を引く。
    live: () => registry.current(),
    accounts: accountStore,
    compat: compatLog,
  });
  // 区切り（Paused・Done・Archived）を付けたセッションが休みになったら、Claude を止める。
  // 登録は 500 ミリ秒ごとの写しではなく、その場で読み直す。打ったばかりの発言で作業中に変わった会話を、古い写しのまま止めないためである。
  // 読めなかったときは、何も止めない。
  const parkWatch = new ParkWatch({
    parkedIds: () => { try { return parkedSessionIds(db, readRegistry(claudeDir), device.id); } catch { return []; } },
    stop: (id) => runs.park(id),
  });
  // statusline の payload からはアカウントが分からない（本文の置き場は共有）ので、セッションの最後の run から引く。
  // hangar の外で起こしたセッションと、消したアカウントの run は、最初のアカウントとして数える。
  const usage = new UsageTracker(db, {
    accountOf: (providerSessionId) => {
      if (!providerSessionId) return PRIMARY_ACCOUNT_ID;
      const s = db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ? and deleted_at is null").get(providerSessionId) as { id: string } | undefined;
      const id = s ? accountOfSession(db, s.id) : null;
      return id && accountStore.get(id) ? id : PRIMARY_ACCOUNT_ID;
    },
    compat: compatLog,
  });
  // アカウントの HTTP と、起動後の認証の読み直しが、同じ組み立てを使う。
  const accountsDeps: AccountsDeps = {
    db, store: accountStore, auth: accountAuth, usage, runs, primaryDir: claudeDir,
    broadcast: (accounts) => hub.broadcast({ type: 'accounts.update', accounts }),
  };
  // 認証を読み終えたとき、ログインが始まって終わったときに、画面へ配る。
  accountAuth.setOnChange(() => accountsDeps.broadcast(buildAccountsDto(accountsDeps)));
  // 起動のたびに、セッションとアカウントの対応を配る。
  announceAccountsOnRunStarted(runs, accountsDeps);
  const memos = new MemoStore({ db, deviceId: device.id, home });
  // Claude への切り替えの件数はプロセスの寿命で数えるので、要約器はここで 1 度だけ作り、
  // 設定の変更は列の組み立てで反映する。毎回作り直すと 1 時間の窓が空になる。
  const claudeSummarizer = () => new ClaudeHeadlessSummarizer({ claudeBin: claudeBinOf(settings), hourlyCap: settings.summaryHourlyCap, usage: () => usage.current(), compat: compatLog });
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

  /**
   * 同期の状態に添える付録。
   * 諦めた本文を覚えているのは RemotePuller、取り残しを数えられるのは TranscriptUploader だけで、
   * どちらも SyncEngine の外にある。だから状態を配る手前で、ここが足す。
   * HTTP の応答（createApp の deps）と websocket の通知の、両方がこれを通る。
   */
  const syncSkipped = (): SyncSkippedDto[] => puller?.skippedEntries() ?? [];
  const syncSweep = (): number | null => uploader?.pendingSweep() ?? null;
  const syncOncePass = (): boolean => pausedPass.active();
  /** 同期の状態を、付録を添えて画面へ配る。 */
  const broadcastSync = (s: SyncStatusDto): void => {
    hub.broadcast({ type: 'sync.status', status: { ...s, skipped: syncSkipped(), sweepPending: syncSweep(), oncePass: syncOncePass() } });
  };

  // 同期のイベントを hub に流す。pull で入れ替わった行は、そのまま画面に届ける。
  // 一時停止が解けたら取り直す。止まっている間は取りに行かないので、画面の値が古いままになる。
  let wasPaused = isPaused();
  engine.on({
    // 付録を添えてから流す。添えないと、画面の件数が一度受け取った値のまま固まる。
    status: (s) => {
      broadcastSync(s);
      const pausedNow = s.state === 'paused';
      if (wasPaused && !pausedNow) void cloudUsage.refresh();
      wasPaused = pausedNow;
    },
    toast: (level, message) => toast(level, message),
    applied: (c) => {
      // セッションに付く表（sessions、runs、session_summaries、session_states）の行なら、そのセッションを配り直す。
      const sessionId = sessionIdOfChange(db, c);
      const s = sessionId ? getSession(db, registry.current(), sessionId, { deviceId: device.id }) : null;
      if (s) hub.broadcast({ type: 'session.upsert', session: s });
      if (c.tableName === 'projects' || c.tableName === 'project_roots') {
        for (const p of listProjects(db, device.id, registry.current())) hub.broadcast({ type: 'project.upsert', project: p });
      }
      if (c.tableName === 'devices') hub.broadcast({ type: 'devices.update', devices: listDevices(db, device.id) });
    },
    // メタデータの pull の後に、ファイルの新着を取りに行く。
    // 頼まれた 1 巡の最中は、その巡が自分で降ろしに行く（pausedPass の rest）。
    pulled: () => { if (!pausedPass.active()) pullFiles(); },
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
      if (!settings.tmuxPath) throw new Error('tmux が見つかりません。設定の「tmux のパス」を入れてください');
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
    cloudUsage,
    accounts: accountsDeps,
    db, deviceId: device.id, deviceName: device.name, token, home, port, version: VERSION,
    // 最初の索引づけと紐づけが済むまで偽。.app はこれを見て起動画面に残る。
    ready: () => started,
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
      if (patch.tmuxPath !== undefined) writeShellScript();
      // claudePath が変われば、これから起こす run と要約が新しい場所を使う。包みのサブコマンドと手元の版も読み直す。
      if (patch.claudePath !== undefined) {
        runs.setClaudeBin(claudeBinOf(settings));
        claude = claudeSummarizer();
        void refreshSubcommands();
        void refreshClaudeVersion();
      }
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
    sync: {
      status: () => engine.status(),
      syncNow,
      setPaused: (paused) => engine.setPaused(paused),
      onFocus: () => engine.onFocus(),
      pullBeforeLaunch: (timeoutMs) => engine.pullBeforeLaunch(timeoutMs),
    },
    // 降ろすのを諦めた項目。onError は 1 度しか鳴らないので、状態にも載せて後から見られるようにする。
    syncSkipped,
    syncSweep,
    syncOncePass,
    resumeHere,
    // ClaudeConfigSync に pull() は無いので、確認を立ててから applyPull(pendingRemote()) を呼ぶ形に包む。
    configSync: configSync ? { preview: () => configSync.preview(), pull: async () => { const entries = configSync.pendingRemote(); configSync.confirm(); return configSync.applyPull(entries); } } : null,
    // 参加トークンは全セッションの読み書き権を持つ。作るのはここだけで、ログにも例外にも出さない。
    joinToken: () => (cloud ? encodeJoinToken({ url: cloud.url, secret: cloud.joinSecret }) : null),
    devices: () => listDevices(db, device.id),
    shellHook: () => {
      // Settings を開いたときに測り直す。CLI で入れた直後に開けば、ここで他の PC にも知らせる。
      const h = shellHook();
      const cur = db.prepare('select shell_hook from devices where id = ?').get(device.id) as { shell_hook: string | null } | undefined;
      if (cur && cur.shell_hook !== h.state) touchDevice();
      return h;
    },
    retention,
    // 準備の確かめ。設定画面と空のホームが読む。版を読む子プロセスは 3 秒で切る。
    readiness: createReadiness({
      settings: () => settings, claudeDir, claudeJson: claudeJsonPath(), db, deviceId: device.id,
      shellCommand: () => shellInstallCommand({ hangarOnPath: which('hangar'), bundledHangar }),
      compatDriftCount: () => { claudeDirWatch.check(); return compatLog.count(); },
      // /api/compat と同じ引き方で読み、同じ版の覚え（claudeVersions）を使う。
      // 道具の claude の行は準備の確かめが自分の覚えで読むので、同じ claude でもそれぞれ 1 度は起こす。
      compatLocalVersion: refreshClaudeVersion,
    }),
    // Claude Code との互換の一覧。確認リストの 6 行目を開いたときに読む。
    compat: async () => {
      claudeDirWatch.check();
      return { verifiedVersion: VERIFIED_CLAUDE_VERSION, localVersion: await refreshClaudeVersion(), drifts: compatLog.list() };
    },
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
  // 起動のときに動いていた会話の動きも覚えておく。最初の読み取りは onChange を通らない。
  liveStatus = new Map(registry.current().map((l) => [l.sessionId, l.status]));
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
  const parkTimer = setInterval(() => {
    try {
      const stopped = parkWatch.tick();
      if (stopped.length) console.log(`[park] 区切りを付けて休みになったセッションを ${stopped.length} 件止めました`);
    } catch (e) {
      console.error('[park]', e instanceof Error ? e.message : e);
    }
  }, RUN_POLL_MS);
  parkTimer.unref();
  // ここまでで既存のセッションの紐づけは済んでいる。以後に現れた未分類だけを知らせる。
  started = true;

  /** 自端末の生存を devices に刻む。他端末の Settings の一覧と、ロックの端末名と、包み方の状態がここから出る。 */
  function touchDevice(): void {
    const row = db.prepare('select * from devices where id = ?').get(device.id) as Record<string, unknown> | undefined;
    upsertShared(db, 'devices', { ...(row ?? {}), id: device.id, name: device.name, platform: device.platform, last_seen_at: Date.now(), shell_hook: shellHook().state, deleted_at: null }, device.id);
    hub.broadcast({ type: 'devices.update', devices: listDevices(db, device.id) });
  }
  touchDevice();
  const deviceTimer = setInterval(touchDevice, DEVICE_TOUCH_MS);
  deviceTimer.unref();

  engine.setClaudeConfigStatus({ enabled: settings.syncClaudeConfig, confirmed: syncState.get('configPullConfirmed') === '1' });
  // 最初の同期の完了を待たない。
  // クラウドが応答しないと push と pull がそれぞれ 30 秒待つので、待つと startServer の解決が 90 秒遅れる。
  // その間 /health は 200 を返しているので、準備完了だと見た相手からの SIGTERM が受け口の無い時刻に届く。
  // 走り出した push と pull は engine.idle() が掴んでいるので、close() は取りこぼさない。
  void engine.start().catch((e: unknown) => console.error('[sync]', e instanceof Error ? e.message : e));
  cloudUsage.start();
  pullFiles();
  configSync?.start();
  retention.start();
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

  // 起動の手続き（最初の索引づけと紐づけ）が済んだ。.app はここまで起動画面に残る。
  console.log(`agent-hangar ready in ${((performance.now() - bootAt) / 1000).toFixed(1)}s (index ${indexer.progress().total} files)`);
  return {
    port,
    close: async () => {
      closed = true;
      // 待ちの上限は 1 本の締め切りで持つ。
      // 段ごとに数えると和が番犬の上限を超え、db.close() まで届かない（レビューの指摘 2）。
      const deadline = Date.now() + CLOSE_DEADLINE_MS;
      const left = (): number => Math.max(0, deadline - Date.now());
      clearInterval(rootTimer);
      clearInterval(parkTimer);
      clearInterval(deviceTimer);
      if (configTimer) clearInterval(configTimer);
      retention.stop();
      cloudUsage.stop();
      if (uploadTimer) clearInterval(uploadTimer);
      if (passTicker) { clearInterval(passTicker); passTicker = null; }
      // 頼まれた 1 巡が走っていれば先に待つ。各段はこの後の stop で空振りになるので、待ち切れなくても害は無い。
      await Promise.race([pausedPass.idle(), new Promise<void>((r) => { setTimeout(r, left()).unref(); })]);
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
      // 記録の残りを書き出す。書けなくても閉じるのは止めない。
      compatLog.stop();
      db.close();
    },
  };
}
