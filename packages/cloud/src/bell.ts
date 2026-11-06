import { DurableObject } from 'cloudflare:workers';
import { MOBILE_REPLY_MAX_BYTES, PEER_BELL_KINDS, PEER_CHAT_REPLY_SEALED_MAX, type PeerAskIn, type PeerBellKind, type PeerChatBellAsk } from '@agent-hangar/shared';
import { ASK_RATE, askTimeoutMs, BELL_DEVICE_HEADER, BELL_RING_ID_HEADER, BELL_RING_KIND_HEADER, PEER_ASK_RATE, peerAskGraceMs, REPLACED_CLOSE_CODE } from './bellWire.ts';
import type { Env } from './env.ts';

/**
 * 呼び鈴（互換の版 8）。
 * PC が WebSocket でつなぎっぱなしにし、Worker はスマホの起動の依頼で PC を鳴らし、スマホの問い合わせを PC に渡して答えを待つ。
 *
 * 実体は名前の決まった 1 つ（bellWire.ts の BELL_NAME）だけを使う。
 * PC は数台なので、宛先探しは WebSocket の札（端末の ID）で足りる。
 *
 * 外から Durable Object へ直に届く道は無く、要求はすべて Worker（mobile.ts）から来る。
 * Worker は認証と種類の検査を済ませてから、端末の ID を bellWire.ts の BELL_DEVICE_HEADER に載せて渡す。
 * ここではその見出しを信じ、トークンは見ない。
 *
 * 内向きの道は 3 つである。
 * GET /connect は PC の WebSocket を受ける（見出しは PC の ID）。
 * POST /ask はスマホの問い合わせを宛先の PC に渡して答えを待つ（見出しはスマホの ID）。
 * POST /ring は宛先の PC（見出しの ID）を鳴らす。PC どうしの頼みのときは、種類と頼みの ID を見出しで受けて { t: 'peer', kind, id } を送る。
 * POST /peer-ask は PC の会話の問い合わせ（互換の版 11）を宛先の PC に渡して答えを待つ（見出しは頼む PC の ID）。
 *
 * 問い合わせも答えもスマホの鍵（会話の問い合わせは PC どうしの鍵）で封をしたまま運び、ここでは読まない。D1 にも書かない。
 * 待ちと回数の数えはメモリに置く。問い合わせの間は fetch が開いているので、Durable Object は眠らない。
 * 眠れば回数の数えは消える（緩い上限）。
 *
 * 会話の問い合わせの枠（shared の peerChat.ts）。
 * この Durable Object から宛先の PC へは PeerChatBellAsk（t: 'chat'）を送る。
 * 宛先の PC は PeerChatBellReply（t: 'chat-reply'、id と from は届いた枠のまま）で返す。
 * スマホの問い合わせ（t: 'ask' と t: 'reply'）とは待ちの表を分け、ID が重なっても混ざらない。
 */

type Attachment = { deviceId: string };
type Pending = { target: string; ws: WebSocket; resolve: (r: Response) => void; timer: ReturnType<typeof setTimeout> };
type Rate = { readonly max: number; readonly windowMs: number };

