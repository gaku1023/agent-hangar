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
