import { Hono } from 'hono';
import {
  LAUNCH_TTL_MS,
  MAX_PUSH_BATCH,
  PULL_LIMIT,
  SEALED_ROW_K_RE,
  type CloudPeer,
  type MobileLaunchOut,
  type PushChangesResponse,
  type SealedChangeIn,
  type SealedChangeOut,
  type SealedPullChangesResponse,
  type SealedSnapshotResponse,
} from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';
import { touchIfDue } from './seen.ts';
import { blobToSealed, isSealedText, sealedToBlob } from './util.ts';

/**
 * 1 行の `sealed`（base64url の字数）の上限である。
 *
 * D1 は 1 つの値を 2,000,000 バイトで打ち切るので、それを超える行は必ず 500 になる。
 * 500 は端末から見ると一時的な失敗なので、同じ batch を永久に送り直して、その端末の push が止まる。
 * 手前で 413 に落として、端末がその行を諦められるようにする。
 *
 * 平文の上限は今までどおり 128 KiB とし、それを封じて base64url にした大きさが収まる値にした。
 * 封は先頭の 1 バイト、iv の 12 バイト、gzip の印の 1 バイト、GCM の 16 バイトを足し、gzip で縮まないときがいちばん大きい。
 * それを base64url にすると約 4/3 倍の 174,800 字ほどなので、余裕を見て 180 KiB にした。
 * 1 回の push は 40 行までなので、要求 1 本は 8 MiB に収まる。
 */
export const MAX_ROW_BYTES = 180 * 1024;

const isEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/**
 * 封じた行の形である（互換の版 9）。
 * `k` は HMAC の base64url（43 字）だけを受け、名簿の印の行（`~roster`）は受けない。印の行は keys.ts が書く。
 * `sealed` の大きさと字の形はここでは見ず、413 で名指しするために後で測ってから確かめる。
 */
function isChange(v: unknown): v is SealedChangeIn {
  const c = v as Partial<SealedChangeIn> | null;
  return (
    !!c &&
    typeof c.k === 'string' &&
    SEALED_ROW_K_RE.test(c.k) &&
    (c.op === 'upsert' || c.op === 'delete') &&
    typeof c.updatedAt === 'number' &&
    Number.isSafeInteger(c.updatedAt) &&
    c.updatedAt >= 0 &&
    isEpoch(c.epoch) &&
    typeof c.sealed === 'string' &&
    c.sealed.length > 0
  );
}

/**
 * 1 頁（pull と GET /rows）に載せる `sealed` の合計の上限（base64url の字数）である。
 *
 * 1 頁は 500 行までで、1 行は 180 KiB までなので、上限が無いと 1 頁が 90 MiB になりうる。
 * それだけの値を D1 から受け取ると、Worker の記憶（128 MB）を使い切って要求ごと落ち、端末は同じ頁を読み直し続ける。
 * 合計がこの値を超えた行を入れたところで頁を切り、続きは今までどおり nextSeq（GET /rows は nextAfter）から読ませる。
 * 先頭の 1 行は必ず載せるので、1 行の上限より小さくしてはいけない。
 */
export const MAX_PAGE_SEALED_CHARS = 8 * 1024 * 1024;

/**
 * 頁の問い合わせでそのまま受け取る `sealed` の大きさ（BLOB のバイト数）の上限である。
 * これより大きい行は、頁に入ると決まってから主キーで読み直す。
 * 頁の問い合わせが D1 から受け取る量は、500 行でも 8 MiB ほどに収まる。
 */
const INLINE_SEALED_BYTES = 16 * 1024;
/** 大きい行を主キーで読み直すときの、1 つの文に並べる連番の数。D1 の 1 文の引数は 100 個までである。 */
const REFETCH_CHUNK = 90;

type ChangeRow = { seq: number; k: string; op: 'upsert' | 'delete'; updated_at: number; device_id: string; epoch: number; sealed: unknown };
/** 頁の問い合わせの行。`n` は `sealed` のバイト数で、大きい行は `sealed` を null で受け取る。 */
type PagedRow = ChangeRow & { n: number };

const META_COLS = 'seq, k, op, updated_at, device_id, epoch';

/**
 * 頁を読む文である。`where` と `order` に合う行を `limit + 1` 行まで読む。
 * どの行も `sealed` のバイト数（`n`）を添え、`INLINE_SEALED_BYTES` を超える行の `sealed` は返さない（null にする）。
 * 窓関数で合計を数える形は、D1 の数える読み取りの行が返した行の約 3 倍になったので採らない。
 */
