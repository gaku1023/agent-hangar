import type http from 'node:http';
import os from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { originAllowed, tokenFromRequest } from '../auth/request.ts';
import { muxServersOf, type MuxServers } from '../tmux/servers.ts';
import { controlSpawn } from '../tmux/control.ts';
import type { Tmux } from '../tmux/tmux.ts';

export type PtyProcess = { pid: number; onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void; write(d: string): void; resize(cols: number, rows: number): void; kill(): void };
export type PtySpawn = (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => PtyProcess;
type Deps = { token: string; /** 待ち受けているポート。許可する Origin をここから組み立てる。 */ port: number; /** hangar の tmux のサーバの組（tmux/servers.ts）。Tmux 1 つなら、そのサーバだけを使う。 */ tmux: Tmux | MuxServers | null; resolveTab: (tabId: string) => string | null; spawn: PtySpawn; /** コントロールモード（tmux/control.ts）でつなぐタブか。シェルのタブだけを真にする。渡さなければ、どのタブも擬似端末の attach。 */ controlTab?: (tabId: string) => boolean; /** コントロールモードのつなぎ。試験で差し替える。 */ controlSpawn?: (tmux: Tmux, name: string) => PtyProcess; /** attach が終わった（tmux の画面が閉じたかもしれない）。run の見張りを急がせる（RunManager.stir）。 */ onExit?: () => void; /** 出力をまとめて送る窓と上限。試験で差し替える。 */ coalesce?: { windowMs: number; maxBytes: number } };

/**
 * pty の出力をまとめて送る窓（ミリ秒）。
 * 出力が多いと通数が増え、画面の描画の負荷が上がる。
 * 窓より空いた後の先頭の出力はその場で送り、窓の中で続いた分だけを 1 通にする。
 */
export const COALESCE_WINDOW_MS = 16;
/** 貯めがこの大きさ（文字数）に達したら、窓の終わりを待たずに送る。 */
export const COALESCE_MAX_BYTES = 64 * 1024;

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
  /** 接続ごとの tmux 名。note が宛先の画面に attach している接続を引くために持つ。 */
  private names = new Map<WebSocket, string>();
  /** 接続ごとの貯めの吐き出し。note など、貯めの後ろに文を足す前に先に出すために持つ。 */
  private flushers = new Map<WebSocket, () => void>();
  constructor(private readonly deps: Deps) {}

  /**
   * その tmux 名に attach している接続へ、端末に 1 行を差し込む。
   * claude を止める前に理由を残すために使う。attach している接続が無ければ何も起きない。
   */
  note(tmuxName: string, text: string): void {
    for (const [ws, name] of this.names) {
      if (name === tmuxName && ws.readyState === ws.OPEN) { this.flushers.get(ws)?.(); ws.send(JSON.stringify({ t: 'data', d: '\r\n' + text + '\r\n' })); }
    }
  }

  /** Settings で tmuxPath が変わったときに差し替える。既に attach している接続はそのまま残る。 */
  setTmux(tmux: Tmux | MuxServers | null): void {
    this.deps.tmux = tmux;
  }

  /**
   * upgrade 要求のうち path が一致するものだけを受ける。
   * 一致しないものは黙って返し、別の WebSocket サーバに譲る。
   * どこも引き取らなかった要求を切るのは番人（ws/guard.ts）の役目である。
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
      const tabId = url.searchParams.get('tab') ?? '';
      this.wss.handleUpgrade(req, socket, head, (ws) => this.serve(ws, name, this.deps.controlTab?.(tabId) ?? false));
    });
  }

  private serve(ws: WebSocket, tmuxName: string, control: boolean): void {
    const mux = muxServersOf(this.deps.tmux!);
    // 前の版が利用者の既定のサーバに作ったセッションは、そのサーバへつなぐ。
    const tmux = mux.serverOf(tmuxName);
    // 中のアプリの OSC 52 を UI の xterm まで通させる。サーバ全体の設定なので、tmux サーバが起き直した後にも効くよう attach のたびに確かめる。
    // どちらもサーバ全体の設定なので、hangar の専用のサーバにだけ入れる。利用者の既定のサーバには入れない。
    if (tmux === mux.own) {
      tmux.enableClipboard();
      tmux.ensureTerminalOptions();
    }
    let p: PtyProcess;
    try {
      // シェルのタブは、選択とスクロールを xterm に持たせるためにコントロールモードでつなぐ（tmux/control.ts）。
      // Windows の psmux は対応を確かめていないので、擬似端末の attach のままにする。
      if (control && tmux.supportsControl) p = (this.deps.controlSpawn ?? controlSpawn)(tmux, tmuxName);
      else p = this.deps.spawn(tmux.tmuxPath, tmux.attachArgs(tmuxName), { name: 'xterm-256color', cols: 120, rows: 40, cwd: os.homedir(), env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG ?? 'ja_JP.UTF-8' } });
    } catch (e) {
      // error を送ったら必ず閉じる。開いたままだと UI の端末が再接続せず、利用者がその画面から戻れない。
      ws.send(JSON.stringify({ t: 'error', message: `pty spawn failed: ${e instanceof Error ? e.message : String(e)}` }));
      ws.close(1011, 'spawn failed');
      return;
    }
    this.clients.set(ws, p);
    this.names.set(ws, tmuxName);
    const { windowMs, maxBytes } = this.deps.coalesce ?? { windowMs: COALESCE_WINDOW_MS, maxBytes: COALESCE_MAX_BYTES };
    let buf = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSent = -Infinity;
    const drop = (): void => { buf = ''; if (timer !== null) clearTimeout(timer); timer = null; };
    const flush = (): void => {
      const d = buf;
      drop();
      if (d !== '' && ws.readyState === ws.OPEN) { ws.send(JSON.stringify({ t: 'data', d })); lastSent = Date.now(); }
    };
    this.flushers.set(ws, flush);
    p.onData((d) => {
      if (ws.readyState !== ws.OPEN) return;
      const now = Date.now();
      if (buf === '' && timer === null && now - lastSent >= windowMs) { ws.send(JSON.stringify({ t: 'data', d })); lastSent = now; return; }
      buf += d;
      if (buf.length >= maxBytes) { flush(); return; }
      if (timer === null) timer = setTimeout(flush, Math.max(0, lastSent + windowMs - now));
    });
    p.onExit(() => {
      flush();
      if (ws.readyState === ws.OPEN) ws.close(1000, 'exited');
      this.deps.onExit?.();
    });
    ws.on('message', (raw) => {
      let m: { t?: string; d?: unknown; cols?: unknown; rows?: unknown };
      try { m = JSON.parse(raw.toString()) as typeof m; } catch { return; }
      if (m.t === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows) && (m.cols as number) > 0 && (m.rows as number) > 0) p.resize(m.cols as number, m.rows as number);
      else if (m.t === 'data' && typeof m.d === 'string') p.write(m.d);
    });
    // 殺すのは attach しているクライアントだけで、tmux セッションはそのまま残す。
    ws.on('close', () => { drop(); this.flushers.delete(ws); this.clients.delete(ws); this.names.delete(ws); killQuietly(p); });
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
    this.names.clear();
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
