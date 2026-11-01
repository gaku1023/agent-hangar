import type { ToolDeps } from './mcp/tools.ts';
import { launchScheduled, waitScheduled } from './schedule/launch.ts';
import { ScheduleRunner } from './schedule/runner.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOSE_DEADLINE_MS, STOP_WATCHDOG_MS } from './boot/budget.ts';
import { bootDelivery } from './boot/delivery.ts';
import { bootHome } from './boot/home.ts';
import { bootHttp, bootListen } from './boot/http.ts';
import { bootTrash } from './boot/trash.ts';
import { bootIndexing } from './boot/indexing.ts';
import { bootMobile } from './boot/mobile.ts';
import { bootOpencode } from './boot/opencode.ts';
import type { StartOptions } from './boot/options.ts';
import { bootRuns, panesOf } from './boot/runs.ts';
import { bootSummary } from './boot/summary.ts';
import { bootSync } from './boot/sync.ts';
import { bootTakeover } from './boot/takeover.ts';
import { findCodex } from './config/tools.ts';
import { LocalCodex } from './provider/codex/compat/version.ts';
import { CodexOptionsService } from './provider/codex/options.ts';
import { translatorOf } from './i18n/message.ts';
import { IdleUnloadWatch } from './provider/opencode/localModels/idleUnload.ts';
import { idleUnloadOf } from '@agent-hangar/shared';
import { uploadOnOpencodeTurnEnd } from './sync/opencodeTurnEnd.ts';
import type { OpencodeExportSource } from './sync/uploader.ts';

export { CLOSE_DEADLINE_MS, STOP_WATCHDOG_MS } from './boot/budget.ts';
export { VERSION, type StartOptions } from './boot/options.ts';

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

/**
 * DB、索引、実行中セッションの監視、run の管理、HTTP と WebSocket をまとめて起動する。
 * ~/.claude は原則として読むだけで、書き込みは home 配下に限る（例外は docs/design.md の「読み取り専用」にある 4 つ）。
 *
 * ここは、boot/ の組み立て関数を順に呼び、作った部品を次へ渡すだけである。
 * 業務の処理は持たない。それぞれの持ち場（projects/、sync/、runs/ など）にある。
 * 呼ぶ順と止める順には意味がある。変えるときは docs/design.md の「起動の組み立て」を見ること。
 */
