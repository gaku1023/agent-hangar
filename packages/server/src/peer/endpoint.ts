import { Hono, type Context } from 'hono';
import {
  PEER_LAUNCH_SEALED_MAX,
  peerSealEpoch,
  type PeerLaunchPut,
  type PeerLaunchStatus,
  type PeerOutboxResponse,
  type PeerResultsResponse,
} from '@agent-hangar/shared';
import { isPeerDeviceId } from './ssh/config.ts';
import { verifyPeerToken, type PeerTokenKeys } from './ssh/token.ts';

/**
 * 相手の hangar の `/peer`（SSH の予備の経路の入口）。
 *
 * SSH のトンネルの先で、別の PC から来る頼み・受け取り・結果だけを受ける。
 * 形はクラウドの Worker の `/launches` と同じで（shared の peerCloud.ts）、封は開かずにそのまま手元の受け口へ渡す。
 * 通すのは PC どうしの token（peer/ssh/token.ts）だけで、利用者の token とクッキーは受けない。
 * ブラウザから来た要求（Origin、Sec-Fetch-Site、クッキーのどれかが付く）も断る。
 * /api と /mcp はここを通らず、ここも /api と /mcp の token を受けない。
 *
 * 経路は次の 4 つ。送り手は見出しの x-hangar-peer-from で名乗り、token はその送り手からこの PC への分でなければ通らない。
 * - GET  /peer/health                 トンネルの確かめ。自分の device_id を返す。
 * - POST /peer/launches               頼みを置く（PeerLaunchPut）。
 * - GET  /peer/launches/mine?since=   送り手が置いた頼みの状態（PeerOutboxResponse）。
 * - GET  /peer/launches/:id/results?after=  結果の行（PeerResultsResponse）。
 */

/** 送り手を名乗る見出し。 */
export const PEER_FROM_HEADER = 'x-hangar-peer-from';

/**
 * `/peer` が渡す先の手元の受け口。
 * 受ける側（T4）が頼みを受けて検査と起動に回し、結果を書く側（T6）が書いた結果の行を返す。
 * 状態の持ち方は Worker と同じ意味にする（頼みの期限、同じ ID の再送は冪等、ほかの PC の ID と重なれば conflict）。
 * from はトークンで確かめた送り手の device_id である。
 */
export interface PeerInbox {
  /** 頼みを置く。同じ ID の再送は今の状態を返す。ほかの送り手の ID と重なれば conflict。 */
  put(from: string, body: PeerLaunchPut & { from: string }): Promise<PeerLaunchStatus | 'conflict'>;
  /** 送り手が置いた頼みのうち、since 以降に動いたもの。 */
  outbox(from: string, since: number): Promise<PeerOutboxResponse>;
  /** 送り手が置いた頼みの結果の行。after より大きい seq を昇順で。送り手の頼みでなければ null。 */
  results(from: string, id: string, after: number): Promise<PeerResultsResponse | null>;
}

export type PeerEndpointDeps = {
  /** この PC の device_id。token の宛先になる。 */
  selfId: string;
  /** token の鍵。同期を設定していなければ null で、全部を断る。 */
  tokens: () => PeerTokenKeys | null;
  /** 手元の受け口。まだ組んでいなければ null で、503 を返す。 */
  inbox: () => PeerInbox | null;
};

/** 本文の上限。Worker の POST /launches と同じ。 */
export const MAX_PEER_ENDPOINT_BODY_BYTES = 64 * 1024;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

type Vars = { Variables: { from: string } };

const nonNegInt = (v: string | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

/** `/peer` の経路を組む。app.ts が `/peer` に載せる。 */
export function peerRoutes(deps: PeerEndpointDeps): Hono<Vars> {
  const app = new Hono<Vars>();

  app.use('*', async (c, next) => {
    // ブラウザからの要求はここへ来ない筈で、来たら断る（利用者のクッキーで通る道を作らない）。
    if (c.req.header('origin') !== undefined || c.req.header('sec-fetch-site') !== undefined || c.req.header('cookie') !== undefined) return c.json({ error: 'forbidden' }, 403);
    const from = c.req.header(PEER_FROM_HEADER);
    const auth = c.req.header('authorization') ?? '';
    const token = /^Bearer (\S+)$/.exec(auth)?.[1];
    const keys = deps.tokens();
    // 鍵の束が読めない（cloud.json が壊れているなど）ときも、通さずに 401 にする。
    const ok = keys !== null && isPeerDeviceId(from) && from !== deps.selfId && (await verifyPeerToken(keys, token, from, deps.selfId).catch(() => false));
    if (!ok) return c.json({ error: 'unauthorized' }, 401);
    c.set('from', from);
    await next();
  });

  app.get('/health', (c) => c.json({ ok: true, device: deps.selfId }));

  const inboxOr503 = (c: Context<Vars>): PeerInbox | Response => deps.inbox() ?? c.json({ error: 'not-ready' }, 503);

  app.post('/launches', async (c) => {
    const inbox = inboxOr503(c);
    if (inbox instanceof Response) return inbox;
    if ((c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') return c.json({ error: 'bad content type' }, 415);
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_PEER_ENDPOINT_BODY_BYTES) return c.json({ error: 'too large' }, 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { return c.json({ error: 'bad json' }, 400); }
    if (typeof body !== 'object' || body === null) return c.json({ error: 'bad body' }, 400);
    const from = c.get('from');
    const { id, to, sealed } = body;
    if (typeof id !== 'string' || !ID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);
    if (to !== deps.selfId) return c.json({ error: 'wrong device' }, 404);
    if (body.from !== undefined && body.from !== from) return c.json({ error: 'from mismatch' }, 403);
    if (typeof sealed !== 'string' || sealed.length === 0 || sealed.length > PEER_LAUNCH_SEALED_MAX || peerSealEpoch(sealed) === null) return c.json({ error: 'invalid sealed' }, 400);
    const r = await inbox.put(from, { id, to, sealed, from });
    if (r === 'conflict') return c.json({ error: 'conflict' }, 409);
    return c.json(r);
  });

  app.get('/launches/mine', async (c) => {
    const inbox = inboxOr503(c);
    if (inbox instanceof Response) return inbox;
    return c.json(await inbox.outbox(c.get('from'), nonNegInt(c.req.query('since'))));
  });

  app.get('/launches/:id/results', async (c) => {
    const inbox = inboxOr503(c);
    if (inbox instanceof Response) return inbox;
    const id = c.req.param('id');
    if (!ID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);
    const r = await inbox.results(c.get('from'), id, nonNegInt(c.req.query('after')));
    if (!r) return c.json({ error: 'not found' }, 404);
    return c.json(r);
  });

  return app;
}