const pageStmt = (db: D1Database, where: string, order: string, binds: unknown[], limit: number): D1PreparedStatement =>
  db
    .prepare(`select ${META_COLS}, length(sealed) n, case when length(sealed) <= ? then sealed end sealed from rows where ${where} order by ${order} limit ?`)
    .bind(INLINE_SEALED_BYTES, ...binds, limit + 1);

/**
 * 読んだ行から頁を切り出す。
 * 行の数の上限に達するか、`sealed` の合計（base64url の字数）が上限を超えた行を入れたところで止める。先頭の 1 行は必ず入れる。
 * `last` は頁が受け持った最後の行で、続きの読み位置（nextSeq と nextAfter）はこの行で決める。
 *
 * 頁に入った大きい行は、主キーで `sealed` を読み直す。
 * 頁の問い合わせとの間に書き換えられた行は、消えて表の末尾の連番で入り直しているので、ここでは見つからない。
 * その行は頁から外す。入り直した行は、頁の問い合わせと同じ batch で読んだ高水位より後ろの連番なので、続きの pull で降りる。
 */
async function cutPage(db: D1Database, rows: PagedRow[], limit: number): Promise<{ page: ChangeRow[]; more: boolean; last: ChangeRow | undefined }> {
  const taken: PagedRow[] = [];
  let chars = 0;
  for (const r of rows) {
    if (taken.length >= limit || (taken.length > 0 && chars > MAX_PAGE_SEALED_CHARS)) break;
    taken.push(r);
    chars += Math.ceil((Number(r.n) * 4) / 3);
  }
  const more = rows.length > taken.length;
  const last = taken.at(-1);
  const big = taken.filter((r) => r.sealed === null).map((r) => r.seq);
  if (big.length === 0) return { page: taken, more, last };
  const chunks: number[][] = [];
  for (let i = 0; i < big.length; i += REFETCH_CHUNK) chunks.push(big.slice(i, i + REFETCH_CHUNK));
  const results = await db.batch(chunks.map((c) => db.prepare(`select seq, sealed from rows where seq in (${c.map(() => '?').join(', ')})`).bind(...c)));
  const found = new Map<number, unknown>();
  for (const res of results) for (const g of (res.results ?? []) as { seq: number; sealed: unknown }[]) found.set(Number(g.seq), g.sealed);
  const page = taken.flatMap((r) => (r.sealed !== null ? [r] : found.has(r.seq) ? [{ ...r, sealed: found.get(r.seq) }] : []));
  return { page, more, last };
}

const toOut = (r: ChangeRow): SealedChangeOut => ({
  seq: r.seq,
  k: r.k,
  op: r.op,
  updatedAt: r.updated_at,
  epoch: r.epoch,
  sealed: blobToSealed(r.sealed),
  deviceId: r.device_id,
});

/**
 * 表の連番の高水位である。
 *
 * rows の連番は autoincrement で、行を書き換えるときは消してから入れ直すので、最大の連番の行は消えずに残る（消すのは同じ batch で、より大きい連番で入れ直す直前だけである）。
 * だから `max(seq)` は後戻りしない。主キーの最大なので、読むのは 1 行である。
 */
const maxSeqStmt = (db: D1Database): D1PreparedStatement => db.prepare('select ifnull(max(seq), 0) s from rows');

const clampLimit = (v: string | undefined): number => Math.min(Math.max(Number(v ?? PULL_LIMIT) || PULL_LIMIT, 1), PULL_LIMIT);

const firstNum = (r: D1Result<{ s: number }> | undefined): number => Number(r?.results?.[0]?.s ?? 0);

/**
 * 行を書く 2 文である（同期の版 6）。
 *
 * 1 文目は、届いた版より古い行だけを消す。2 文目は、鍵が空いていれば入れる。
 * 古い行を消したときだけ鍵が空くので、入るのは届いた版の方が新しいか、まだ行が無いときに限られる。
 * 同着（`updated_at` が等しい）は消さないので書き換えない。端末の取り込みの `prev >= updatedAt` も先に着いた方を残すので、その決着とそろえてある。
 *
 * 書き換えた行は、表の末尾の新しい連番で入り直す。連番は SQLite が書き込みのロックの中で振るので、commit の順と連番の順がそろい、
 * `GET /changes?since=` で頁を送っている途中に書き換えられた行も、後ろの頁で必ず降りてくる。JS で連番を計算しない。
 * 2 文目が実際に入れたかどうか（`meta.changes`）で、採った数を数える。
 *
 * 2 文目の `where not exists` は連番の欠番を防ぐためにある。
 * `on conflict do nothing` だけだと、入れなかった行にも SQLite が連番を 1 つ使い、捨てた行の数だけ連番が飛ぶ（miniflare で確かめた）。
 * `on conflict` は守りとして残す。
 * 中身（`sealed`）は封じたバイト列のまま BLOB に置く。Worker は開けない。
 */
