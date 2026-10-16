import { Hono } from 'hono';
import type { MobileInboxResponse, MobileJoinRequest, MobileJoinResponse, MobilePairingResponse } from '@agent-hangar/shared';
import { authMiddleware, requireKind } from './auth.ts';
import type { Env, Vars } from './env.ts';
import { isSafeName, issueDeviceToken } from './join.ts';
import { seenOf, touchIfDue } from './seen.ts';
import { randomToken, sha256Hex } from './util.ts';

/**
 * スマホの口（互換の版 7）。app.ts が `/m` に載せる。
 *
 * スマホは参加の秘密を持たない。
 * PC が `POST /m/pairings` で取った使い捨ての券（5 分で失効、1 回で使い切り）を QR で渡し、スマホは `POST /m/join` で券をスマホ用のトークンに替える。
 * スマホの行は devices に `kind = 'mobile'` で入り、そのトークンが通るのはこのファイルのスマホ用の口だけである（auth.ts の requireKind）。
 * 受信箱の素は PC が暗号化して置き、Worker は PC の ID と更新時刻のほかは読めない。
 *
 * 表は `rows` に足さず、専用の表（mobile_feeds、mobile_pairings）に置く。
 * 版 6 の PC は知らない表を pull せず、push も断られないので、同期から締め出されない。
 *
 * 経路を足すときは、参加の口のほかは必ず authMiddleware と requireKind を付ける。
 */

/** 券の有効期間。QR の写真や履歴が残っても、この時間を過ぎれば使えない。 */
export const PAIRING_TTL_MS = 5 * 60_000;
/** 1 台の PC が券を取れる回数。盗まれた PC のトークンで D1 の書き込みの枠を食い潰させない。 */
export const PAIRING_RATE = { max: 5, windowMs: 10 * 60_000 } as const;
/** 使った券も使わなかった券も、この時間を過ぎた行は券を取るついでに消す。 */
export const PAIRING_KEEP_MS = 24 * 60 * 60_000;
/** 券の文字数の上限。実物は 22 字（randomToken(16)）なので、長い入力は貼り間違いか攻撃である。 */
const MAX_CODE_CHARS = 64;
/** PUT /m/feed の本文の上限。受信箱の素は暗号化の前で 48 KiB までなので、暗号化と base64 の膨らみを見込んでも収まる。 */
export const MAX_FEED_BODY_BYTES = 64 * 1024;

const ENC = new TextEncoder();
const deny = 'unauthorized';

export const mobileApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * PC がペアリングの券を取る。
 * 返すのは平文の券で、D1 には SHA-256 だけを置く。
 * 数えるのと入れるのを 1 つの文にして、同時に来た要求で上限を越えさせない（索引 mobile_pairings_by で数える）。
 */
mobileApp.post('/pairings', authMiddleware(), requireKind('pc'), async (c) => {
  const device = c.get('device');
  const db = c.env.DB;
  const now = Date.now();
  const code = randomToken(16);
  const results = await db.batch([
    db.prepare('delete from mobile_pairings where created_at < ?').bind(now - PAIRING_KEEP_MS),
    db
      .prepare('insert into mobile_pairings (code_hash, created_by, created_at, used_at) select ?, ?, ?, null where (select count(*) from mobile_pairings where created_by = ? and created_at > ?) < ?')
      .bind(await sha256Hex(code), device.id, now, device.id, now - PAIRING_RATE.windowMs, PAIRING_RATE.max),
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) !== 1) return c.json({ error: 'rate limited' }, 429);
  const res: MobilePairingResponse = { code, expiresAt: now + PAIRING_TTL_MS };
  return c.json(res, 201);
});

const isJoinBody = (v: unknown): v is MobileJoinRequest => {
  const o = v as Partial<MobileJoinRequest> | null;
  return (
    !!o &&
    typeof o.code === 'string' &&
    o.code.length > 0 &&
    o.code.length <= MAX_CODE_CHARS &&
    !!o.device &&
    typeof o.device === 'object' &&
    typeof o.device.name === 'string' &&
    isSafeName(o.device.name)
  );
};

