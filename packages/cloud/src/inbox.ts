import { Hono, type Context } from 'hono';
import {
  EVENT_BODY_MAX_BYTES,
  EVENT_INBOX_ACK_MAX,
  EVENT_INBOX_PENDING_MAX,
  EVENT_INBOX_PULL_PAGE,
  EVENT_INBOX_RATE_PER_MIN,
  fromBase64UrlLen,
  sealToInbox,
  type EventInboxCreated,
  type EventInboxPending,
} from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';
import { readLimitedJson, ringBell } from './mobile.ts';
import { randomToken } from './util.ts';

/**
 * 受け箱の口（互換の版 12、#563）。
 *
 * `inboxApp`（`/inboxes`）は PC の端末トークンが要る。
 * 認証と種類の検査（PC だけ）は app.ts の一覧が付ける。
 * `hooksApp`（`/hooks`）は外のサービス（GitHub など）が叩くので、認証も互換の版の見出しも求めない（compat.ts が通す）。
 * 受け箱の ID は 128 ビットの乱数で、URL を知っていることが送る資格である。
 * 署名の検証は PC が行う（Worker は秘密を持たない）。
 *
 * 届いた見出しと本文は、受け箱の公開鍵で封じてから D1 に置く（shared の e2e/inbox.ts）。
 * Worker は平文を置かず、返り値にも中身を入れない。
 * 受け箱は PC ごとの鍵の対を持ち、秘密鍵は PC から出ない。
 *
 * 荷物は引き取られる（POST /inboxes/ack）まで預かり、受け箱 1 つにつき EVENT_INBOX_PENDING_MAX 通までである。
 * 越えた荷物は捨てて 202 を返し、数だけ dropped に残す。
 * 外へは捨てたことを教えない。
 * 引き取られない荷物は sweep.ts が 7 日で消す。
 */

/**
 * 受け箱の ID の形。
 * peerLaunch.ts と同じ。
 */
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/**
 * POST /inboxes の本文の上限。
 * 公開鍵は 43 字なので、枠だけ見込めば足りる。
 */
const MAX_CREATE_BODY_BYTES = 1024;
/**
 * POST /inboxes/ack の本文の上限。
 * ids は 100 個までで、1 つが 64 字を超えない。
 */
const MAX_ACK_BODY_BYTES = 16 * 1024;
/** 1 分の枠の長さ。 */
const RATE_WINDOW_MS = 60_000;
/**
 * 枠を覚えておく受け箱の数の上限。
 * 知らない ID を撒かれても、覚える数で isolate の記憶を食わせない。
 */
const RATE_MAP_MAX = 5000;

export const inboxApp = new Hono<{ Bindings: Env; Variables: Vars }>();
export const hooksApp = new Hono<{ Bindings: Env; Variables: Vars }>();

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

/**
 * 受け箱ごとの 1 分の枠。
 * 最初の要求から 60 秒を 1 つの枠にして、数える。
 * isolate ごとの記憶なので、isolate が替わる、または複数あると枠は緩む。
 * D1 に書かずに済み、外から叩ける口が D1 の書き込みを食わない。
 * 枠は時計の分に合わせない。
 * 合わせると、分の境目をまたぐ連打が 2 倍通る。
 */
const rate = new Map<string, { start: number; count: number }>();

/**
 * 受け箱の枠を 1 つ使う。
 * 上限を越えていたら false。
 */
function takeRate(inboxId: string, now: number): boolean {
  const cur = rate.get(inboxId);
  if (cur && now - cur.start < RATE_WINDOW_MS) {
    if (cur.count >= EVENT_INBOX_RATE_PER_MIN) return false;
    cur.count += 1;
    return true;
  }
  if (!cur && rate.size >= RATE_MAP_MAX) {
    for (const [k, v] of rate) if (now - v.start >= RATE_WINDOW_MS) rate.delete(k);
    if (rate.size >= RATE_MAP_MAX) rate.clear();
  }
  rate.set(inboxId, { start: now, count: 1 });
  return true;
}

