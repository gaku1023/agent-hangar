import { Hono, type Context } from 'hono';
import {
  PEER_ANSWER_SEALED_MAX,
  PEER_LAUNCH_RATE,
  PEER_LAUNCH_SEALED_MAX,
  PEER_LAUNCH_TTL_MS,
  PEER_OUTBOX_LIMIT,
  PEER_RESULT_SEALED_MAX,
  PEER_RESULTS_MAX,
  PEER_RESULTS_PAGE,
  peerSealEpoch,
  type PeerLaunchState,
  type PeerLaunchStatus,
  type PeerOutboxResponse,
  type PeerResultAck,
  type PeerResultsResponse,
} from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';
import { readLimitedJson, ringBell } from './mobile.ts';

/**
 * PC から PC への起動の頼みの口（互換の版 10）。app.ts が `/launches` に載せる。
 *
 * 認証と種類の検査（PC だけ）は app.ts の一覧が付ける。スマホのトークンはここへ届かない（403）。
 * 頼み・答え・結果の中身（sealed）は PC どうしの鍵で封じたまま置き、Worker は開かない（shared の e2e/peer.ts）。
 * 封は不透明な文字列で、頭の世代と形だけを見る。
 *
 * 送り手は端末トークンで決める。本文に from があっても、それがトークンの送り手と違えば 403 で断る（封の AAD は from の詐称を防がない）。
 * 結果の行を書けるのは頼みの宛先の PC だけ、読めるのは頼んだ PC だけである。
 *
 * 表は peer_launches と peer_results である。スマホの launch_requests とは分ける。
 * 向きが PC から PC で、鍵の世代の持ち方（封の頭）も、結果の行があることも違い、広げるとスマホの経路の条件に触れるためである。
 * 頼まれた PC は pull（changes.ts の peerLaunches）で受け取り、claim と answer で状態を進める。
 * 頼んだ PC は `GET /launches/mine` で自分の頼みの状態と結果の数を取り、`GET /launches/:id/results` で結果の行を読む。
 * どれも呼び鈴が切れていても 30 秒ごとの取得で届く。呼び鈴は速くするだけである。
 */

/** 頼みと結果の行を残す期間。最後に動いた時刻（updated_at）から数え、過ぎた行は頼みを置くついでに消す。 */
export const PEER_LAUNCH_KEEP_MS = 7 * 24 * 60 * 60_000;
/** POST /launches の本文の上限。封は PEER_LAUNCH_SEALED_MAX 字までで、JSON の枠に余裕を見て 64 KiB にする。 */
export const MAX_PEER_LAUNCH_BODY_BYTES = 64 * 1024;
/** POST /launches/:id/results の本文の上限。 */
export const MAX_PEER_RESULT_BODY_BYTES = 64 * 1024;
/** 答えの本文の上限。 */
export const MAX_PEER_ANSWER_BODY_BYTES = 16 * 1024;
/** 頼みの ID の形。長さは 64 字まで。 */
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_SEQ = 1_000_000;

export const peerApp = new Hono<{ Bindings: Env; Variables: Vars }>();

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

type Row = { id: string; to_device: string; from_device: string; status: PeerLaunchState; created_at: number; updated_at: number; sealed_answer: string | null; result_seq: number };
const SELECT = 'select id, to_device, from_device, status, created_at, updated_at, sealed_answer, result_seq from peer_launches';

const statusOf = (r: Row): PeerLaunchStatus => ({ id: r.id, to: r.to_device, status: r.status, sealedAnswer: r.sealed_answer ?? null, resultSeq: Number(r.result_seq), updatedAt: Number(r.updated_at) });

const isSealed = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && peerSealEpoch(v) !== null;

/** 受け取られないまま期限を過ぎた、自分の頼みを expired にする。書き換えるのは、呼ぶ側が読むときだけである。 */
const expireStale = (db: D1Database, from: string, now: number): D1PreparedStatement =>
  db.prepare("update peer_launches set status = 'expired', updated_at = ? where from_device = ? and status = 'pending' and created_at <= ?").bind(now, from, now - PEER_LAUNCH_TTL_MS);

