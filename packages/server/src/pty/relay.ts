import type http from 'node:http';
import os from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { originAllowed, tokenFromRequest } from '../http/auth.ts';
import type { Tmux } from '../tmux/tmux.ts';

export type PtyProcess = { pid: number; onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void; write(d: string): void; resize(cols: number, rows: number): void; kill(): void };
export type PtySpawn = (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => PtyProcess;
type Deps = { token: string; /** 待ち受けているポート。許可する Origin をここから組み立てる。 */ port: number; tmux: Tmux | null; resolveTab: (tabId: string) => string | null; spawn: PtySpawn };

/** close フレームに応えない相手を待つ上限。これを過ぎたら接続を切り、pty を落とす。 */
const CLOSE_GRACE_MS = 500;

function killQuietly(p: PtyProcess): void {
  try { p.kill(); } catch { /* 既に終わっている */ }
}

/** /ws/pty?tab=<tabId> で node-pty の `tmux attach` を中継する。複数のクライアントが同じ tmux セッションに attach してよい。 */
export class PtyRelay {
  private wss = new WebSocketServer({ noServer: true });
  /** 接続と、その接続が抱えている tmux attach の pty。close で確実に回収するために紐づけて持つ。 */
  private clients = new Map<WebSocket, PtyProcess>();
  constructor(private readonly deps: Deps) {}

  /** Settings で tmuxPath が変わったときに差し替える。既に attach している接続はそのまま残る。 */
  setTmux(tmux: Tmux | null): void {
    this.deps.tmux = tmux;
  }

  /**
   * upgrade 要求のうち path が一致するものだけを受ける。
   * 一致しないものは黙って返し、別の WebSocket サーバに譲る。
   * どこも引き取らなかった要求を切るのは server.ts の役目である。
   */
  attach(server: http.Server, path: string): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== path) return;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      // トークンはヘッダかクッキーだけで受ける。クエリに置くと Referer や代理のログに秘密が残る。
      const token = tokenFromRequest(headers, req.headers.cookie);
      if (!originAllowed(req.headers.origin, this.deps.port) || token !== this.deps.token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      const name = this.deps.resolveTab(url.searchParams.get('tab') ?? '');
      if (!name || !this.deps.tmux) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.serve(ws, name));
    });
  }

  private serve(ws: WebSocket, tmuxName: string): void {
    const tmux = this.deps.tmux!;
    let p: PtyProcess;
    try {
      p = this.deps.spawn(tmux.tmuxPath, tmux.attachArgs(tmuxName), { name: 'xterm-256color', cols: 120, rows: 40, cwd: os.homedir(), env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG ?? 'ja_JP.UTF-8' } });
    } catch (e) {
      // error を送ったら必ず閉じる。開いたままだと UI の端末が再接続せず、利用者がその画面から戻れない。
      ws.send(JSON.stringify({ t: 'error', message: `pty spawn failed: ${e instanceof Error ? e.message : String(e)}` }));
      ws.close(1011, 'spawn failed');
      return;
    }
    this.clients.set(ws, p);
    p.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'data', d })); });
    p.onExit(() => { if (ws.readyState === ws.OPEN) ws.close(1000, 'exited'); });
    ws.on('message', (raw) => {
      let m: { t?: string; d?: unknown; cols?: unknown; rows?: unknown };
      try { m = JSON.parse(raw.toString()) as typeof m; } catch { return; }
      if (m.t === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows) && (m.cols as number) > 0 && (m.rows as number) > 0) p.resize(m.cols as number, m.rows as number);
      else if (m.t === 'data' && typeof m.d === 'string') p.write(m.d);
    });
    // 殺すのは attach しているクライアントだけで、tmux セッションはそのまま残す。
    ws.on('close', () => { this.clients.delete(ws); killQuietly(p); });
  }

  clientCount(): number { return this.clients.size; }

  /**
   * 全員に close フレームを送る。
   * 応えない相手は CLOSE_GRACE_MS で terminate し、その接続の pty もここで落とす。
   * close イベントの発火を当てにすると、止まったタブが tmux attach のプロセスを残してしまう。
   */
  close(): void {
    const entries = [...this.clients];
    this.clients.clear();
    this.wss.close();
    if (entries.length === 0) return;
    let pending = entries.length;
    const timer = setTimeout(() => {
      for (const [ws, p] of entries) {
        if (ws.readyState !== ws.CLOSED) ws.terminate();
        killQuietly(p);
      }
    }, CLOSE_GRACE_MS);
    timer.unref();
    const done = (): void => { if (--pending === 0) clearTimeout(timer); };
    for (const [ws] of entries) {
      if (ws.readyState === ws.CLOSED) { done(); continue; }
      ws.once('close', done);
      ws.close(1001, 'server shutting down');
    }
  }
}