/**
 * スマホが券をスマホ用のトークンに替える。トークンは要らない。
 *
 * 券を使い切りにする書き換え（まだ使っておらず、期限内のものだけ）が 1 行を変えたときだけ参加させる。
 * それ以外は、無い券も、使った券も、期限切れの券も、参加の秘密を渡されたときも、同じ 401 で断る。
 * 参加の秘密はここでは照合しない。スマホは PC として参加できない。
 *
 * スマホの行の ID は Worker が新しく振る。
 * スマホが名乗る ID（`device.id`）は使わないので、既にある行（PC の行や、外したスマホの行）を指して上書きすることはできない。
 * 外したスマホの行は残り、新しい券で参加し直すと別の行になる。
 */
mobileApp.post('/join', async (c) => {
  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!isJoinBody(body)) return c.json({ error: 'invalid body' }, 400);
  const db = c.env.DB;
  const now = Date.now();
  const used = await db
    .prepare('update mobile_pairings set used_at = ? where code_hash = ? and used_at is null and created_at > ?')
    .bind(now, await sha256Hex(body.code), now - PAIRING_TTL_MS)
    .run();
  if (Number(used.meta?.changes ?? 0) !== 1) return c.json({ error: deny }, 401);
  const id = crypto.randomUUID();
  const { token, tokenHash } = await issueDeviceToken();
  const seen = seenOf(c);
  await db
    .prepare(
      "insert into devices (id, name, platform, token_hash, joined_at, last_seen_at, last_pulled_seq, revoked_at, last_ip, last_city, last_region, last_country, kind) values (?, ?, 'mobile', ?, ?, ?, 0, null, ?, ?, ?, ?, 'mobile')",
    )
    .bind(id, body.device.name, tokenHash, now, now, seen.ip, seen.city, seen.region, seen.country)
    .run();
  const res: MobileJoinResponse = { token, deviceId: id };
  return c.json(res, 201);
});

/**
 * PC が受信箱の素（暗号化した JSON）を置く。PC ごとに 1 行で、2 回目からは上書きする。
 * 中身は読まず、文字列であることと大きさだけを見る。
 */
mobileApp.put('/feed', authMiddleware(), requireKind('pc'), async (c) => {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_FEED_BODY_BYTES) return c.json({ error: 'payload too large', limit: MAX_FEED_BODY_BYTES }, 413);
  const text = await c.req.text();
  if (ENC.encode(text).byteLength > MAX_FEED_BODY_BYTES) return c.json({ error: 'payload too large', limit: MAX_FEED_BODY_BYTES }, 413);
  let body: { sealed?: unknown } | null = null;
  try {
    body = JSON.parse(text) as { sealed?: unknown } | null;
  } catch {
    body = null;
  }
  if (!body || typeof body.sealed !== 'string' || body.sealed.length === 0) return c.json({ error: 'invalid body' }, 400);
  const device = c.get('device');
  const db = c.env.DB;
  const now = Date.now();
  const stmts = [
    db
      .prepare('insert into mobile_feeds (device_id, sealed, updated_at) values (?, ?, ?) on conflict(device_id) do update set sealed = excluded.sealed, updated_at = excluded.updated_at')
      .bind(device.id, body.sealed, now),
  ];
  const touch = touchIfDue(db, device, now, seenOf(c));
  if (touch) stmts.push(touch);
  await db.batch(stmts);
  return c.json({ ok: true, updatedAt: now });
});

type InboxDeviceRow = { id: string; name: string; platform: string; last_seen_at: number | null };
type InboxFeedRow = { device_id: string; updated_at: number; sealed: string };

/**
 * スマホが受信箱を読む。
 * 読むのは devices と mobile_feeds だけで、どちらも PC の数の行である。rows は読まない。
 * 解除した PC と、スマホの行は出さない。解除した PC が前に置いた素も出さない。
 */
mobileApp.get('/inbox', authMiddleware(), requireKind('mobile'), async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const [devices, feeds] = await db.batch([
    db.prepare("select id, name, platform, last_seen_at from devices where kind = 'pc' and revoked_at is null order by joined_at, id"),
    db.prepare("select f.device_id, f.updated_at, f.sealed from mobile_feeds f join devices d on d.id = f.device_id where d.kind = 'pc' and d.revoked_at is null order by f.device_id"),
  ]);
  const res: MobileInboxResponse = {
    now,
    devices: ((devices?.results ?? []) as InboxDeviceRow[]).map((d) => ({ id: d.id, name: d.name, platform: d.platform, lastSeenAt: d.last_seen_at ?? null })),
    feeds: ((feeds?.results ?? []) as InboxFeedRow[]).map((f) => ({ deviceId: f.device_id, updatedAt: f.updated_at, sealed: f.sealed })),
  };
  return c.json(res);
});
