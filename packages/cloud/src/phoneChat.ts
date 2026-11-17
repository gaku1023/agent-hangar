import { Hono } from 'hono';
import { PEER_CHAT_SEALED_MAX, PEER_CHAT_WAIT_MAX_MS, type PhoneChatIn } from '@agent-hangar/shared';
import { authMiddleware, requireKind } from './auth.ts';
import { BELL_DEVICE_HEADER, PHONE_CHAT_RATE } from './bellWire.ts';
import type { Env, Vars } from './env.ts';
import { bellOf, readLimitedJson } from './mobile.ts';

/**
 * スマホから PC の会話への問い合わせの口（互換の版 13）。app.ts が `/m/chat` に載せる。
 *
 * PC どうしの /peer/ask（peerAsk.ts）の写しで、スマホのトークンだけを通す。
 * スマホが `POST /m/chat` で頼み、Durable Object（bell.ts）が宛先の PC の呼び鈴の WebSocket に枠を渡し、答えを待って返す。
 * 頼みも答えもスマホ用の鍵で封じたままで、Worker も Durable Object も開かない。D1 には書かない。
 * 宛先が解除していない PC であることだけを D1 で 1 行読んで確かめる（/m/ask と同じ）。
 * 送り手は端末トークンで決め、Durable Object へ渡す見出しのスマホの ID が送り手になる。
 */

/** POST /m/chat の本文の上限。/peer/ask と同じ 96 KiB にする。 */
export const MAX_PHONE_CHAT_BODY_BYTES = 96 * 1024;
export { PHONE_CHAT_RATE };
/** 頼みの ID の形。長さは 64 字まで。 */
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** 封の形（base64url）。 */
const SEALED_RE = /^[A-Za-z0-9_-]+$/;

export const phoneChatApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * 宛先の PC の会話に頼みを渡し、答えを待つ。
 * 本文は `{ askId, to, sealed, epoch, waitMs }`。askId は封の AAD（aadPhoneChat）と同じ値にする。
 * epoch は封じたスマホ用の鍵の世代で、PC はこれで開き、同じ世代で答えを封じる。waitMs は 0 から PEER_CHAT_WAIT_MAX_MS までの整数である。
 * 本文が 96 KiB を超えたら 413、形が違えば 400、宛先が解除していない PC でなければ 404 で断る。
 * Durable Object が、答え（`{ sealed }`）、409（reason は offline か duplicate）、429（reason は rate）、502（答えが大きすぎる）、504（待ちの上限）をそのまま返す。
 */
phoneChatApp.post('/', authMiddleware(), requireKind('mobile'), async (c) => {
  const read = await readLimitedJson(c, MAX_PHONE_CHAT_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large', limit: MAX_PHONE_CHAT_BODY_BYTES }, 413);
  const body = read.value as Partial<PhoneChatIn> | null;
  if (
    !body ||
    typeof body.askId !== 'string' ||
    !ID_RE.test(body.askId) ||
    typeof body.to !== 'string' ||
    body.to.length === 0 ||
    body.to.length > 128 ||
    typeof body.sealed !== 'string' ||
    body.sealed.length > PEER_CHAT_SEALED_MAX ||
    !SEALED_RE.test(body.sealed) ||
    typeof body.epoch !== 'number' ||
    !Number.isInteger(body.epoch) ||
    body.epoch < 1 ||
    typeof body.waitMs !== 'number' ||
    !Number.isInteger(body.waitMs) ||
    body.waitMs < 0 ||
    body.waitMs > PEER_CHAT_WAIT_MAX_MS
  ) {
    return c.json({ error: 'invalid body' }, 400);
  }
  const target = await c.env.DB.prepare("select id from devices where id = ? and kind = 'pc' and revoked_at is null").bind(body.to).first();
  if (!target) return c.json({ error: 'not found' }, 404);
  const bell = bellOf(c.env);
  if (!bell) return c.json({ error: 'pc-offline', reason: 'offline' }, 409);
  const forward: PhoneChatIn = { askId: body.askId, to: body.to, sealed: body.sealed, epoch: body.epoch, waitMs: body.waitMs };
  return bell.fetch('https://bell/phone-chat', { method: 'POST', headers: { 'content-type': 'application/json', [BELL_DEVICE_HEADER]: c.get('device').id }, body: JSON.stringify(forward) });
});
