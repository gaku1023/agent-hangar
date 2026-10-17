import { Hono } from 'hono';
import { NOTICE_RATE, PHONE_NOTICE_SEALED_MAX, PUSH_QUIET_DEFAULT, phoneNoticeEpoch, type NoticeIn, type NoticeOut, type PushKeyOut, type PushSubscriptionPut } from '@agent-hangar/shared';
import { authMiddleware, LIVE_PHONE_SQL, requireKind } from './auth.ts';
import type { Env, Vars } from './env.ts';
import { readLimitedJson } from './mobile.ts';
import { isEpoch } from './util.ts';
import { generateVapidKeys, importVapidKeys, inQuietHours, isPushPublicKey, pushEndpointAllowed, pushRequest, unb64url, type StoredVapid, type VapidKeys } from './webpush.ts';

/**
 * スマホのプッシュ通知（0.9.1）。互換の版は 9 のままで、口と表を足すだけである（古い PC は通知を送らないだけ）。
 *
 * スマホは `GET /m/push/key` で Worker の VAPID の公開鍵を読み、ブラウザで購読して、`PUT /m/push/subscription` で購読を置く。
 * PC は、受信箱で要対応に新しく入った会話の通知をスマホ用の鍵 M で封じ（shared の sealPhoneNotice）、`POST /notices` に送る。
 * Worker は封じた文字列をそのまま Web Push の本文にし、購読の鍵で RFC 8291 の暗号にかけて push サービスへ送る（webpush.ts）。
 * Worker は通知の中身を読めない。
 *
 * VAPID の鍵ペアは、最初に要るときに作って D1 の meta に置く（setup をやり直さなくてよいように）。
 * isolate ごとに一度読んだら覚えておくので、送るたびに読むのは購読の表だけである。
 *
 * D1 に書くのは購読が変わるとき（置く、消す、push サービスが 404 か 410 を返した、スマホの解除）だけである。
 * 回数の上限（1 台の PC から 1 分に 10 回）は D1 に書かずに isolate の記憶で数える。
 * isolate が複数あれば合わせて少し越えうる緩い上限で、越える分は push サービスの側の上限でも抑えられる。
 */

/** meta の鍵。値は StoredVapid の JSON。 */
export const META_VAPID = 'vapid';
/** `PUT /m/push/subscription` の本文の上限。endpoint は 2,048 字までなので、鍵と時間帯を足しても収まる。 */
const MAX_SUBSCRIPTION_BODY_BYTES = 4 * 1024;
/** `POST /notices` の本文の上限。 */
const MAX_NOTICE_BODY_BYTES = 8 * 1024;
/** push サービスの応答を待つ上限。届かない宛先で要求を抱えたままにしない。 */
const PUSH_TIMEOUT_MS = 10_000;
/** tzOffset として受ける幅（分）。実物は -840（UTC+14）から 720（UTC-12）である。 */
const MAX_TZ_OFFSET = 840;
/** auth の長さ（バイト）。RFC 8291 の 16 バイト。 */
const AUTH_LEN = 16;

let vapid: Promise<VapidKeys> | null = null;

/** 覚えている VAPID の鍵を捨てる。D1 を取り替える試験のためだけに使う。 */
export function resetVapidCache(): void {
  vapid = null;
}

/** VAPID の鍵を返す。meta に無ければ作って置く。2 つの isolate が同時に作っても、先に置いた値を両方が使う。 */
function vapidOf(db: D1Database): Promise<VapidKeys> {
  if (!vapid)
    vapid = loadVapid(db).catch((e) => {
      vapid = null;
      throw e;
    });
  return vapid;
}

async function loadVapid(db: D1Database): Promise<VapidKeys> {
  const row = await db.prepare('select value from meta where key = ?').bind(META_VAPID).first<{ value: string }>();
  if (row) return importVapidKeys(JSON.parse(row.value) as StoredVapid);
  const fresh = await generateVapidKeys();
  const [, stored] = await db.batch([
    db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do nothing').bind(META_VAPID, JSON.stringify(fresh)),
    db.prepare('select value from meta where key = ?').bind(META_VAPID),
  ]);
  const value = (stored?.results?.[0] as { value?: string } | undefined)?.value;
  if (!value) throw new Error('vapid is missing');
  return importVapidKeys(JSON.parse(value) as StoredVapid);
}