const writeRow = (db: D1Database, c: SealedChangeIn, deviceId: string): [D1PreparedStatement, D1PreparedStatement] => [
  db.prepare('delete from rows where k = ? and updated_at < ?').bind(c.k, c.updatedAt),
  db
    .prepare('insert into rows (k, op, updated_at, device_id, epoch, sealed) select ?, ?, ?, ?, ?, ? where not exists (select 1 from rows where k = ?) on conflict(k) do nothing')
    .bind(c.k, c.op, c.updatedAt, deviceId, c.epoch, sealedToBlob(c.sealed), c.k),
];

export const changesApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/** 端末から届いた封じた行を受ける。行ごとに `updated_at` の新しい方を採り、採った行には表の末尾の連番が付く。 */
changesApp.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { changes?: unknown } | null;
  if (!body || !Array.isArray(body.changes) || body.changes.length > MAX_PUSH_BATCH || !body.changes.every(isChange)) return c.json({ error: 'invalid body' }, 400);
  const device = c.get('device');
  const db = c.env.DB;
  const now = Date.now();
  const incoming = body.changes as SealedChangeIn[];
  // 大きすぎる行は名指しで断る。端末はその行だけを諦めて、残りを送り直せばよい。
  const oversize = incoming.filter((x) => x.sealed.length > MAX_ROW_BYTES);
  if (oversize.length) {
    const first = oversize[0]!;
    return c.json(
      {
        error: 'payload too large',
        limit: MAX_ROW_BYTES,
        count: oversize.length,
        // 名指しは先頭の 1 件だけにする。全部並べると本文が 200 字を超え、端末の側で JSON として読めなくなる。
        // 端末は名指しされた 1 件を落として送り直せばよく、次の 1 件があれば次の 413 で名指しされる。
        // k は 43 字に決まっているので、切り詰めは要らない。
        row: { k: first.k, bytes: first.sealed.length },
      },
      413,
    );
  }
  // 大きさの収まった行は、字の形（詰め物の無い base64url）を確かめてから BLOB に戻す。
  if (!incoming.every((x) => isSealedText(x.sealed, MAX_ROW_BYTES))) return c.json({ error: 'invalid body' }, 400);
  // 同じ鍵の重複は updatedAt の大きい方だけを見る。
  const latest = new Map<string, SealedChangeIn>();
  let skipped = 0;
  for (const row of incoming) {
    const cur = latest.get(row.k);
    if (!cur) latest.set(row.k, row);
    else {
      skipped++;
      if (row.updatedAt > cur.updatedAt) latest.set(row.k, row);
    }
  }
  const stmts: D1PreparedStatement[] = [];
  // 行ごとの insert の位置。meta.changes を読んで採った数を数える。
  const inserts: number[] = [];
  for (const row of latest.values()) {
    const [del, ins] = writeRow(db, row, device.id);
    stmts.push(del);
    inserts.push(stmts.push(ins) - 1);
  }
  const touch = touchIfDue(db, device, now);
  if (touch) stmts.push(touch);
  // 高水位は同じ batch（1 つの取引）の中で読む。別の要求に割り込まれた値を返さない。
  const maxAt = stmts.push(maxSeqStmt(db)) - 1;
  const results = await db.batch(stmts);
  const accepted = inserts.filter((i) => Number(results[i]?.meta?.changes ?? 0) > 0).length;
  skipped += latest.size - accepted;
  const res: PushChangesResponse = { seq: firstNum(results[maxAt] as D1Result<{ s: number }> | undefined), accepted, skipped };
  return c.json(res);
});

type PeerRow = { id: string; last_seen_at: number | null };
/** epoch は依頼を封じたスマホ用の鍵の世代（互換の版 9）。 */
type LaunchRow = { id: string; created_at: number; sealed: string; epoch: number; from_device: string };

/**
 * 1 回の pull に載せる起動の依頼の上限。
 * スマホ 1 台は 10 分に 10 件まで（mobile.ts の LAUNCH_RATE）で、依頼は 75 秒で時間切れになるので、ふつうはこれに届かない。
 * 届いたときは古い順に返し、残りは次の pull で降りる。
 */
