import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerEvent } from '@agent-hangar/shared';
import { originAllowed, tokenFromRequest } from '../http/auth.ts';

/** UI へのイベント配信。接続時に ready を送り、以後は broadcast を全員に流す。 */
export class EventHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  constructor(private readonly version: string) {}

  /** upgrade 要求のうち path が一致するものだけを受け、Origin とトークンで検査する。 */
  attach(server: http.Server, opts: { path: string; token: string }): void {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== opts.path) return;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const token = tokenFromRequest(headers, req.headers.cookie) ?? url.searchParams.get('token');
      if (!originAllowed(req.headers.origin) || token !== opts.token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.clients.add(ws);
        ws.on('close', () => this.clients.delete(ws));
        ws.send(JSON.stringify({ type: 'ready', version: this.version } satisfies ServerEvent));
      });
    });
  }

  broadcast(ev: ServerEvent): void {
    const data = JSON.stringify(ev);
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(data);
  }

  clientCount(): number { return this.clients.size; }

  close(): void {
    for (const c of this.clients) c.close();
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }
}
