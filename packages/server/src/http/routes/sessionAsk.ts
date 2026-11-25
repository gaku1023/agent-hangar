import type { Hono } from 'hono';
import type { AppDeps } from '../deps.ts';
import { readJson } from './common.ts';
import { parseOpIn } from './peerChat.ts';

/**
 * この PC の画面が、この PC の会話（Claude Code、Codex、opencode）の札を読んで答える口。
 * - GET  /api/sessions/:id/ask           いま出ている札（PeerChatAsk）か null。
 * - POST /api/sessions/:id/ask/answer    { askId, keys, text? } で答える。
 * 札が出た、替わった、閉じたことは WebSocket の session.ask で流れ、最初の状態は bootstrap の peerAsks に載る。
 * 答えは host.local.answer（peer/chat/host.ts）を通り、ほかの PC や統括の答えと同じ照合と記録を使う。
 * 断りは 200 の本文（ok: false と peer chat と同じ reason）で返す。画面はそれを見て札を読み直す。
 * 形が合わない要求だけが 400、大きすぎる本文が 413 である。
 * /api の認証の下にあるので、MCP の秘密では呼べない。
 * 札の口を持たない組み立てでは、どちらも出さない。
 */
export type SessionAskRouteDeps = Pick<AppDeps, 'askLocal' | 'askChanged'>;

/** 本文の上限。peer chat の ops と同じ（答えの文は 32 KiB まで）。 */
const BODY_LIMIT = 96 * 1024;

export function sessionAskRoutes(api: Hono, deps: SessionAskRouteDeps): void {
  const local = deps.askLocal;
  if (!local) return;
  api.get('/sessions/:id/ask', (c) => c.json(local.currentAsk(c.req.param('id'))));
  api.post('/sessions/:id/ask/answer', async (c) => {
    const got = await readJson(c, BODY_LIMIT);
    if (got.tooLarge) return c.json({ error: 'too large' }, 413);
    const v = got.value;
    const op = typeof v === 'object' && v !== null && !Array.isArray(v) ? parseOpIn({ ...(v as Record<string, unknown>), t: 'answer' }) : null;
    if (!op || op.t !== 'answer') return c.json({ error: 'invalid answer' }, 400);
    const id = c.req.param('id');
    const r = await local.answer(id, op.askId, op.keys, op.text);
    // 札が閉じたかもしれない（答えた、先に答えられていた）。画面へ今の札を流し直す。
    deps.askChanged?.(id);
    return c.json(r);
  });
}