const PULL_LAUNCH_LIMIT = 50;

/**
 * 自端末以外の行を連番の昇順で返す。
 * 頁は `limit` 行か、`sealed` の合計が `MAX_PAGE_SEALED_CHARS` を超えたところで切り、続きがあれば `more` を立てる。
 * 名簿の印の行（`~roster`）もほかの行と同じく返す。見た PC だけが名簿と keybox を読み直す。
 * 解除していない PC の最終確認（peers）と、Worker の時刻（now）を添える。端末は「now − lastSeenAt」を PC の年齢として、他の PC の生存を見る。
 * この PC 宛ての起動の依頼（launches）も添える。要求を増やさずに、PC の 30 秒ごとの pull で依頼を受け取るためである。
 * 依頼には送り手のスマホの ID（from）を添える。PC は名簿でスマホの名前を引き、右下の通知に出す（試作 F1）。ID は devices の行と同じで、名前は名簿の中にしか無い。
 * 変更ログを持たないので、どれだけ古い since でも断らない（版 5 までの 410 は無くなった）。
 */
changesApp.get('/', async (c) => {
  const device = c.get('device');
  const db = c.env.DB;
  const since = Math.max(Number(c.req.query('since') ?? 0) || 0, 0);
  const limit = clampLimit(c.req.query('limit'));
  const now = Date.now();
  const touch = touchIfDue(db, device, now);
  // 頁と高水位と生存を 1 つの batch（1 つの取引）で読む。
  // 別々に読むと、間に入った push の行を高水位だけが越えて、この端末がその行を読み飛ばす。
  const stmts: D1PreparedStatement[] = [
    ...(touch ? [touch] : []),
    pageStmt(db, 'seq > ? and device_id != ?', 'seq', [since, device.id], limit),
    maxSeqStmt(db),
    // スマホ（kind = 'mobile'）は会話を動かさないので、PC の生存に混ぜない。
    db.prepare("select id, last_seen_at from devices where revoked_at is null and kind = 'pc' order by id"),
    // この PC 宛ての、まだ受け取っていない依頼（互換の版 7）。索引 launch_requests_target で引き、表を走査しない。
    // 時間切れの行は書き換えずに外すだけである（expired に書き換えるのはスマホの GET だけ）。
    db
      .prepare("select id, created_at, sealed, epoch, from_device from launch_requests where target_device = ? and status = 'pending' and created_at > ? order by created_at limit ?")
      .bind(device.id, now - LAUNCH_TTL_MS, PULL_LAUNCH_LIMIT),
  ];
  const results = await db.batch(stmts);
  const off = touch ? 1 : 0;
  const { page, more, last } = await cutPage(db, (results[off]?.results ?? []) as PagedRow[], limit);
  // 最後まで返せたときは表全体の末尾まで進める。自端末の行で止まったままにしないためである。
  const nextSeq = more ? last!.seq : firstNum(results[off + 1] as D1Result<{ s: number }> | undefined);
  const peers: CloudPeer[] = ((results[off + 2]?.results ?? []) as PeerRow[]).map((p) => ({ id: p.id, lastSeenAt: p.last_seen_at ?? null }));
  const launches: MobileLaunchOut[] = ((results[off + 3]?.results ?? []) as LaunchRow[]).map((l) => ({ id: l.id, createdAt: l.created_at, sealed: l.sealed, epoch: Number(l.epoch), from: l.from_device }));
  const res: SealedPullChangesResponse = { changes: page.map(toOut), nextSeq, more, peers, now, launches };
  return c.json(res);
});

export const rowsApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/** rows の写しを k 順に返す。新しい端末の初回の取り込みが使う。自端末の行も含める。k の一意の索引で引く。 */
rowsApp.get('/', async (c) => {
  const db = c.env.DB;
  const after = c.req.query('after') ?? '';
  const limit = clampLimit(c.req.query('limit'));
  const results = await db.batch([pageStmt(db, 'k > ?', 'k', [after], limit), maxSeqStmt(db)]);
  const { page, more, last } = await cutPage(db, (results[0]?.results ?? []) as PagedRow[], limit);
  const res: SealedSnapshotResponse = { changes: page.map(toOut), nextAfter: more ? last!.k : null, seq: firstNum(results[1] as D1Result<{ s: number }> | undefined) };
  return c.json(res);
});
