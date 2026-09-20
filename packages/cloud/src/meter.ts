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
 * `POST /changes` と `GET /changes` の応答に載せて端末へ返す。
 *
 * **数えた分は、その要求の中で必ず D1 へ書き出す。**
 * 以前は 64 行たまるまで isolate の中に持ち越していたが、
 * 要求ごとに isolate が入れ替わると持ち越しは毎回捨てられ、台帳に 1 行も残らなかった。
 * 端末には「その要求ぶん」しか届かず、見張りが小さい値に貼り付く（レビューの致命 1）。
 * 見張りの数が消えるくらいなら、台帳の 1 文ぶんを払う方がよい。
 *
 * 払う実費は 1 要求につき 1 行から 2 行である（`meta` はその日の最初だけ 2 行で、あとは 1 行）。
 * いちばん効くのは 1 行しか書かない `GET /changes` で、そこだけ 1 行が 2 行になる。
 * 30 秒ごとに pull する端末 1 台で 1 日 2,880 要求、足す分は 2,880 行、枠（1 日 10 万行）の 2.9% である。
 * push は 1 回で 200 行ほど書くので、足す 1 行は 0.5% に満たない。
 * 書き込みの無い要求（読むだけの経路、当たらなかった delete）では 1 行も足さない。
 */

/** 台帳の鍵の接頭辞。掃除（`sweep.ts`）が古い日の行を刈るときにも使う。 */
export const META_D1_ROWS_PREFIX = 'd1_rows:';

/**
 * 台帳の 1 文そのものが進める行数である。
 *
 * `meta` は `key text primary key` の 1 表なので、新しい鍵なら本体と索引で 2 行、
 * 既にある鍵の値を足すだけなら 1 行である（miniflare の D1 で実測した）。
 * 自分の書き込みだけは自分で申告できない（申告の申告になる）ので、多い方の 2 行で数える。
 */
export const META_ROWS_PER_NOTE = 2;

/** その日の台帳の鍵。UTC の 0 時で区切る（端末の `quotaDayKey` と同じ境目である）。 */
export const d1RowsKey = (now: number): string => `${META_D1_ROWS_PREFIX}${new Date(now).toISOString().slice(0, 10)}`;

/** D1 が申告した書き込み行数の合計。申告が無い実装では 0 として読む。 */
const sumRows = (res: D1Result[]): number => res.reduce((n, r) => n + (Number(r.meta?.rows_written) || 0), 0);

/** 台帳へ足す 1 文。行が無ければ作り、あれば足す。 */
const addStatement = (db: D1Database, day: string, rows: number): D1PreparedStatement =>
  db
    .prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = cast(meta.value as integer) + ?')
    .bind(day, String(rows), rows);

/**
 * 書いた行数を台帳へ積む。
 *
 * ここが落ちても要求は落とさない。
 * 仕事の方はもう書けているので、500 を返すと端末が同じ書き込みを送り直して、かえって枠を使う。
 * 落ちた回の数えは端末の手元の見積もりが拾う（`quota.ts` は報告と自分の積み上げの大きい方を見る）。
 */
async function note(db: D1Database, now: number, rows: number): Promise<void> {
  if (rows <= 0) return;
  try {
    await addStatement(db, d1RowsKey(now), rows + META_ROWS_PER_NOTE).run();
  } catch (e) {
    console.error('meter failed', e instanceof Error ? e.name : typeof e);
  }
}

/**
 * batch を実行し、書いた行数を数える。
 * 書き込みのある経路は必ずこれを通すこと。通さない経路は台帳に載らず、見張りが甘くなる。
 */
export async function meteredBatch(db: D1Database, stmts: D1PreparedStatement[], now: number): Promise<D1Result[]> {
  const res = await db.batch(stmts);
  await note(db, now, sumRows(res));
  return res;
}

/** 文が 1 つだけの経路。batch と同じ道を通して、数え落としの経路を作らない。 */
export async function meteredRun(db: D1Database, stmt: D1PreparedStatement, now: number): Promise<D1Result> {
  return (await meteredBatch(db, [stmt], now))[0]!;
}

/**
 * その日にこの箱が D1 へ書いた行数。
 * 書き出しはその要求の中で済ませてあるので、ここで読む値に持ち越しは無い。
 * 読み損ねたときは 0 ではなく null を返す。端末には「報告が無い」と伝わり、自分の見積もりに落ちる。
 */
export async function d1RowsToday(db: D1Database, now: number): Promise<number | undefined> {
  try {
    const r = await db.prepare('select value from meta where key = ?').bind(d1RowsKey(now)).first<{ value: string }>();
    const n = r ? Number(r.value) : 0;
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  } catch {
    return undefined;
  }
}
