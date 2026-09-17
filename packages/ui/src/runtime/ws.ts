import type { ServerEvent } from '@agent-hangar/shared';

export type WsClient = { connect(): void; close(): void };

/** WebSocket を一本だけ持ち、開閉と受信を呼び出し側の handler に渡す。 */
export function createWs(opts: { url: string; onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void; factory?: (url: string) => WebSocket }): WsClient {
  let ws: WebSocket | null = null;
  let closed = false;
  return {
    connect() {
      if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) return;
      closed = false;
      ws = (opts.factory ?? ((u) => new WebSocket(u)))(opts.url);
      ws.onopen = () => opts.onOpen();
      ws.onmessage = (m) => { try { opts.onEvent(JSON.parse(String(m.data)) as ServerEvent); } catch { /* 壊れたメッセージは無視 */ } };
      ws.onclose = () => { ws = null; if (!closed) opts.onClose(); };
      ws.onerror = () => { /* onclose が続く */ };
    },
    close() { closed = true; ws?.close(); ws = null; },
  };
}
