import { Hono } from 'hono';
import { PEER_CHAT_SEALED_MAX, PEER_CHAT_WAIT_MAX_MS, peerSealEpoch, type PeerAskIn } from '@agent-hangar/shared';
import { BELL_DEVICE_HEADER, PEER_ASK_RATE } from './bellWire.ts';
import type { Env, Vars } from './env.ts';
import { bellOf, readLimitedJson } from './mobile.ts';
import { peerBlobsApp } from './mobileBlobs.ts';

/**
 * PC から PC への会話の問い合わせの口（互換の版 11）。app.ts が `/peer` に載せる。
 *
 * 認証と種類の検査（PC だけ）は app.ts の一覧が付ける。スマホのトークンはここへ届かない（403）。
 * 見る側の PC が `POST /peer/ask` で頼み、Durable Object（bell.ts）が宛先の PC の呼び鈴の WebSocket に枠を渡し、答えを待って返す。
 * 頼みも答えも PC どうしの鍵で封じたままで、Worker も Durable Object も開かない。D1 にも R2 にも書かない（画像だけは peerBlobsApp が R2 に置く）。
 * 待ちと回数の数えは Durable Object のメモリに置く（bell.ts）。
 *
 * 送り手は端末トークンで決める。本文に送り手は無く、Durable Object へ渡す見出しの端末の ID が送り手になる。
 * 宛先が解除された PC かどうかは見ない（D1 を読まないため）。つないでいない宛先は offline である。
 * 解除した PC の開いたままの WebSocket は、つなぎ直すまで残りうる。中身は PC どうしの鍵で封じてあるので、影響は小さい。
 */

/** POST /peer/ask の本文の上限。封は PEER_CHAT_SEALED_MAX 字までで、JSON の枠に余裕を見て 96 KiB にする。 */
export const MAX_PEER_ASK_BODY_BYTES = 96 * 1024;
/** 1 台の PC からの問い合わせの回数の上限（bellWire.ts）。Durable Object のメモリで数える（眠れば消える緩い上限）。 */
export { PEER_ASK_RATE };
/** 頼みの ID の形。長さは 64 字まで。 */
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const peerAskApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * 宛先の PC に会話の頼みを渡し、答えを待つ。
 * 本文は `{ askId, to, sealed, epoch, waitMs }`。
 * askId は頼む側が振る頼みの ID で、封の AAD の ask_id と同じ値にする（宛先の PC が開くのに要る）。
 * epoch は封の頭の世代と同じ値でなければならない。waitMs は 0 から PEER_CHAT_WAIT_MAX_MS までの整数である。
 * 本文が 96 KiB を超えたら 413、形が違えば 400（自分宛て、封が PEER_CHAT_SEALED_MAX を超える場合を含む）で断る。
 * Durable Object が、答え（`{ sealed }`）、409（reason は offline か duplicate）、429（reason は rate）、502（答えが大きすぎる）、504（待ちの上限）をそのまま返す。
 * 待ちは waitMs に 5 秒を足した長さまでである。
 */
peerAskApp.post('/ask', async (c) => {
  const read = await readLimitedJson(c, MAX_PEER_ASK_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large', limit: MAX_PEER_ASK_BODY_BYTES }, 413);
  const body = read.value as Partial<PeerAskIn> | null;
  const from = c.get('device').id;
  if (
    !body ||
    typeof body.askId !== 'string' ||
    !ID_RE.test(body.askId) ||
    typeof body.to !== 'string' ||
    body.to.length === 0 ||
    body.to.length > 128 ||
    body.to === from ||
    typeof body.sealed !== 'string' ||
    body.sealed.length === 0 ||
    body.sealed.length > PEER_CHAT_SEALED_MAX ||
    typeof body.epoch !== 'number' ||
    peerSealEpoch(body.sealed) !== body.epoch ||
    typeof body.waitMs !== 'number' ||
    !Number.isInteger(body.waitMs) ||
    body.waitMs < 0 ||
    body.waitMs > PEER_CHAT_WAIT_MAX_MS
  ) {
    return c.json({ error: 'invalid body' }, 400);
  }
  const bell = bellOf(c.env);
  if (!bell) return c.json({ error: 'bell unavailable' }, 503);
  const forward: PeerAskIn = { askId: body.askId, to: body.to, sealed: body.sealed, epoch: body.epoch, waitMs: body.waitMs };
  return bell.fetch('https://bell/peer-ask', { method: 'POST', headers: { 'content-type': 'application/json', [BELL_DEVICE_HEADER]: from }, body: JSON.stringify(forward) });
});

/** 会話に添える画像（mobileBlobs.ts）。 */
peerAskApp.route('/blobs', peerBlobsApp);