/** 会話の問い合わせの待ちの鍵。頼む PC と頼みの ID の組で、同じ ID を別の PC が使っても重ならない。 */
const chatKey = (from: string, askId: string): string => JSON.stringify([from, askId]);

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class HangarBell extends DurableObject<Env> {
  private readonly pending = new Map<string, Pending>();
  private readonly asks = new Map<string, number[]>();
  /** 会話の問い合わせの待ち（鍵は chatKey）と、PC ごとの回数。 */
  private readonly chatPending = new Map<string, Pending>();
  private readonly chatAsks = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // PC の生存の確かめ。Durable Object を起こさずに返り、リクエストにも数えない。
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const device = req.headers.get(BELL_DEVICE_HEADER) ?? '';
    if (!device) return json({ error: 'bad request' }, 400);
    if (path === '/connect') return this.acceptPc(req, device);
    if (path === '/ask' && req.method === 'POST') return this.ask(req, device);
    if (path === '/peer-ask' && req.method === 'POST') return this.peerAsk(req, device);
    if (path === '/ring' && req.method === 'POST') return this.ring(device, req.headers.get(BELL_RING_KIND_HEADER), req.headers.get(BELL_RING_ID_HEADER));
    return json({ error: 'not found' }, 404);
  }

  /** 宛先の端末の、開いている WebSocket のうち一番新しいもの。 */
  private socketOf(deviceId: string): WebSocket | null {
    const open = this.ctx.getWebSockets(deviceId).filter((ws) => ws.readyState === WebSocket.OPEN);
    return open[open.length - 1] ?? null;
  }

  /** PC の WebSocket を受ける。同じ PC の古いものは閉じて、新しいほうだけを残す。 */
  private acceptPc(req: Request, deviceId: string): Response {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket required' }, 426);
    for (const old of this.ctx.getWebSockets(deviceId)) {
      try {
        old.close(REPLACED_CLOSE_CODE, 'replaced');
      } catch {
        // 既に閉じている。
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [deviceId]);
    server.serializeAttachment({ deviceId } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 端末 1 台の回数を数える。上限を超えたら false。 */
  private countAsk(deviceId: string, now: number, asks: Map<string, number[]> = this.asks, rate: Rate = ASK_RATE): boolean {
    const recent = (asks.get(deviceId) ?? []).filter((t) => t > now - rate.windowMs);
    if (recent.length >= rate.max) {
      asks.set(deviceId, recent);
      return false;
    }
    recent.push(now);
    asks.set(deviceId, recent);
    return true;
  }

  /** スマホの問い合わせを宛先の PC に渡し、答えを待つ。本文の形と宛先は Worker が確かめてある。 */
  private async ask(req: Request, phoneId: string): Promise<Response> {
    const body = (await req.json()) as { id: string; targetDevice: string; sealed: string; epoch: number };
    if (!this.countAsk(phoneId, Date.now())) return json({ error: 'rate limited' }, 429);
    const ws = this.socketOf(body.targetDevice);
    if (!ws) return json({ error: 'pc-offline' }, 503);
    if (this.pending.has(body.id)) return json({ error: 'conflict' }, 409);
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => this.settle(body.id, json({ error: 'pc-timeout' }, 504)), askTimeoutMs(this.env));
      this.pending.set(body.id, { target: body.targetDevice, ws, resolve, timer });
      try {
        // epoch は問い合わせを封じたスマホ用の鍵の世代（互換の版 9）。PC はこれで開き、同じ世代で答えを封じる。
        ws.send(JSON.stringify({ t: 'ask', id: body.id, sealed: body.sealed, epoch: body.epoch }));
      } catch {
        this.settle(body.id, json({ error: 'pc-offline' }, 503));
      }
    });
  }

  /**
   * PC の会話の問い合わせを宛先の PC に渡し、答えを待つ（互換の版 11）。本文の形は Worker（peerAsk.ts）が確かめてある。
   * 宛先がつないでいなければ待たずに 409 offline、同じ頼み手の同じ askId が待っていれば 409 duplicate、回数の超過は 429 rate である。
   * 待ちは waitMs に 5 秒を足した長さまでで、過ぎたら 504 である。待つ間に宛先が切れたら、その場で 409 offline で返す。
   */
  private async peerAsk(req: Request, from: string): Promise<Response> {
    const body = (await req.json()) as PeerAskIn;
    if (!this.countAsk(from, Date.now(), this.chatAsks, PEER_ASK_RATE)) return json({ error: 'rate limited', reason: 'rate' }, 429);
    const ws = this.socketOf(body.to);
    if (!ws) return json({ error: 'pc-offline', reason: 'offline' }, 409);
    const key = chatKey(from, body.askId);
    if (this.chatPending.has(key)) return json({ error: 'conflict', reason: 'duplicate' }, 409);
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => this.settle(key, json({ error: 'pc-timeout' }, 504), this.chatPending), body.waitMs + peerAskGraceMs(this.env));
      this.chatPending.set(key, { target: body.to, ws, resolve, timer });
      try {
        const frame: PeerChatBellAsk = { t: 'chat', id: body.askId, from, epoch: body.epoch, sealed: body.sealed };
        ws.send(JSON.stringify(frame));
      } catch {
        this.settle(key, json({ error: 'pc-offline', reason: 'offline' }, 409), this.chatPending);
      }
    });
  }

  private settle(id: string, res: Response, pending: Map<string, Pending> = this.pending): void {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(res);
  }

  /** 宛先の PC を鳴らす。つないでいなければ何もしない（PC は 30 秒の pull で拾う）。 */
  private ring(target: string, kind: string | null, id: string | null): Response {
    const ws = this.socketOf(target);
    if (ws) {
      try {
        // PC どうしの頼みの知らせ（頼みが来た、答えが来た、結果が来た）は種類と頼みの ID を添える。スマホの依頼は従来どおり。
        const peer = kind !== null && id !== null && (PEER_BELL_KINDS as readonly string[]).includes(kind);
        ws.send(JSON.stringify(peer ? { t: 'peer', kind: kind as PeerBellKind, id } : { t: 'launch' }));
      } catch {
        // 送れなくても依頼は D1 にあり、PC は pull で拾う。
      }
    }
    return new Response(null, { status: 204 });
  }

  /**
   * PC からの文面。受けるのは reply（スマホの問い合わせの答え）と chat-reply（会話の問い合わせの答え）だけである。
   * 待っている問い合わせの宛先と、送ってきた WebSocket の端末の ID が一致するときだけ答えにする。
   */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let m: { t?: unknown; id?: unknown; from?: unknown; sealed?: unknown };
    try {
      m = JSON.parse(message) as typeof m;
    } catch {
      return;
    }
    if (m && m.t === 'chat-reply' && typeof m.id === 'string' && typeof m.from === 'string' && typeof m.sealed === 'string') {
      const key = chatKey(m.from, m.id);
      const p = this.chatPending.get(key);
      const sender = (ws.deserializeAttachment() as Attachment | null)?.deviceId;
      if (!p || !sender || sender !== p.target) return;
      if (m.sealed.length > PEER_CHAT_REPLY_SEALED_MAX) {
        this.settle(key, json({ error: 'reply too large' }, 502), this.chatPending);
        return;
      }
      this.settle(key, json({ sealed: m.sealed }, 200), this.chatPending);
      return;
    }
    if (!m || m.t !== 'reply' || typeof m.id !== 'string' || typeof m.sealed !== 'string') return;
    const p = this.pending.get(m.id);
    const from = (ws.deserializeAttachment() as Attachment | null)?.deviceId;
    if (!p || !from || from !== p.target) return;
    if (m.sealed.length > MOBILE_REPLY_MAX_BYTES) {
      this.settle(m.id, json({ error: 'reply too large' }, 502));
      return;
    }
    this.settle(m.id, json({ sealed: m.sealed }, 200));
  }

  /** PC が切れた。その WebSocket に渡して答えを待っている問い合わせは、待たずに 503 で返す。 */
  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.release(ws);
    try {
      ws.close(code, reason);
    } catch {
      // 既に閉じている。
    }
  }

  /** PC の WebSocket が壊れた。閉じたときと同じく、待っている問い合わせを 503 で返す（5 秒の待ちを抱えない）。 */
  override async webSocketError(ws: WebSocket): Promise<void> {
    this.release(ws);
  }

  /** その WebSocket に渡して答えを待っている問い合わせを、待たずに 503 で返す。 */
  private release(ws: WebSocket): void {
    for (const [id, p] of this.pending) {
      if (p.ws === ws) this.settle(id, json({ error: 'pc-offline' }, 503));
    }
    // 会話の問い合わせは、待たずに 409 offline で返す。頼んだ側は長い待ちを抱えず、すぐ「つながっていない」を出せる。
    for (const [key, p] of this.chatPending) {
      if (p.ws === ws) this.settle(key, json({ error: 'pc-offline', reason: 'offline' }, 409), this.chatPending);
    }
  }
}
