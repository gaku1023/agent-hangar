import type { Hono } from 'hono';
import { isPeerChatViewerId, PEER_CHAT_ID_MAX_CHARS, PEER_CHAT_KEYS_MAX, PEER_CHAT_KEY_MAX_CHARS, PEER_CHAT_QUERY_MAX_CHARS, type PeerChatOpIn } from '@agent-hangar/shared';
import type { AppDeps } from '../deps.ts';
import { readJson } from './common.ts';

/**
 * ほかの PC の Claude Code の会話を、チャットの形で見て続ける入口（見る側の PC。中身は peer/chat/viewer.ts）。
 * - GET  /api/sessions/:id/peer-chat?viewer=&after=   見張りを始めて（動いていれば加わって）、いまの状態を返す。
 * 更新は WebSocket の peerChat.update で流れる。
 * viewer は画面が振る見ている人の ID。
 * after を省くと手元の写しの最後の uuid から、空にすると頭から取る。
 * - POST /api/sessions/:id/peer-chat/ops               tail 以外の op を元の PC へ運ぶ。
 * どちらも、断りは 200 の本文（ok: false と reason）で返す。
 * 画面はそれを見て、読み取り専用のトランスクリプトに落とすか、文を入力欄に戻す。
 * 形が合わない要求だけが 400、大きすぎる本文が 413 である。
 * /api の認証の下にあるので、MCP の秘密では呼べない。
 * 見る側の部品を持たない組み立て（同期を持たない試験など）では、どちらも出さない。
 */
export type PeerChatRouteDeps = Pick<AppDeps, 'peerChat'>;

/**
 * ops の本文の上限。
 * 文は 32 KiB までで、画像の控えと枠に余裕を見る。
 */
const OPS_BODY_LIMIT = 96 * 1024;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const idLike = (v: unknown): v is string => isStr(v) && v.length > 0 && v.length <= PEER_CHAT_ID_MAX_CHARS;

/**
 * 本文を op に読む。
 * 形が違う、tail、知らない op は null。
 */
export function parseOpIn(v: unknown): PeerChatOpIn | null {
  if (!isObj(v) || !isStr(v.t)) return null;
  switch (v.t) {
    case 'send':
    case 'resume-send': {
      if (!isStr(v.text)) return null;
      if (v.images === undefined) return { t: v.t, text: v.text };
      if (!Array.isArray(v.images) || !v.images.every((i) => isStr(i) && i.length > 0 && i.length <= 1024)) return null;
      return { t: v.t, text: v.text, images: [...(v.images as string[])] };
    }
    case 'answer': {
      if (!idLike(v.askId) || !Array.isArray(v.keys) || v.keys.length > PEER_CHAT_KEYS_MAX || !(v.text === undefined || isStr(v.text))) return null;
      if (!v.keys.every((k) => isStr(k) && k.length > 0 && k.length <= PEER_CHAT_KEY_MAX_CHARS)) return null;
      return { t: 'answer', askId: v.askId, keys: [...(v.keys as string[])], ...(v.text !== undefined ? { text: v.text as string } : {}) };
    }
    case 'interrupt':
      return { t: 'interrupt' };
    case 'cancel':
      return idLike(v.queueId) ? { t: 'cancel', queueId: v.queueId } : null;
    case 'files':
      return isStr(v.query) && v.query.length <= PEER_CHAT_QUERY_MAX_CHARS ? { t: 'files', query: v.query } : null;
    default:
      return null;
  }
}

export function peerChatRoutes(api: Hono, deps: PeerChatRouteDeps): void {
  const chat = deps.peerChat;
  if (!chat) return;
  api.get('/sessions/:id/peer-chat', async (c) => {
    const viewer = c.req.query('viewer');
    if (!isPeerChatViewerId(viewer)) return c.json({ error: 'viewer is required' }, 400);
    const afterRaw = c.req.query('after');
    if (afterRaw !== undefined && afterRaw.length > PEER_CHAT_ID_MAX_CHARS) return c.json({ error: 'after is too long' }, 400);
    const after = afterRaw === undefined ? undefined : afterRaw === '' ? null : afterRaw;
    return c.json(await chat.open(c.req.param('id'), { viewer, after }));
  });
  api.post('/sessions/:id/peer-chat/ops', async (c) => {
    const got = await readJson(c, OPS_BODY_LIMIT);
    if (got.tooLarge) return c.json({ error: 'too large' }, 413);
    const op = parseOpIn(got.value);
    if (!op) return c.json({ error: 'invalid op' }, 400);
    return c.json(await chat.op(c.req.param('id'), op));
  });
}
