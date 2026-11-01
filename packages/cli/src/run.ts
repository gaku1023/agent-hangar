import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { samePath } from '@agent-hangar/server/src/cliEntry.ts';
import type { SessionWaitState } from '@agent-hangar/shared';
import { oneLineError, probeHealth, probeReady } from './probe.ts';
import { absolutePath } from './project.ts';
import { assertPortFree, serverArgs } from './start.ts';

/**
 * hangar run。会話を作るか既存の会話に送り、ターンの終わりか入力待ちまで待って、結果を返す。
 * スクリプトから使う入口で、端末の無い場所でも動く。対話の問いは作らない。
 * 動いているサーバの MCP の道具（create_session、send_to_session、wait_for_session）をそのまま呼ぶ。画面と同じ道を通すので、動き方を別に持たない。
 * サーバが止まっていれば、アプリを開かずに画面なしで起こし、終わりに止める。
 */

/** 終了の符号。2 は hangar project などと同じく「サーバが使えない」に当てる。 */
export const EXIT = { finished: 0, failed: 1, server: 2, timeout: 3, waiting: 4 } as const;

export function exitCodeOf(state: SessionWaitState): number {
  return EXIT[state];
}

/** 1 回の待ちの長さ（秒）。fetch は本文が 5 分流れないと切るので、それより短く区切って呼び直す。 */
const WAIT_CHUNK_SECONDS = 240;
/** サーバが消えたときに起こし直す回数。ほかの hangar run が止めた分を拾うためで、落ち続けるときは諦める。 */
const MAX_SERVER_RETRIES = 5;
/** ふつうの道具の呼び出しの上限。create_session は準備を待たずに 15 秒で返す。 */
const CALL_TIMEOUT_MS = 60_000;
/** 画面なしのサーバの起動を待つ上限。初回の索引は履歴の量に比例する（8 GB で約 2 分）ので、長めにとる。 */
const READY_TIMEOUT_MS = 600_000;
/** 止める合図の後に待つ上限。サーバは STOP_WATCHDOG_MS で必ず降りるが、それでも居座れば落とす。 */
const STOP_TIMEOUT_MS = 20_000;

/** サーバの面。試験が差し替える。ensure は使える状態にして、自分で起こしたかを返す。 */
export type RunServer = { ensure(): Promise<{ owned: boolean }>; stop(): Promise<void> };

export type RunCommandOptions = {
  port: number;
  token: string;
  json: boolean;
  /** 待つ上限（秒）。 */
  timeoutSeconds: number;
  cwd: string;
  prompt?: string;
  session?: string;
  project?: string;
  agent?: string;
  model?: string;
  name?: string;
  effort?: string;
  permissionMode?: string;
  server: RunServer;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  error?: (line: string) => void;
  now?: () => number;
  /** その会話が動いているか。無ければ list_sessions で確かめる。 */
  isRunning?: (sessionId: string) => Promise<boolean>;
};

type WaitAnswer = { session_id: string; state: SessionWaitState; reason?: string; status: string | null; waiting?: { kind: string; text: string }; last_message: string | null; waited_seconds: number; url: string };

class ServerGone extends Error {}
class RunFailure extends Error {
  constructor(readonly reason: string, message: string, readonly code: number = EXIT.failed) {
    super(message);
  }
}

