import type { Db } from './open.ts';

/**
 * DB の行の変化を知らせる 1 本の口。
 * 「どの表のどの行（主キー）が変わったか、消えたか」を、書いた側が知らせ、読む側が購読する。
 * 購読するのは、画面へ配る層（events/publisher.ts）と、同期の push のデバウンス（sync/engine.ts）である。
 *
 * 出どころは 3 つある。
 * - `write` は、この端末が共有の表に書いたもの（db/shared.ts の upsertShared と softDeleteShared）。changes に 1 行が積まれているので、同期はこれだけを push の契機にする。
 * - `apply` は、同期で他の端末から降りてきた行（sync/apply.ts）。changes には積まれていないので、push し返さない。
 * - `touch` は、行そのものは書いていないが、その行から組む DTO の中身が変わったもの。
 *   索引が手元だけの表（本文の索引、集計）を書き直したときや、セッションの紐づけでプロジェクトの中身が変わったときに使う。
 */
export type RowOrigin = 'write' | 'apply' | 'touch';
export type RowOp = 'upsert' | 'delete';
/**
 * `at` は、その変化が起きた順番（プロセスで 1 本の通し番号）である。知らせが届いた順ではない。
 * トランザクションの中の変化は確定まで知らせが遅れるので、起きた順は届いた順からは分からない。
 * 配る層は、手で配られたイベントと行の変化のどちらが後かを、これと `rowChangeClock()` で比べる。
 */
export type RowChange = { db: Db; table: string; rowId: string; op: RowOp; origin: RowOrigin; at: number };

type RowChangeListener = (c: RowChange) => void;

const listeners = new Set<RowChangeListener>();

/** 変化の通し番号。変化が起きるたびに 1 つ進む。 */
let clock = 0;

/** いままでに起きた変化の通し番号。`RowChange.at` がこの値以下なら、その変化はもう起きている。 */
export function rowChangeClock(): number {
  return clock;
}

/**
 * 外側のトランザクションの中で起きた変化。確定を待ってから配る。
 * seq は changes の連番で、write のときだけ持つ（巻き戻ったかを見分けるのに使う）。
 */
type PendingNotice = { table: string; rowId: string; op: RowOp; origin: RowOrigin; seq: number | null; at: number };
const pending = new Map<Db, PendingNotice[]>();

/**
 * 行の変化の購読を足す。戻り値を呼ぶと購読を外す。
 *
 * 呼ばれるのは、書き込みが確定した後である。
 * 外側のトランザクションに包まれているときは、その最外が確定するまで遅れる（そのぶん同期ではなくなる）。
 * 巻き戻った write は呼ばれない。
 * 購読が投げても、他の購読にも書き込んだ側にも波及しない。
 * 購読はプロセスに 1 つの集まりなので、複数の DB を開くときは `c.db` で自分の分だけを拾う。
 */