export async function startServer(opts: StartOptions = {}): Promise<{ close(): Promise<void>; port: number }> {
  const bootAt = performance.now();
  // 同梱の hangar と UI の置き場所の既定は、この入口のファイルの場所から決める。
  const serverDir = path.dirname(fileURLToPath(import.meta.url));

  // 組み立て。待ち受けより前は、誰も外と話さず、何も見張らない。
  const home = bootHome(opts);
  const delivery = bootDelivery(home, opts);
  // メモの置き場は索引の側が持つ。同期が使うのは競合で負けたときだけなので、後から作る部品を呼ばれた時点で引く。
  // opencode の本文の書き出しの口は、serve の管理（下の bootOpencode）を組んだ後に入る。それまで opencode の本文は上げない。
  let opencodeExport: OpencodeExportSource | null = null;
  const sync = bootSync(home, delivery, { memoPath: (projectId) => indexing.memos.memoPath(projectId), opencodeExport: () => opencodeExport });
  const indexing = bootIndexing(home, delivery, sync);
  // 待ち受けを始める。/health はここから返る。実際のポート番号を、この後の run と包みと MCP が使う。
  let listening: Awaited<ReturnType<typeof bootListen>>;
  try {
    listening = await bootListen(opts, home);
  } catch (e) {
    // 待ち受けに失敗したら（ポートが塞がれているなど）、ここまでに開いたものを閉じてから投げる。
    // 入口はすぐ終了するが、閉じずに残すと Windows では DB のファイルが握られたままになる。
    await delivery.stopPublishing().catch(() => {});
    delivery.compatLog.stop();
    home.stop();
    throw e;
  }
  // 起動を断る確かめ（DB の版と控え、待ち受け）が通った。読み替えた設定をここで初めて書き戻す。
  home.persistSettings();
  const runs = bootRuns(home, delivery, listening, { serverDir, launcher: opts.launcher });
  // hangar の外の Codex の会話の枠（rollout の meta rate_limits）を、使用量の面へ。
  indexing.bindCodexRateLimits((value, ts, creator) => { runs.codexUsage.noteRolloutRateLimits(value, ts, creator); });
  const summary = bootSummary(home, delivery, runs, sync);
  const trash = bootTrash(home, delivery, sync, indexing);
  // opencode の serve の管理は下で組むので、引き継ぎの受け手には呼ばれた時点で引く口を渡す。
  let opencodeParts: ReturnType<typeof bootOpencode> | null = null;
  const takeover = bootTakeover({ home, runs, sync, delivery, opencode: () => opencodeParts });
  // opencode（ベータ）の serve の管理。前の hangar が残した serve の掃除は、設定の入り切りに関わらずここで始まる。
  // 範囲の外の版で serve を起こすたびに、画面へ知らせの種を配る（右下の札、同じ版では画面が一度だけ出す）。
  // 動いている run の会話の serve は、前の hangar から引き継ぐ。Windows は serve を psmux の画面の中で起こすので、run と同じ画面の口を渡す。
  const opencode = bootOpencode(home, {
    onVersionNotice: (s) => delivery.hub.broadcast({ type: 'opencode.version', version: s.version, verdict: s.verdict }),
    panes: () => panesOf(runs.mux()),
  });
  opencodeParts = opencode;
  // opencode の driver は配る層と一緒に組んである。serve の管理をここで渡す（それまでの opencode の起動は断る）。
  delivery.bindOpencodeServes(opencode.serves);
  // opencode の本文には文脈の大きさが無いので、索引は使用量を書くときにモデルの一覧（とカタログ）から引く。
  indexing.bindContextSize((model) => opencode.options.contextOf(model));

  // opencode の本文は、ターンの終わり（serve の出来事の流れ）と run の終わり（bootSummary の flushOnRunEnded）で書き出して上げる。
  opencodeExport = opencode.exporter;
  uploadOnOpencodeTurnEnd(delivery.opencode.events, () => sync.uploader);

  // スマホの受信箱に預ける素を封じて書く。同期と run（アカウントと使用率）の後に組む。
  // スマホの opencode の問い合わせ（モードとモデル、`/` の候補）には、opencode の選択肢が手元に持った一覧で答える。
  // Codex の検出と選択肢（ベータ）。設定の画面とスマホの問い合わせが同じ一覧を使う。
  const localCodex = new LocalCodex({ bin: () => findCodex() });
  const codex = { local: localCodex, options: new CodexOptionsService({ bin: () => findCodex(), status: localCodex.status }) };
  const mobile = bootMobile({ home, delivery, runs, sync, opencode, codex: { options: codex.options }, trash: trash.trash });
  // 定期の実行（#549）。予定はこの PC のものだけを流す。起こし方と待ち方は MCP の道具と同じ本体を通す。
  const scheduleTools: ToolDeps = { db: home.db, deviceId: home.device.id, port: listening.port, live: () => delivery.live.current(), runs: runs.runs, language: home.language, usage: () => runs.usage.current() };
  const schedules = new ScheduleRunner({
    db: home.db, deviceId: home.device.id, now: () => Date.now(),
    launch: (s) => launchScheduled(scheduleTools, s),
    wait: (id) => waitScheduled(scheduleTools, id),
  });
  const web = bootHttp({ home, delivery, sync, indexing, listening, runs, summary, trash, takeover, opencode, mobile, codex, schedules, opts, serverDir });

  // 起動の手続き。実行中の一覧、索引とプロジェクト、run の順に動かし始める。
  delivery.live.start();
  runs.primeLive();
  await indexing.start();
  runs.start();
  summary.startAutoDone();
  // 使っていない LM Studio のモデルを外す見張り（provider/opencode/localModels/idleUnload.ts）。
  const idleUnload = new IdleUnloadWatch({
    home: home.home,
    minutes: () => idleUnloadOf(home.settings.current),
    isRunning: (id) => opencode.serves.get(id) !== null,
    announce: (model, minutes) => {
      const tr = translatorOf(home.language);
      const time = minutes % 60 === 0 ? tr('launchPrep.idleUnload.spanHours', { n: minutes / 60 }) : tr('launchPrep.idleUnload.spanMinutes', { n: minutes });
      delivery.hub.broadcast({ type: 'toast', level: 'info', message: tr('launchPrep.idleUnload.done', { model, time }) });
    },
  });
  idleUnload.start();
  // ここまでで既存のセッションの紐づけは済んでいる。以後に現れた未分類だけを知らせる。
  home.life.started = true;
  runs.startPresence();
  sync.start();
  // 引き継ぎの頼みを受ける。同期が始まってから回す。起きていなかった間に届いた頼みと、tmux に残った奪われた claude も、ここで止める。
  takeover.start();
  // 受信箱の素。書いてよいか（Worker の版 7 から）は同期が決めるので、同期が始まってから回す。
  mobile.start();
  // 削除の印の処理（sessions/trash.ts）。索引と紐づけが済んでから回す。起きていなかった間に届いた印も、ここで処理する。
  trash.start();
  // 閉じていた間の回は、ここで最新の 1 回だけ流す。索引と紐づけが済んでから回す。
  schedules.start();

  // 起動の手続き（最初の索引づけと紐づけ）が済んだ。.app はここまで起動画面に残る。
  console.log(`agent-hangar ready in ${((performance.now() - bootAt) / 1000).toFixed(1)}s (index ${indexing.indexer.progress().total} files)`);
  return {
    port: listening.port,
    close: async () => {
      home.life.closed = true;
      // 待ちの上限は 1 本の締め切りで持つ。
      // 段ごとに数えると和が番犬の上限を超え、db.close() まで届かない（レビューの指摘 2）。
      const deadline = Date.now() + CLOSE_DEADLINE_MS;
      const left = (): number => Math.max(0, deadline - Date.now());
      // まず周期の仕事を止め、次に走っている通信を待ってから止める。
      indexing.stopTimers();
      runs.stopParkTimer();
      summary.stopAutoDone();
      idleUnload.stop();
      runs.stopPresence();
      sync.stopTimers();
      takeover.stop();
      mobile.stop();
      schedules.stop();
      // 本文をゴミ箱へ移している最中の回は、DB を閉じる前に待ち切る。
      await trash.stop();
      // 起こした opencode の serve を止める（interrupt、SIGTERM、間をおいて SIGKILL）。
      await opencode.stop(left());
      await sync.drain(left);
      // 見張りを止める。書き手が止まってから、配る層と待ち受けを畳む。
      indexing.stopMemoWatch();
      runs.runs.stop();
      indexing.indexer.stop();
      delivery.live.stop();
      web.stopRelay();
      // WebSocket を先に畳み、残った keep-alive の接続を切ってから listen を閉じる。
      await delivery.stopPublishing();
      await listening.stop();
      // 走っている要約は DB に書き込む。待ち切ってから DB を閉じる。
      await summary.stop(left());
      // 記録の残りを書き出す。書けなくても閉じるのは止めない。
      delivery.compatLog.stop();
      home.stop();
    },
  };
}