/** 鳴らすのは応答を待たず、失敗しても頼みは成功のまま返す（相手は 30 秒の取得で拾う）。 */
function ring(c: Ctx, target: string, kind: 'launch' | 'answer' | 'result', id: string): void {
  const rang = ringBell(c.env, target, { kind, id });
  try {
    c.executionCtx.waitUntil(rang);
  } catch {
    // 実行の文脈が無い（Worker の外で app を叩いた）。鳴らすのは捨ててよい。
  }
}

/**
 * 頼みを置く。本文は `{ id, to, sealed, from? }`。
 * 宛先は解除されていない PC で、自分自身ではないこと。スマホと無い ID は 404 である。
 * 同じ ID の再送は行を増やさず今の状態を返す（回数にも数えない）。ほかの PC の ID と重なったら 409 で、その行の中身は返さない。
 * 回数の上限（PEER_LAUNCH_RATE）は、数えるのと入れるのを 1 つの文にして、同時に来た要求で越えさせない。
 * 残す期間（PEER_LAUNCH_KEEP_MS）を過ぎた行は、ここでついでに消す。
 */
peerApp.post('/', async (c) => {
  const read = await readLimitedJson(c, MAX_PEER_LAUNCH_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large', limit: MAX_PEER_LAUNCH_BODY_BYTES }, 413);
  const body = read.value as { id?: unknown; to?: unknown; sealed?: unknown; from?: unknown } | null;
  if (!body || typeof body.id !== 'string' || !ID_RE.test(body.id) || typeof body.to !== 'string' || body.to.length === 0 || body.to.length > 128 || !isSealed(body.sealed, PEER_LAUNCH_SEALED_MAX)) {
    return c.json({ error: 'invalid body' }, 400);
  }
  const device = c.get('device');
  if (body.from !== undefined && body.from !== device.id) return c.json({ error: 'forbidden' }, 403);
  if (body.to === device.id) return c.json({ error: 'cannot launch on self' }, 400);
  const { id, to, sealed } = body as { id: string; to: string; sealed: string };
  const db = c.env.DB;
  const now = Date.now();
  const cutoff = now - PEER_LAUNCH_KEEP_MS;
  const [, , existing, target] = await db.batch([
    db.prepare('delete from peer_results where request_id in (select id from peer_launches where updated_at < ?)').bind(cutoff),
    db.prepare('delete from peer_launches where updated_at < ?').bind(cutoff),
    db.prepare(`${SELECT} where id = ?`).bind(id),
    db.prepare("select id from devices where id = ? and kind = 'pc' and revoked_at is null").bind(to),
  ]);
  const answerExisting = (row: Row) => (row.from_device === device.id ? c.json(statusOf(row), 201) : c.json({ error: 'conflict' }, 409));
  const prev = existing?.results?.[0] as Row | undefined;
  if (prev) return answerExisting(prev);
  if (!target?.results?.length) return c.json({ error: 'not found' }, 404);
  const ins = await db
    .prepare(
      "insert or ignore into peer_launches (id, to_device, from_device, sealed, status, created_at, updated_at, claimed_at, answered_at, sealed_answer, result_seq) select ?, ?, ?, ?, 'pending', ?, ?, null, null, null, 0 where (select count(*) from peer_launches where from_device = ? and created_at > ?) < ?",
    )
    .bind(id, to, device.id, sealed, now, now, device.id, now - PEER_LAUNCH_RATE.windowMs, PEER_LAUNCH_RATE.max)
    .run();
  if (Number(ins.meta?.changes ?? 0) === 1) {
    ring(c, to, 'launch', id);
    const res: PeerLaunchStatus = { id, to, status: 'pending', sealedAnswer: null, resultSeq: 0, updatedAt: now };
    return c.json(res, 201);
  }
  // 入らなかった。同時に来た同じ ID の再送か、回数の上限である。
  const again = await db.prepare(`${SELECT} where id = ?`).bind(id).first<Row>();
  if (again) return answerExisting(again);
  return c.json({ error: 'rate limited' }, 429);
});

/**
 * 呼ぶ側が、since 以降に動いた自分の頼みを読む（呼び鈴が切れていても届く 30 秒の取得）。
 * 受け取られないまま期限を過ぎた頼みは、ここで expired に書き換えてから返す。
 * now は次に渡す since の元で、同じ ms の書き込みを取りこぼさないよう、端末は数秒の重なりを取って読み直す（読み直しは冪等）。
 * `/:id` より先に置く。
 */
peerApp.get('/mine', async (c) => {
  const device = c.get('device');
  const db = c.env.DB;
  const since = Math.max(Number(c.req.query('since') ?? 0) || 0, 0);
  const now = Date.now();
  const [, rows] = await db.batch([
    expireStale(db, device.id, now),
    db.prepare(`${SELECT} where from_device = ? and updated_at >= ? order by updated_at, id limit ?`).bind(device.id, since, PEER_OUTBOX_LIMIT),
  ]);
  const res: PeerOutboxResponse = { now, launches: ((rows?.results ?? []) as Row[]).map(statusOf) };
  return c.json(res);
});

/** 呼ぶ側が自分の頼みの状態を読む。ほかの PC の頼みは 404 である。 */
peerApp.get('/:id', async (c) => {
  const device = c.get('device');
  const db = c.env.DB;
  const [, row] = await db.batch([expireStale(db, device.id, Date.now()), db.prepare(`${SELECT} where id = ? and from_device = ?`).bind(c.req.param('id'), device.id)]);
  const r = row?.results?.[0] as Row | undefined;
  return r ? c.json(statusOf(r)) : c.json({ error: 'not found' }, 404);
});

/**
 * 宛先の PC が頼みを受け取る。
 * 1 つの条件つきの書き換えで、自分宛てで、まだ誰も受け取っておらず、期限の内の行だけを claimed にする。
 * 1 行を変えたときだけ 200 で、それ以外（2 回目、宛先でない PC、送り手、期限切れ、無い ID）は 409 である。PC は 200 のときだけ起動する。
 */
peerApp.post('/:id/claim', async (c) => {
  const now = Date.now();
  const r = await c.env.DB.prepare("update peer_launches set status = 'claimed', claimed_at = ? where id = ? and to_device = ? and status = 'pending' and created_at > ?")
    .bind(now, c.req.param('id'), c.get('device').id, now - PEER_LAUNCH_TTL_MS)
    .run();
  return Number(r.meta?.changes ?? 0) === 1 ? c.json({ ok: true }) : c.json({ error: 'conflict' }, 409);
});

/**
 * 受け取った PC が答える。答えの中身（sealedAnswer）は封をしたまま置く。
 * 自分が受け取った（claimed の）自分宛ての行だけを started か failed にする。それ以外は 409 である。
 * 通ったら、頼んだ PC の呼び鈴を鳴らす。
 */
peerApp.post('/:id/answer', async (c) => {
  const read = await readLimitedJson(c, MAX_PEER_ANSWER_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large', limit: MAX_PEER_ANSWER_BODY_BYTES }, 413);
  const body = read.value as { ok?: unknown; sealedAnswer?: unknown } | null;
  if (!body || typeof body.ok !== 'boolean' || !isSealed(body.sealedAnswer, PEER_ANSWER_SEALED_MAX)) return c.json({ error: 'invalid body' }, 400);
  const id = c.req.param('id');
  const now = Date.now();
  const r = await c.env.DB.prepare("update peer_launches set status = ?, answered_at = ?, updated_at = ?, sealed_answer = ? where id = ? and to_device = ? and status = 'claimed'")
    .bind(body.ok ? 'started' : 'failed', now, now, body.sealedAnswer, id, c.get('device').id)
    .run();
  if (Number(r.meta?.changes ?? 0) !== 1) return c.json({ error: 'conflict' }, 409);
  const row = await c.env.DB.prepare('select from_device from peer_launches where id = ?').bind(id).first<{ from_device: string }>();
  if (row) ring(c, row.from_device, 'answer', id);
  return c.json({ ok: true });
});

/**
 * 頼まれた PC が結果の行を書く。本文は `{ seq, sealed }` で、seq は 1 から。
 * 書けるのは頼みの宛先の PC だけで、頼みは started のときに限る（答えの付く前と failed には書けない）。それ以外は 409 である。
 * 同じ seq の再送は何も変えずに `{ ok: true, duplicate: true }` で返し、呼び鈴も鳴らさない（上限に達していても通る）。
 * 1 件の頼みに積める行は PEER_RESULTS_MAX までで、新しい seq が超えるときは 429 である。数えるのと入れるのは 1 つの文である。
 * 書けたら頼んだ PC の呼び鈴を鳴らす。
 */
peerApp.post('/:id/results', async (c) => {
  const read = await readLimitedJson(c, MAX_PEER_RESULT_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large', limit: MAX_PEER_RESULT_BODY_BYTES }, 413);
  const body = read.value as { seq?: unknown; sealed?: unknown } | null;
  if (!body || typeof body.seq !== 'number' || !Number.isSafeInteger(body.seq) || body.seq < 1 || body.seq > MAX_SEQ || !isSealed(body.sealed, PEER_RESULT_SEALED_MAX)) {
    return c.json({ error: 'invalid body' }, 400);
  }
  const id = c.req.param('id');
  const device = c.get('device');
  const db = c.env.DB;
  const now = Date.now();
  const ins = await db
    .prepare(
      "insert or ignore into peer_results (request_id, seq, sealed, created_at) select ?, ?, ?, ? where exists (select 1 from peer_launches where id = ? and to_device = ? and status = 'started') and (select count(*) from peer_results where request_id = ?) < ?",
    )
    .bind(id, body.seq, body.sealed, now, id, device.id, id, PEER_RESULTS_MAX)
    .run();
  if (Number(ins.meta?.changes ?? 0) === 1) {
    const [, row] = await db.batch([
      db.prepare('update peer_launches set result_seq = max(result_seq, ?), updated_at = ? where id = ? and to_device = ?').bind(body.seq, now, id, device.id),
      db.prepare('select from_device from peer_launches where id = ?').bind(id),
    ]);
    const from = (row?.results?.[0] as { from_device: string } | undefined)?.from_device;
    if (from) ring(c, from, 'result', id);
    const ack: PeerResultAck = { ok: true, duplicate: false };
    return c.json(ack);
  }
  // 入らなかった。同じ seq の再送か、書けない頼みか、行の数の上限である。
  const [launch, dup] = await db.batch([
    db.prepare("select 1 ok from peer_launches where id = ? and to_device = ? and status = 'started'").bind(id, device.id),
    db.prepare('select 1 ok from peer_results where request_id = ? and seq = ?').bind(id, body.seq),
  ]);
  if (!launch?.results?.length) return c.json({ error: 'conflict' }, 409);
  if (dup?.results?.length) {
    const ack: PeerResultAck = { ok: true, duplicate: true };
    return c.json(ack);
  }
  return c.json({ error: 'rate limited' }, 429);
});

/**
 * 呼ぶ側が結果の行を読む。after より大きい seq を昇順で PEER_RESULTS_PAGE 行まで返し、続きがあれば more を立てる。
 * 読めるのは頼んだ PC だけで、ほかの PC（宛先を含む）は 404 である。
 */
peerApp.get('/:id/results', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const after = Math.max(Math.floor(Number(c.req.query('after') ?? 0)) || 0, 0);
  const mine = await db.prepare('select 1 ok from peer_launches where id = ? and from_device = ?').bind(id, c.get('device').id).first();
  if (!mine) return c.json({ error: 'not found' }, 404);
  const rows = await db.prepare('select seq, sealed, created_at from peer_results where request_id = ? and seq > ? order by seq limit ?').bind(id, after, PEER_RESULTS_PAGE + 1).all<{ seq: number; sealed: string; created_at: number }>();
  const all = rows.results ?? [];
  const res: PeerResultsResponse = { results: all.slice(0, PEER_RESULTS_PAGE).map((r) => ({ seq: Number(r.seq), sealed: r.sealed, createdAt: Number(r.created_at) })), more: all.length > PEER_RESULTS_PAGE };
  return c.json(res);
});
