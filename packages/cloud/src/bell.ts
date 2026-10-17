import { DurableObject } from 'cloudflare:workers';
import { MOBILE_REPLY_MAX_BYTES } from '@agent-hangar/shared';
import { ASK_RATE, askTimeoutMs, BELL_DEVICE_HEADER, REPLACED_CLOSE_CODE } from './bellWire.ts';
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
 * POST /ring は宛先の PC（見出しの ID）を鳴らす。
 *
 * 問い合わせも答えもスマホの鍵で封をしたまま運び、ここでは読まない。D1 にも書かない。
 * 待ちと回数の数えはメモリに置く。問い合わせの間は fetch が開いているので、Durable Object は眠らない。
 * 眠れば回数の数えは消える（緩い上限）。
 */

type Attachment = { deviceId: string };
type Pending = { target: string; ws: WebSocket; resolve: (r: Response) => void; timer: ReturnType<typeof setTimeout> };

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class HangarBell extends DurableObject<Env> {
  private readonly pending = new Map<string, Pending>();
  private readonly asks = new Map<string, number[]>();

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
    if (path === '/ring' && req.method === 'POST') return this.ring(device);
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

  /** スマホ 1 台の回数を数える。上限を超えたら false。 */
  private countAsk(phoneId: string, now: number): boolean {
    const recent = (this.asks.get(phoneId) ?? []).filter((t) => t > now - ASK_RATE.windowMs);
    if (recent.length >= ASK_RATE.max) {
      this.asks.set(phoneId, recent);
      return false;
    }
    recent.push(now);
    this.asks.set(phoneId, recent);
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

  private settle(id: string, res: Response): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(res);
  }

  /** 宛先の PC を鳴らす。つないでいなければ何もしない（PC は 30 秒の pull で拾う）。 */
  private ring(target: string): Response {
    const ws = this.socketOf(target);
    if (ws) {
      try {
        ws.send(JSON.stringify({ t: 'launch' }));
      } catch {
        // 送れなくても依頼は D1 にあり、PC は pull で拾う。
      }
    }
    return new Response(null, { status: 204 });
  }

  /**
   * PC からの文面。受けるのは reply だけである。
   * 待っている問い合わせの宛先と、送ってきた WebSocket の端末の ID が一致するときだけ答えにする。
   */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let m: { t?: unknown; id?: unknown; sealed?: unknown };
    try {
      m = JSON.parse(message) as typeof m;
    } catch {
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
  }
}
