import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsShell } from '../../../platform/exec.ts';
import { ensureMode } from '../../../platform/secure.ts';
import type { PaneOps } from '../../../tmux/pane.ts';
import { killGroup, newServePassword, pickFreePort, READY_PATH, SERVE_HOST, ServeStartError, serveHeaders, watchExit, type ServeProcess, type ServeStartReason, type StartServeOptions } from './spawn.ts';

/**
 * `opencode serve` を tmux（Windows は psmux）の画面の中で起こす（docs/design.md「opencode の serve の管理」）。
 *
 * Windows で hangar が直に起こした serve は、Node のジョブ（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）に入り、hangar のサーバが終わると道連れになる。
 * serve の下の子も殻のジョブ（winjob.rs）に残るので、Hangar を閉じると止まる。
 * psmux はサーバをジョブの外に起こすので、その画面の中で起こせば、Hangar を閉じても claude と同じく動き続ける。
 *
 * 画面の中では包み（hangar-serve.mjs）が serve を起こす。
 * 起こす指定（環境、合言葉、hangar の MCP の秘密）は 0600 のファイルに書いて場所だけを渡し、包みが読んで消す。
 * argv と tmux のセッションの環境に秘密を載せないためである（launch/secretEnv.ts と同じ考え）。
 * 包みは serve の出力をログに書き、serve の pid と終わりを状態のファイルに書く。ここではそれを読んで、応答を待つ。
 */

/** 包みのファイルの名前。<home>/bin に置く。 */
export const SERVE_WRAPPER_NAME = 'hangar-serve.mjs';

/** 包みの本体。同じディレクトリの hangar-serve.mjs を読む。同梱版でも server.mjs の隣に置く。 */
export function serveWrapperScript(): string {
  return fs.readFileSync(fileURLToPath(new URL('./hangar-serve.mjs', import.meta.url)), 'utf8');
}

/** <home>/bin に包みを置き、その場所を返す。中身が同じなら書かない。 */
export function ensureServeWrapper(home: string): string {
  const dir = path.join(home, 'bin');
  const file = path.join(dir, SERVE_WRAPPER_NAME);
  const body = serveWrapperScript();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body, { mode: 0o644 });
  return file;
}

