/**
 * D1 へ実際に書いた行数を数える台帳である。
 *
 * 無料枠が数えているのは文の数ではなく `rows_written`、つまり索引への書き込みも含む行数である。
 * 端末の側（`packages/server/src/sync/quota.ts`）は push の行から見積もっていたが、
 * 圧縮（`changes.ts` の `compact`）、参加（`join.ts`）、スキーマの用意（`schema.ts`）の書き込みが
 * どれも端末を通らないので、数え落としが積み上がる。
 *
 * ここでは見積もらない。
 * D1 が結果に添えてくる `meta.rows_written` を足すので、どの経路の書き込みでも同じ物差しで数えられる。
 * 数えた値は `meta` の `d1_rows:<yyyy-MM-dd>`（UTC で区切る。無料枠が戻る境目と同じ）に積み、
 * `POST /changes` の応答に載せて端末へ返す。
 *
 * 台帳そのものも D1 への書き込みなので、毎回書きに行くと見張りが枠を食う。
 * 1 要求 1 行しか書かない `GET /changes` では、台帳を毎回更新すると書き込みが 3 倍になる。
 * そこで isolate の中に持ち越し、たまってから次の batch の末尾に 1 文だけ混ぜる。
 * 混ぜるだけなので要求も往復も増えない。
 */

/** 台帳の鍵の接頭辞。掃除（`sweep.ts`）が古い日の行を刈るときにも使う。 */
export const META_D1_ROWS_PREFIX = 'd1_rows:';

/** 持ち越しがこの行数に届いたら、次の batch に台帳の 1 文を混ぜる。 */
export const FLUSH_ROWS = 64;

/**
 * 台帳の 1 文が進める行数である。
 *
 * `meta` は `key text primary key` の 1 表なので、新しい鍵なら本体と索引で 2 行、
 * 既にある鍵の値を足すだけなら 1 行である（miniflare の D1 で実測した）。
 * 自分の書き込みだけは自分で申告できない（申告の申告になる）ので、多い方の 2 行で数える。
 */
export const META_ROWS_PER_FLUSH = 2;

/** その日の台帳の鍵。UTC の 0 時で区切る（端末の `quotaDayKey` と同じ境目である）。 */
export const d1RowsKey = (now: number): string => `${META_D1_ROWS_PREFIX}${new Date(now).toISOString().slice(0, 10)}`;

/**
 * まだ台帳へ書き出していない行数。日ごとに 1 件で、ふつうは 1 件しか無い。
 * isolate が死ねば持ち越しは消えるが、消えるのは高々 FLUSH_ROWS 行ぶんである。
 */
const pending = new Map<string, number>();

/** テスト専用。isolate をまたいだ持ち越しを落とす（`resetSchemaCache` と同じ役どころである）。 */
export function resetMeter(): void {
  pending.clear();
}

/** D1 が申告した書き込み行数の合計。申告が無い実装では 0 として読む。 */
const sumRows = (res: D1Result[]): number => res.reduce((n, r) => n + (Number(r.meta?.rows_written) || 0), 0);

function note(day: string, rows: number): void {
  if (!Number.isFinite(rows) || rows <= 0) return;
  pending.set(day, (pending.get(day) ?? 0) + rows);
}

/** 台帳へ足す 1 文。行が無ければ作り、あれば足す。 */
const addStatement = (db: D1Database, day: string, rows: number): D1PreparedStatement =>
  db
    .prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = cast(meta.value as integer) + ?')
    .bind(day, String(rows), rows);

/**
 * いま書き出すべき持ち越しを 1 件取り出す。
 * 今日の分は FLUSH_ROWS まで待つが、前の日の分は少なくても書き出す。
 * 待つと、日付をまたいだ端末がその日の合計を過大に受け取る。
 */
function takeFlush(db: D1Database, today: string): { day: string; rows: number; stmt: D1PreparedStatement } | null {
  let pick: string | null = null;
  for (const [day, rows] of pending) {
    if (day !== today || rows >= FLUSH_ROWS) { pick = day; break; }
  }
  if (pick === null) return null;
  const rows = pending.get(pick)!;
  pending.delete(pick);
  return { day: pick, rows, stmt: addStatement(db, pick, rows) };
}

/**
 * batch を実行し、書いた行数を数える。
 * 書き込みのある経路は必ずこれを通すこと。通さない経路は台帳に載らず、見張りが甘くなる。
 */
export async function meteredBatch(db: D1Database, stmts: D1PreparedStatement[], now: number): Promise<D1Result[]> {
  const day = d1RowsKey(now);
  const flush = takeFlush(db, day);
  let res: D1Result[];
  try {
    res = await db.batch(flush ? [...stmts, flush.stmt] : stmts);
  } catch (e) {
    // batch は全体が取り消されるので、書き出そうとした分は書けていない。持ち越しに戻す。
    if (flush) note(flush.day, flush.rows);
    throw e;
  }
  // 台帳の 1 文だけは申告を使わない。自分の行数を自分の値に足すと数えが循環するので、決め打ちで足す。
  note(day, sumRows(res.slice(0, stmts.length)) + (flush ? META_ROWS_PER_FLUSH : 0));
  return res;
}

/** 文が 1 つだけの経路。batch と同じ道を通して、数え落としの経路を作らない。 */
export async function meteredRun(db: D1Database, stmt: D1PreparedStatement, now: number): Promise<D1Result> {
  return (await meteredBatch(db, [stmt], now))[0]!;
}

/** その日にこの箱が D1 へ書いた行数。台帳に書き出した分と、まだ持ち越している分の和である。 */
export async function d1RowsToday(db: D1Database, now: number): Promise<number> {
  const day = d1RowsKey(now);
  const r = await db.prepare('select value from meta where key = ?').bind(day).first<{ value: string }>();
  const stored = r ? Number(r.value) : 0;
  return (Number.isFinite(stored) && stored > 0 ? Math.floor(stored) : 0) + (pending.get(day) ?? 0);
}