/** PC ごとの回数の窓（isolate の記憶）。 */
const noticeWindows = new Map<string, { start: number; n: number }>();

/** 回数を 1 つ数え、上限の内なら true。窓の過ぎたものは、表が膨らんだときに掃く。 */
function takeNotice(deviceId: string, now: number): boolean {
  if (noticeWindows.size > 1000) for (const [k, w] of noticeWindows) if (now - w.start >= NOTICE_RATE.windowMs) noticeWindows.delete(k);
  const w = noticeWindows.get(deviceId);
  if (!w || now - w.start >= NOTICE_RATE.windowMs) {
    noticeWindows.set(deviceId, { start: now, n: 1 });
    return true;
  }
  if (w.n >= NOTICE_RATE.max) return false;
  w.n++;
  return true;
}

const isMinuteOfDay = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1440;

type Quiet = { start: number; end: number } | null;

/** 購読の本文を確かめ、置く値にする。形が違えば null。 */
async function parseSubscription(v: unknown): Promise<{ endpoint: string; p256dh: string; auth: string; quiet: Quiet; tzOffset: number } | null> {
  const o = v as Partial<PushSubscriptionPut> | null;
  if (!o || typeof o !== 'object' || !pushEndpointAllowed(o.endpoint)) return null;
  const keys = o.keys as Partial<PushSubscriptionPut['keys']> | undefined;
  if (!keys || typeof keys !== 'object' || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  if (!(await isPushPublicKey(unb64url(keys.p256dh)))) return null;
  if (unb64url(keys.auth)?.length !== AUTH_LEN) return null;
  if (typeof o.tzOffset !== 'number' || !Number.isInteger(o.tzOffset) || Math.abs(o.tzOffset) > MAX_TZ_OFFSET) return null;
  let quiet: Quiet;
  if (o.quiet === undefined) quiet = { ...PUSH_QUIET_DEFAULT };
  else if (o.quiet === null) quiet = null;
  else if (typeof o.quiet === 'object' && isMinuteOfDay(o.quiet.start) && isMinuteOfDay(o.quiet.end)) quiet = { start: o.quiet.start, end: o.quiet.end };
  else return null;
  return { endpoint: o.endpoint, p256dh: keys.p256dh, auth: keys.auth, quiet, tzOffset: o.tzOffset };
}

/** スマホの口（app.ts が `/m/push` に載せる）。どれもスマホのトークンが要る。 */
export const pushApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/** VAPID の公開鍵を返す。スマホは `PushManager.subscribe` の applicationServerKey にそのまま渡す。 */
pushApp.get('/key', authMiddleware(), requireKind('mobile'), async (c) => {
  const res: PushKeyOut = { publicKey: (await vapidOf(c.env.DB)).publicKey };
  return c.json(res);
});

/** 購読を置く。スマホ 1 台に 1 つで、2 回目からは上書きする。endpoint は既知の push サービスの https だけを受ける。 */
pushApp.put('/subscription', authMiddleware(), requireKind('mobile'), async (c) => {
  const read = await readLimitedJson(c, MAX_SUBSCRIPTION_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large', limit: MAX_SUBSCRIPTION_BODY_BYTES }, 413);
  const s = await parseSubscription(read.value);
  if (!s) return c.json({ error: 'invalid body' }, 400);
  await c.env.DB.prepare(
    'insert into push_subscriptions (device_id, endpoint, p256dh, auth, quiet_start, quiet_end, tz_offset, created_at) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(device_id) do update set endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, tz_offset = excluded.tz_offset, created_at = excluded.created_at',
  )
    .bind(c.get('device').id, s.endpoint, s.p256dh, s.auth, s.quiet?.start ?? null, s.quiet?.end ?? null, s.tzOffset, Date.now())
    .run();
  return c.json({ ok: true });
});

/** 自分の購読を消す（「通知を止める」）。行が無くても 200。 */
pushApp.delete('/subscription', authMiddleware(), requireKind('mobile'), async (c) => {
  await c.env.DB.prepare('delete from push_subscriptions where device_id = ?').bind(c.get('device').id).run();
  return c.json({ ok: true });
});

type SubRow = { device_id: string; endpoint: string; p256dh: string; auth: string; quiet_start: number | null; quiet_end: number | null; tz_offset: number | null };

/** PC の口（app.ts が `/notices` に載せ、PC の端末トークンを求める）。 */
export const noticesApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * PC が通知を送る。本文は `{ sealed, epoch }` で、sealed は sealPhoneNotice の戻り（頭の世代は epoch と同じ）である。
 * 解除されておらず期限の切れていないスマホの購読の全部に送り、夜の時間帯のスマホには送らない。
 * push サービスが 404 か 410 を返した購読は消す（購読が取り消されている）。それ以外の失敗は数えるだけで、送り直さない。
 * 読むのは購読の表とスマホの行（スマホの数の行）で、VAPID の鍵は isolate の記憶から使う。
 */
noticesApp.post('/', async (c) => {
  const read = await readLimitedJson(c, MAX_NOTICE_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large', limit: MAX_NOTICE_BODY_BYTES }, 413);
  const body = read.value as Partial<NoticeIn> | null;
  if (!body || typeof body.sealed !== 'string' || body.sealed.length > PHONE_NOTICE_SEALED_MAX || !isEpoch(body.epoch) || phoneNoticeEpoch(body.sealed) !== body.epoch) {
    return c.json({ error: 'invalid body' }, 400);
  }
  const now = Date.now();
  if (!takeNotice(c.get('device').id, now)) return c.json({ error: 'rate limited' }, 429);
  const db = c.env.DB;
  const subs = (
    await db
      .prepare(`select s.device_id, s.endpoint, s.p256dh, s.auth, s.quiet_start, s.quiet_end, s.tz_offset from push_subscriptions s join devices on devices.id = s.device_id where ${LIVE_PHONE_SQL}`)
      .bind(now, now)
      .all<SubRow>()
  ).results;
  const out: NoticeOut = { sent: 0, quiet: 0, removed: 0, failed: 0 };
  const targets = subs.filter((s) => {
    const q = inQuietHours(now, s.quiet_start, s.quiet_end, s.tz_offset);
    if (q) out.quiet++;
    return !q;
  });
  if (targets.length === 0) return c.json(out);
  const keys = await vapidOf(db);
  const payload = new TextEncoder().encode(body.sealed);
  // VAPID の sub は Worker の URL。push サービスが送り手に連絡するための名乗りで、持ち主のメールアドレスは渡さない。
  const subject = new URL(c.req.url).origin;
  const gone: SubRow[] = [];
  await Promise.all(
    targets.map(async (s) => {
      try {
        // リダイレクトは追わない。endpoint は許可したホストに限っているが、追うと VAPID の署名つきで許可の外へ送りうる。3xx は失敗に数える。
        const res = await fetch(await pushRequest(s, payload, keys, subject, now), { signal: AbortSignal.timeout(PUSH_TIMEOUT_MS), redirect: 'manual' });
        await res.body?.cancel();
        if (res.status === 404 || res.status === 410) gone.push(s);
        else if (res.ok) out.sent++;
        else {
          out.failed++;
          // endpoint は購読ごとの秘密に近いので、記録には状態の番号だけを残す。
          console.error('push failed', res.status);
        }
      } catch (e) {
        out.failed++;
        console.error('push failed', e instanceof Error ? e.name : typeof e);
      }
    }),
  );
  if (gone.length > 0) {
    // 同じスマホが送っている間に購読を置き直していたら、新しい購読は消さない（endpoint も条件に入れる）。
    await db.batch(gone.map((s) => db.prepare('delete from push_subscriptions where device_id = ? and endpoint = ?').bind(s.device_id, s.endpoint)));
    out.removed = gone.length;
  }
  return c.json(out);
});