export function onRowChange(cb: RowChangeListener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * ログに出してよい形に削る。
 * 行 ID も表名も内部で作る値だが、そのまま出すと改行で偽のログ行を作られ、長い値で行が溢れる。
 */
function logSafe(v: string): string {
  return v.replace(/[^\w:.@-]/g, '?').slice(0, 64);
}

/**
 * 例外の種類だけを取る。
 * 見るのは name ではなくクラス名である。
 * name は誰でも書き換えられるので、識別子の形をした秘密（32 桁のアカウント ID など）が入っていると通ってしまう。
 * クラス名の形（識別子、40 字まで）をしていないものは伏せる。
 */
function errorKind(e: unknown): string {
  if (!(e instanceof Error)) return logSafe(typeof e);
  const kind = (e.constructor as { name?: unknown } | undefined)?.name;
  return typeof kind === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(kind) ? kind : 'Error';
}

/**
 * ログの 1 行を組み立てて出す。組み立ての最中に何が起きても外へ出さない。
 * 例外の name や constructor は getter でありうるので、削る処理そのものが投げうる。
 * ここを囲わないと、購読の例外を握ったつもりが書き込んだ側まで抜ける。
 */
function logSafely(build: () => string): void {
  try {
    console.error(build());
  } catch {
    try { console.error('[notify] ログの行を組み立てられませんでした'); } catch { /* ここまで来たら何もできない */ }
  }
}

/** 購読を 1 つずつ包んで呼ぶ。1 つの失敗で残りと呼び手を巻き込まない。 */
function deliver(c: RowChange): void {
  for (const cb of [...listeners]) {
    try {
      cb(c);
    } catch (e) {
      // 例外のメッセージには秘密が載りうるので出さない。どの行で、どの種類の失敗かだけを、削ってから残す。
      logSafely(() => `[notify] 行の変化の購読が失敗しました（${logSafe(c.table)}:${logSafe(c.rowId)}、${errorKind(e)}）`);
    }
  }
}

/** 溜めた通知を配る。最外のトランザクションが終わってから呼ばれる。 */
function drain(db: Db): void {
  const queue = pending.get(db);
  if (!queue) return;
  pending.delete(db);
  try {
    if (!db.open) return;
    // 巻き戻っていれば changes の行ごと消えている。起きなかった書き込みを知らせない。
    // seq だけで見ると足りない。changes.seq は autoincrement なので、巻き戻すと sqlite_sequence ごと戻り、
    // 次の書き込みが同じ seq を取り直す。表名と行 ID も一致を見て、別の行の seq を借りないようにする。
    const alive = db.prepare('select 1 from changes where seq = ? and table_name = ? and row_id = ?');
    // 同じ行を巻き戻して書き直した場合は両方が生きたまま通る。その行は本当に書かれているので配るが、1 回にまとめる。
    // 並びは最初に書いた位置、操作は最後のもの（書いてから消した行は delete）にする。
    const merged = new Map<string, RowChange>();
    for (const p of queue) {
      // apply と touch は changes に行を持たないので、巻き戻りを見分けられない。
      // 巻き戻った分が混ざっても、購読は行を読み直すだけなので害は無い。
      if (p.seq !== null && alive.get(p.seq, p.table, p.rowId) === undefined) continue;
      const key = `${p.origin}\u0000${p.table}\u0000${p.rowId}`;
      const cur = merged.get(key);
      if (cur) { cur.op = p.op; cur.at = p.at; }
      else merged.set(key, { db, table: p.table, rowId: p.rowId, op: p.op, origin: p.origin, at: p.at });
    }
    for (const c of merged.values()) deliver(c);
  } catch (e) {
    logSafely(() => `[notify] 溜めた行の変化の通知を配れませんでした（${errorKind(e)}）`);
  }
}

/**
 * 購読へ知らせる。
 * 外側のトランザクションの中なら、確定を待ってから配る。
 * ここで配ってしまうと、購読は確定前の値（MemoStore.adoptFile が直す前の updated_at）を読み、
 * 購読が DB に書けばその書き込みごと外側の巻き戻しに巻き込まれる。
 */
function note(db: Db, o: Omit<PendingNotice, 'at'>): void {
  const n: PendingNotice = { ...o, at: ++clock };
  if (db.inTransaction) {
    const queue = pending.get(db);
    if (queue) { queue.push(n); return; }
    pending.set(db, [n]);
    // トランザクションの本体は同期なので、マイクロタスクは最外が終わってから走る。
    queueMicrotask(() => drain(db));
    return;
  }
  drain(db);
  deliver({ db, table: n.table, rowId: n.rowId, op: n.op, origin: n.origin, at: n.at });
}

/**
 * この端末が共有の表に書いた。呼ぶのは db/shared.ts だけである。
 * seq には、その書き込みが changes に積んだ行の連番を渡す。
 */
export function noteWrite(db: Db, table: string, rowId: string, op: RowOp, seq: number): void {
  note(db, { table, rowId, op, origin: 'write', seq });
}

/** 同期で降りてきた行を当てた。呼ぶのは sync/apply.ts だけである。 */
export function noteApplied(db: Db, table: string, rowId: string, op: RowOp): void {
  note(db, { table, rowId, op, origin: 'apply', seq: null });
}

/**
 * 行は書いていないが、その行から組む DTO の中身が変わった。
 * 画面へ配り直してほしい行を、表名と主キーで名指しする。DTO は組まない（組むのは events/publisher.ts）。
 */
export function touchRow(db: Db, table: string, rowId: string): void {
  note(db, { table, rowId, op: 'upsert', origin: 'touch', seq: null });
}

/**
 * 確定済みなのにまだ配っていない通知を、その場で配る。
 * トランザクションの中の変化はマイクロタスクまで遅れるので、同じ tick の終わりに配る層が、自分の番の前にこれを呼んで順番を確かにする。
 * トランザクションの最中に呼ばれたら何もしない。
 */
export function settleRowChanges(db: Db): void {
  if (!db.inTransaction) drain(db);
}