/**
 * 本文を上限つきで読む。
 * 上限を越えたら null を返し、残りは読まない。
 */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const body = req.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** 鳴らすのは応答を待たず、失敗しても荷物は預かったまま返す（PC は 30 秒の取得で拾う）。 */
function ring(c: Ctx, target: string, inboxId: string): void {
  const rang = ringBell(c.env, target, { kind: 'event', id: inboxId });
  try {
    c.executionCtx.waitUntil(rang);
  } catch {
    // 実行の文脈が無い（Worker の外で app を叩いた）。
    // 鳴らすのは捨ててよい。
  }
}

const isPublicKey = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 64) return false;
  try {
    fromBase64UrlLen(v, 32, '受け箱の公開鍵');
    return true;
  } catch {
    return false;
  }
};

/**
 * 受け箱を作る。
 * 宛先の PC は、トークンの端末である。
 */
inboxApp.post('/', async (c) => {
  const read = await readLimitedJson(c, MAX_CREATE_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large', limit: MAX_CREATE_BODY_BYTES }, 413);
  const body = read.value as { publicKey?: unknown } | null;
  if (!body || !isPublicKey(body.publicKey)) return c.json({ error: 'invalid body' }, 400);
  const inboxId = randomToken(16);
  await c.env.DB.prepare('insert into event_inboxes (id, device_id, public_key, created_at, dropped) values (?, ?, ?, ?, 0)')
    .bind(inboxId, c.get('device').id, body.publicKey, Date.now())
    .run();
  const res: EventInboxCreated = { inboxId };
  return c.json(res, 201);
});

/**
 * 預かっている荷物を、古い順に 1 ページ分返す（EVENT_INBOX_PULL_PAGE 通）。
 * 自分の受け箱の分だけである。
 * dropped は、捨てた荷物がある自分の受け箱だけを並べる。
 * ack で 0 に戻る。
 */
inboxApp.get('/pending', async (c) => {
  const device = c.get('device');
  const db = c.env.DB;
  const [items, dropped] = await db.batch([
    db
      .prepare('select p.id as id, p.inbox_id as inbox_id, p.sealed as sealed, p.received_at as received_at from event_parcels p join event_inboxes i on i.id = p.inbox_id where i.device_id = ? order by p.received_at, p.id limit ?')
      .bind(device.id, EVENT_INBOX_PULL_PAGE),
    db.prepare('select id, dropped from event_inboxes where device_id = ? and dropped > 0 order by created_at, id').bind(device.id),
  ]);
  const res: EventInboxPending = {
    items: ((items?.results ?? []) as { id: string; inbox_id: string; sealed: string; received_at: number }[]).map((r) => ({ id: r.id, inboxId: r.inbox_id, sealed: r.sealed, receivedAt: Number(r.received_at) })),
    dropped: ((dropped?.results ?? []) as { id: string; dropped: number }[]).map((r) => ({ inboxId: r.id, count: Number(r.dropped) })),
  };
  return c.json(res);
});

/**
 * 引き取った荷物を消し、自分の受け箱の dropped を 0 に戻す。
 * 消せるのは自分の受け箱の荷物だけで、ほかの PC の荷物の ID が混ざっても何も起きない。
 * 引き取りと ack の間に捨てられた分は、数えないまま 0 に戻る。
 */
inboxApp.post('/ack', async (c) => {
  const read = await readLimitedJson(c, MAX_ACK_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large', limit: MAX_ACK_BODY_BYTES }, 413);
  const body = read.value as { ids?: unknown } | null;
  if (!body || !Array.isArray(body.ids) || body.ids.length > EVENT_INBOX_ACK_MAX || body.ids.some((i) => typeof i !== 'string' || i.length === 0 || i.length > 64)) {
    return c.json({ error: 'invalid body' }, 400);
  }
  const device = c.get('device');
  const db = c.env.DB;
  await db.batch([
    db.prepare('delete from event_parcels where id in (select value from json_each(?)) and inbox_id in (select id from event_inboxes where device_id = ?)').bind(JSON.stringify(body.ids), device.id),
    db.prepare('update event_inboxes set dropped = 0 where device_id = ? and dropped > 0').bind(device.id),
  ]);
  return c.json({ ok: true });
});

/**
 * 受け箱を消す。
 * 預かっていた荷物も消す。
 * 自分の受け箱だけで、ほかの PC の ID と無い ID は 404 である。
 */
inboxApp.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const device = c.get('device');
  const db = c.env.DB;
  // 荷物を先に消す。
  // 受け箱を先に消すと、荷物の持ち主を引けなくなる。
  const [, gone] = await db.batch([
    db.prepare('delete from event_parcels where inbox_id in (select id from event_inboxes where id = ? and device_id = ?)').bind(id, device.id),
    db.prepare('delete from event_inboxes where id = ? and device_id = ?').bind(id, device.id),
  ]);
  if (Number(gone?.meta?.changes ?? 0) !== 1) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

type InboxRow = { id: string; device_id: string; public_key: string };

/**
 * 外から来る webhook を受ける。
 * 本文は何であってもよい（JSON とは限らない）。
 * 知らない ID と、解除された PC の受け箱は 404 である。
 * 本文が EVENT_BODY_MAX_BYTES を超えれば 413、1 分の枠を越えれば 429 を返す。
 * 預かりが上限なら 202 を返して捨て、dropped を 1 増やす。
 * それ以外は封じて置き、持ち主の呼び鈴を鳴らして 202 を返す。
 * 返り値は `{ ok: true }` だけで、中身も捨てたかどうかも入れない。
 */
hooksApp.post('/:inboxId', async (c) => {
  const inboxId = c.req.param('inboxId');
  if (!ID_RE.test(inboxId)) return c.json({ error: 'not found' }, 404);
  const now = Date.now();
  // 知らない ID も数える（枠の記憶には上限がある）。
  // D1 を読む前に断る。
  if (!takeRate(inboxId, now)) return c.json({ error: 'rate limited' }, 429);
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > EVENT_BODY_MAX_BYTES) return c.json({ error: 'payload too large', limit: EVENT_BODY_MAX_BYTES }, 413);
  const db = c.env.DB;
  const inbox = await db
    .prepare("select i.id as id, i.device_id as device_id, i.public_key as public_key from event_inboxes i join devices d on d.id = i.device_id where i.id = ? and d.kind = 'pc' and d.revoked_at is null")
    .bind(inboxId)
    .first<InboxRow>();
  if (!inbox) return c.json({ error: 'not found' }, 404);
  const text = await readCapped(c.req.raw, EVENT_BODY_MAX_BYTES);
  if (text === null) return c.json({ error: 'payload too large', limit: EVENT_BODY_MAX_BYTES }, 413);
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const sealed = await sealToInbox(inbox.public_key, inbox.id, { receivedAt: now, headers, body: text });
  // 数えるのと入れるのを 1 つの文にして、同時に来た要求で上限を越えさせない。
  // 受け箱が消えていれば入れない。
  const ins = await db
    .prepare('insert into event_parcels (id, inbox_id, sealed, received_at) select ?, ?, ?, ? where exists (select 1 from event_inboxes where id = ?) and (select count(*) from event_parcels where inbox_id = ?) < ?')
    .bind(randomToken(16), inbox.id, sealed, now, inbox.id, inbox.id, EVENT_INBOX_PENDING_MAX)
    .run();
  if (Number(ins.meta?.changes ?? 0) === 1) {
    ring(c, inbox.device_id, inbox.id);
    return c.json({ ok: true }, 202);
  }
  // 入らなかった。
  // 受け箱が消えたか、預かりが上限である。
  const dropped = await db.prepare('update event_inboxes set dropped = dropped + 1 where id = ?').bind(inbox.id).run();
  if (Number(dropped.meta?.changes ?? 0) !== 1) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 202);
});
