import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOSE_DEADLINE_MS, STOP_WATCHDOG_MS } from './boot/budget.ts';
import { bootDelivery } from './boot/delivery.ts';
import { bootHome } from './boot/home.ts';
import { bootHttp, bootListen } from './boot/http.ts';
import { bootIndexing } from './boot/indexing.ts';
import type { StartOptions } from './boot/options.ts';
import { bootRuns } from './boot/runs.ts';
import { bootSummary } from './boot/summary.ts';
import { bootSync } from './boot/sync.ts';

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
  const sync = bootSync(home, delivery, { memoPath: (projectId) => indexing.memos.memoPath(projectId) });
  const indexing = bootIndexing(home, delivery, sync);
  // 待ち受けを始める。/health はここから返る。実際のポート番号を、この後の run と包みと MCP が使う。
  const listening = await bootListen(opts, home);
  const runs = bootRuns(home, delivery, listening, { serverDir });
  const summary = bootSummary(home, delivery, runs, sync);
  const web = bootHttp({ home, delivery, sync, indexing, listening, runs, summary, opts, serverDir });

  // 起動の手続き。実行中の一覧、索引とプロジェクト、run の順に動かし始める。
  delivery.registry.start();
  runs.primeLive();
  await indexing.start();
  runs.start();
  // ここまでで既存のセッションの紐づけは済んでいる。以後に現れた未分類だけを知らせる。
  home.life.started = true;
  runs.startPresence();
  sync.start();

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
      runs.stopPresence();
      sync.stopTimers();
      await sync.drain(left);
      // 見張りを止める。書き手が止まってから、配る層と待ち受けを畳む。
      indexing.stopMemoWatch();
      runs.runs.stop();
      indexing.indexer.stop();
      delivery.registry.stop();
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