/** serve の画面の名前。run の画面（hangar-<16 進>）とシェルタブ（-t<n>）の形には当たらない。 */
export function servePaneName(key: string): string {
  return `hangar-serve-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/** 画面の中で起こすのに要るもの。 */
export type PaneServeHost = {
  /** いまの画面の口。tmux が無ければ null で、そのときは呼び手が直に起こす。 */
  panes: () => PaneOps | null;
  /** 包みを起こす Node。ペインの中の PATH に頼らない。 */
  node: string;
  /** 包みの場所（ensureServeWrapper）。 */
  wrapper: () => string;
  /** 起こす指定、ログ、状態のファイルの置き場。 */
  dir: string;
};

/** 状態のファイル。pid は serve の pid、exit は serve の終了コード（終わったときだけ）。 */
type PaneState = { pid?: number | null; exit?: number };

const LOCKED = /database is locked/i;
const PORT_IN_USE = /EADDRINUSE|address already in use|Is port \d+ in use/i;

function readState(file: string): PaneState | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as PaneState; } catch { return null; }
}

function readTail(file: string): string {
  try { return fs.readFileSync(file, 'utf8').slice(-8192); } catch { return ''; }
}

const rm = (file: string): void => { try { fs.rmSync(file, { force: true }); } catch { /* 次の起動で上書きする。 */ } };

/** 画面の置き場のファイル。 */
export function paneServeFiles(dir: string, name: string): { spec: string; log: string; state: string } {
  return { spec: path.join(dir, `${name}.spec.json`), log: path.join(dir, `${name}.log`), state: path.join(dir, `${name}.state.json`) };
}

/** 止めた serve の画面とファイルを片付ける。画面は serve が終われば包みと一緒に閉じるが、残っていれば閉じる。 */
export function disposeServePane(host: Pick<PaneServeHost, 'panes' | 'dir'>, name: string): void {
  try { host.panes()?.close(name); } catch { /* 無ければよい。 */ }
  const f = paneServeFiles(host.dir, name);
  rm(f.spec); rm(f.log); rm(f.state);
}

/**
 * serve を画面の中で起こし、応答するまで待つ。ポートが塞がっていたら取り直す。ほかの失敗は ServeStartError で投げる。
 * 同じ名前の画面が残っていれば（前の起動の残り）、先に閉じる。
 */
export async function startServeInPane(o: StartServeOptions & { key: string; host: PaneServeHost }): Promise<ServeProcess> {
  const password = o.password ?? newServePassword();
  const attempts = o.portAttempts ?? 5;
  for (let i = 0; ; i++) {
    const port = await (o.pickPort ?? pickFreePort)();
    try {
      return await launchInPane(o, port, password);
    } catch (e) {
      if (e instanceof ServeStartError && e.reason === 'port-in-use' && i + 1 < attempts) continue;
      throw e;
    }
  }
}

async function launchInPane(o: StartServeOptions & { key: string; host: PaneServeHost }, port: number, password: string): Promise<ServeProcess> {
  const panes = o.host.panes();
  if (!panes) throw new ServeStartError('spawn', 'opencode serve could not start: tmux is not available');
  const name = servePaneName(o.key);
  const url = `http://${SERVE_HOST}:${port}`;
  const directory = o.directory ?? null;
  const files = paneServeFiles(o.host.dir, name);
  disposeServePane(o.host, name);
  fs.mkdirSync(o.host.dir, { recursive: true, mode: 0o700 });
  ensureMode(o.host.dir, 0o700);
  const spec = {
    bin: o.bin,
    args: ['serve', '--hostname', SERVE_HOST, '--port', String(port)],
    cwd: directory ?? undefined,
    env: { ...o.env, OPENCODE_SERVER_PASSWORD: password },
    shell: needsShell(o.bin),
    log: files.log,
    state: files.state,
  };
  fs.writeFileSync(files.spec, JSON.stringify(spec), { mode: 0o600 });
  ensureMode(files.spec, 0o600);
  const startedAt = Date.now();
  try {
    panes.open({ name, cwd: directory ?? o.host.dir, command: [o.host.node, o.host.wrapper(), files.spec] });
  } catch (e) {
    rm(files.spec);
    throw new ServeStartError('spawn', `opencode serve could not start: ${(e as Error).message}`);
  }
  const why = (): string => readTail(files.log).split(password).join('***').trim().slice(-500);
  const fail = (reason: ServeStartReason, message: string): never => {
    disposeServePane(o.host, name);
    throw new ServeStartError(reason, message);
  };
  const pollMs = o.pollMs ?? 100;
  const deadline = Date.now() + (o.readyTimeoutMs ?? 20_000);
  let lastListed = 0;
  for (;;) {
    const st = readState(files.state);
    if (st && st.exit !== undefined) {
      const out = why();
      const reason: ServeStartReason = st.exit === 127 && !st.pid ? 'spawn' : LOCKED.test(out) ? 'locked' : PORT_IN_USE.test(out) ? 'port-in-use' : 'exited';
      fail(reason, `opencode serve exited before it answered (${reason}): ${out}`);
    }
    if (Date.now() > deadline) {
      if (st?.pid) killGroup(st.pid, 'SIGKILL');
      fail('timeout', `opencode serve did not answer within the time limit: ${why()}`);
    }
    // 包みが状態を書く前に画面ごと消えた（Node を起こせなかったなど）。時間切れまで待たずに諦める。画面の一覧は重いので 1 秒おきに見る。
    if (!st && Date.now() - startedAt > 1000 && Date.now() - lastListed >= 1000) {
      lastListed = Date.now();
      const listed = panes.list();
      if (listed && !listed.includes(name)) fail('spawn', `opencode serve could not start: the serve pane closed before it started: ${why()}`);
    }
    const pid = st?.pid;
    if (pid) {
      try {
        const r = await fetch(url + READY_PATH, { headers: serveHeaders({ password, directory }), signal: AbortSignal.timeout(1000) });
        await r.arrayBuffer().catch(() => undefined);
        if (r.status === 200) {
          // 包みが読み損ねた指定は、ここで消す（包みは読んだらすぐ消す）。
          rm(files.spec);
          return { pid, port, url, password, directory, startedAt, pane: name, exited: watchExit(pid) };
        }
      } catch {
        // まだ待ち受けていない。
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
