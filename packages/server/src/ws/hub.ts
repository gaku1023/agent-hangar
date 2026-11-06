import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerEvent } from '@agent-hangar/shared';
import { originAllowed, tokenFromRequest } from '../auth/request.ts';

/** close フレームに応えない相手を待つ上限。これを過ぎたら接続を切る。 */
const CLOSE_GRACE_MS = 500;
/** 画面から受ける本文の大きさの上限（バイト）。 */
const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;

/** UI へのイベント配信。接続時に ready を送り、以後は broadcast を全員に流す。 */
export class EventHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private nextId = 1;
  private readonly messageHandlers: ((client: number, raw: string) => void)[] = [];
  private readonly closeHandlers: ((client: number) => void)[] = [];
  constructor(private readonly version: string) {}

  /**
   * 画面から来た本文を受ける（ほかの PC の会話の見張りの peerChat.watch と peerChat.unwatch など）。
   * client は接続ごとの番号で、onClose に同じ番号が渡る。
   * handler が投げても、接続とサーバは続ける。
   */
  onMessage(handler: (client: number, raw: string) => void): void { this.messageHandlers.push(handler); }

  /**
   * 接続が閉じた（閉じる手続きを経ない切断も含む）。
   * onMessage に渡した番号と同じ。
   */
  onClose(handler: (client: number) => void): void { this.closeHandlers.push(handler); }

  /** upgrade 要求のうち path が一致するものだけを受け、Origin とトークンで検査する。 */
  attach(server: http.Server, opts: { path: string; token: string; port: number }): void {
    // 画面から来る本文は、見張りの開始と終了の知らせだけである。
    // 大きいものは受けずに接続を切る（1009）。
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      // 一致しない経路は黙って返し、同じ server に載る別の WebSocket サーバに譲る。
      // どこも引き取らなかった要求を切るのは番人（ws/guard.ts）の役目である。
      if (url.pathname !== opts.path) return;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      // トークンはヘッダかクッキーだけで受ける。クエリに置くと Referer や代理のログに秘密が残る。
      const token = tokenFromRequest(headers, req.headers.cookie);
      if (!originAllowed(req.headers.origin, opts.port) || token !== opts.token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        const id = this.nextId++;
        this.clients.add(ws);
        ws.on('message', (data, isBinary) => {
          if (isBinary) return;
          const raw = String(data);
          for (const h of this.messageHandlers) {
            try { h(id, raw); } catch (e) { console.error('[ws] a message handler failed', e instanceof Error ? e.constructor.name : typeof e); }
          }
        });
        ws.on('error', () => { /* close が続く */ });
        ws.on('close', () => {
          this.clients.delete(ws);
          for (const h of this.closeHandlers) {
            try { h(id); } catch (e) { console.error('[ws] a close handler failed', e instanceof Error ? e.constructor.name : typeof e); }
          }
        });
        ws.send(JSON.stringify({ type: 'ready', version: this.version } satisfies ServerEvent));
      });
    });
  }

  broadcast(ev: ServerEvent): void {
    const data = JSON.stringify(ev);
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(data);
  }

  clientCount(): number { return this.clients.size; }

  /**
   * 全員に close フレームを送り、閉じ終わるのを待つ。
   * 応えない相手は CLOSE_GRACE_MS で terminate するので、止まったタブが終了を妨げない。
   */
  close(): Promise<void> {
    const clients = [...this.clients];
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
    return new Promise<void>((resolve) => {
      let pending = clients.length;
      if (pending === 0) { resolve(); return; }
      const done = () => { if (--pending === 0) { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => { for (const c of clients) if (c.readyState !== c.CLOSED) c.terminate(); }, CLOSE_GRACE_MS);
      for (const c of clients) {
        if (c.readyState === c.CLOSED) { done(); continue; }
        c.once('close', done);
        c.close(1001, 'server shutting down');
      }
    });
  }
}