/** MCP の道具を 1 回呼ぶ。つながらなければ ServerGone、断りは RunFailure にする。 */
async function callTool<T>(o: RunCommandOptions, name: string, args: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  const fetchFn = o.fetch ?? fetch;
  let text: string;
  let status: number;
  try {
    const r = await fetchFn(`http://127.0.0.1:${o.port}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = r.status;
    text = await r.text();
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') throw new RunFailure('http_error', `サーバーが ${Math.round(timeoutMs / 1000)} 秒以内に応答しませんでした`);
    throw new ServerGone(e instanceof Error ? e.message : String(e));
  }
  if (status === 401 || status === 403) throw new RunFailure('unauthorized', 'トークンが一致しません。サーバーと同じ HANGAR_HOME で実行しているか確認してください');
  if (status < 200 || status >= 300) throw new RunFailure('http_error', `HTTP ${status}`);
  // 長く待つ道具は SSE で、ほかは JSON で返る。
  const json = text.trimStart().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).find((l) => l.includes('"result"') || l.includes('"error"'));
  let m: { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };
  try {
    m = JSON.parse(json ?? '') as typeof m;
  } catch {
    throw new RunFailure('http_error', 'サーバーの応答を読めませんでした');
  }
  if (m.error) throw new RunFailure('rejected', m.error.message ?? 'サーバーが断りました');
  const body = m.result?.content?.[0]?.text ?? '';
  if (m.result?.isError) throw new RunFailure('rejected', body);
  return JSON.parse(body) as T;
}

/** --project（id かパス）、無ければ作業フォルダを含むいちばん深いプロジェクト。 */
async function resolveProject(o: RunCommandOptions): Promise<string> {
  const list = await callTool<{ id: string; path: string | null }[]>(o, 'list_projects', {});
  if (o.project) {
    const byId = list.find((p) => p.id === o.project);
    if (byId) return byId.id;
    const want = absolutePath(o.project, { cwd: o.cwd }).normalize('NFC');
    const hit = list.find((p) => p.path !== null && samePath(p.path.normalize('NFC'), want));
    if (hit) return hit.id;
    throw new RunFailure('not_found', `${o.project} に該当するプロジェクトがありません（id か、この PC でのパスを指定してください）`);
  }
  const inside = list.filter((p) => {
    if (p.path === null) return false;
    const rel = path.relative(p.path, o.cwd);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }).sort((a, b) => b.path!.length - a.path!.length);
  if (!inside[0]) throw new RunFailure('not_found', `${o.cwd} を含むプロジェクトがありません。--project で指定してください`);
  return inside[0].id;
}

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export async function runCommand(o: RunCommandOptions): Promise<number> {
  const log = o.log ?? ((l: string) => console.log(l));
  const error = o.error ?? ((l: string) => console.error(l));
  const now = o.now ?? (() => Date.now());
  let owned = false;
  const emitFailure = (reason: string, message: string, code: number): number => {
    if (o.json) log(JSON.stringify({ state: 'failed', reason, message, exit_code: code }));
    else error(message);
    return code;
  };
  let retries = 0;
  const ensure = async (): Promise<void> => { owned = (await o.server.ensure()).owned || owned; };
  /** サーバが消えたら起こし直して呼び直す。行き違いで 2 重に送らないよう、読むだけの道具と待ちにだけ使う。 */
  const withServer = async <T>(call: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await call();
      } catch (e) {
        if (!(e instanceof ServerGone) || retries >= MAX_SERVER_RETRIES) throw e;
        retries++;
        await ensure();
      }
    }
  };
  const waitOnce = (sessionId: string, seconds: number) => withServer(() => callTool<WaitAnswer>(o, 'wait_for_session', { session_id: sessionId, timeout_seconds: seconds }, (seconds + 30) * 1000));

  try {
    if (o.prompt === undefined && !o.session) return emitFailure('no_prompt', 'プロンプトを指定してください（引数か、- で標準入力から）', EXIT.failed);
    await ensure();
    let sessionId: string;
    if (o.session) {
      sessionId = o.session;
      const running = o.isRunning
        ? await o.isRunning(sessionId)
        : (await withServer(() => callTool<{ id: string }[]>(o, 'list_sessions', { running: true, limit: 200 }))).some((s) => s.id === sessionId);
      if (!running) {
        await callTool(o, 'resume_session', { session_id: sessionId });
        // 立ち上がる前に送ると入力が落ちるので、送るときだけ入力を受けられるまで待つ。
        if (o.prompt !== undefined) await waitOnce(sessionId, Math.min(WAIT_CHUNK_SECONDS, Math.max(o.timeoutSeconds, 0)));
      }
      if (o.prompt !== undefined) await callTool(o, 'send_to_session', { session_id: sessionId, text: o.prompt });
    } else {
      const projectId = await withServer(() => resolveProject(o));
      const created = await callTool<{ session_id: string }>(o, 'create_session', defined({ project_id: projectId, prompt: o.prompt, agent: o.agent, model: o.model, name: o.name, effort: o.effort, permission_mode: o.permissionMode }));
      sessionId = created.session_id;
    }
    const deadline = now() + o.timeoutSeconds * 1000;
    let answer: WaitAnswer;
    do {
      const left = Math.max(Math.ceil((deadline - now()) / 1000), 0);
      answer = await waitOnce(sessionId, Math.min(left, WAIT_CHUNK_SECONDS));
    } while (answer.state === 'timeout' && now() < deadline);

    const code = exitCodeOf(answer.state);
    if (o.json) {
      log(JSON.stringify({ ...answer, exit_code: code }));
      return code;
    }
    if (answer.last_message && answer.state !== 'timeout') log(answer.last_message);
    if (answer.state === 'waiting') error(`入力を待っています（${answer.waiting?.text || answer.waiting?.kind || '内容は不明'}）。続きは hangar run --session ${answer.session_id} "<入力>"`);
    if (answer.state === 'timeout') error(`${o.timeoutSeconds} 秒待ちましたが終わっていません。会話は動き続けます。続きを待つには hangar run --session ${answer.session_id}`);
    if (answer.state === 'failed') error(answer.reason === 'limit' ? `使用制限で止まりました（${answer.session_id}）` : `会話は実行中ではありません（${answer.session_id}）`);
    return code;
  } catch (e) {
    if (e instanceof RunFailure) return emitFailure(e.reason, e.message, e.code);
    if (e instanceof ServerGone) return emitFailure('server_unavailable', `サーバーに接続できません: ${e.message}`, EXIT.server);
    if (e instanceof ServerStartError) return emitFailure('server_unavailable', e.message, EXIT.server);
    return emitFailure('server_unavailable', `サーバーを起動できませんでした: ${oneLineError(e)}`, EXIT.server);
  } finally {
    if (owned) await o.server.stop();
  }
}

export class ServerStartError extends Error {}

/**
 * 本物のサーバの面。止まっていれば子プロセスで画面なしのサーバを起こす。
 * 子の出力は置き場のログへ流す。標準出力は結果のために空けておく（--json を汚さない）。
 * HANGAR_PARENT_PID を渡すので、CLI が強制終了されても子は自分から降りる。
 * 起こしたサーバを残さないのは、残すと次に開くアプリがポートを取れないためである。止めても tmux の会話は動き続け、次のサーバがつなぎ直す。
 */
export function headlessServer(o: { port: number; home: string; args?: string[] }): RunServer {
  let child: ChildProcess | null = null;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitReady = async (alive: () => boolean): Promise<boolean> => {
    const limit = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < limit) {
      if (await probeReady(o.port)) return true;
      if (!alive()) return false;
      await sleep(200);
    }
    return false;
  };
  return {
    async ensure() {
      if (await probeHealth(o.port)) {
        // 応答はするが起動の途中のときは、済むまで待つ。
        if (await waitReady(() => true)) return { owned: false };
        throw new ServerStartError(`ポート ${o.port} のサーバーの起動が終わりませんでした`);
      }
      try {
        await assertPortFree(o.port);
      } catch (e) {
        throw new ServerStartError(`ポート ${o.port} を使えません: ${oneLineError(e)}`);
      }
      const logPath = path.join(o.home, 'hangar-run-server.log');
      fs.mkdirSync(o.home, { recursive: true });
      const out = fs.openSync(logPath, 'a');
      const win = process.platform === 'win32';
      const c = spawn(process.execPath, o.args ?? serverArgs(), {
        // Windows には SIGTERM が無いので、殻と同じく標準入力の管を閉じて止める。
        stdio: [win ? 'pipe' : 'ignore', out, out],
        env: { ...process.env, HANGAR_PORT: String(o.port), HANGAR_PARENT_PID: String(process.pid), ...(win ? { HANGAR_STOP_ON_STDIN_END: '1' } : {}) },
      });
      fs.closeSync(out);
      let gone = false;
      c.on('exit', () => { gone = true; });
      c.on('error', () => { gone = true; });
      child = c;
      if (await waitReady(() => !gone)) {
        // 同時に起こした別の hangar run に負けたときは、勝った方のサーバを借りる。
        if (gone) { child = null; return { owned: false }; }
        return { owned: true };
      }
      child = null;
      if (await probeReady(o.port)) return { owned: false };
      if (!gone) c.kill('SIGKILL');
      throw new ServerStartError(`サーバーを起動できませんでした。ログを確認してください: ${logPath}`);
    },
    async stop() {
      const c = child;
      child = null;
      if (!c || c.exitCode !== null || c.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { c.kill('SIGKILL'); resolve(); }, STOP_TIMEOUT_MS);
        c.once('exit', () => { clearTimeout(timer); resolve(); });
        if (process.platform === 'win32') c.stdin?.end();
        else c.kill('SIGTERM');
      });
    },
  };
}
