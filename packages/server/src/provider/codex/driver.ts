import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDriver, AskSource, LaunchSpec, LiveSource, MaterializeMode, TranscriptSource } from '../../agent/types.ts';
import { LaunchQueue } from '../opencode/serve/queue.ts';
import { isProcessAlive, watchExit } from '../opencode/serve/spawn.ts';
import { CodexRpc, stopAppServer, tuiRemote, watchStartedThread, type AppServerProcess, type ThreadResumeParams } from './appServer.ts';
import { codexBaseEnv } from './env.ts';
import type { CodexLiveTarget } from './live.ts';
import type { CodexUsage } from './usage.ts';
import { launchCodexAppServer } from './launch.ts';
import { CodexRegistry, codexRegistryPath } from './registry.ts';
import { CODEX_PERMISSION_FLAGS } from '@agent-hangar/shared';
import { codexAppServerConfig, codexPermissionOf, HANGAR_MCP_NAME, instructionValue, MCP_TOKEN_ENV, loggedOutError, noRolloutError, planCodex, PENDING_PREFIX } from './launcher.ts';

/**
 * Codex の driver の起動の面（計画の B3a、docs/design.md「Codex の起動（ベータ）」）。
 * hangar の会話 1 つに app-server を 1 本起こし、TUI（tmux の中）を `--remote` でそれにつなぐ。
 * 状態の面と許可・質問の面は B4、トランスクリプトの面は B5 が載せる。それまでは空の面を持つ（deps で差し替える）。
 * 再開（thread/resume）とフォーク（thread/fork）は同じ組み立てで app-server を起こし、既にある会話を開く（B3b）。
 */

export type CodexServeEvent = { type: 'up' | 'thread' | 'down'; sessionId: string; threadId?: string };

/** 動いている app-server の見え方（状態の面が、接続と ID を引くのに使う）。 */
export type CodexServed = {
  sessionId: string;
  cwd: string;
  pid: number;
  url: string;
  token: string;
  /** hangar の接続。引き継いだ app-server は、必要になるまで持たない。 */
  rpc: CodexRpc | null;
  /** スレッドの ID。初期プロンプトが無い会話は、TUI がつないで拾えるまで null。 */
  threadId: string | null;
};

export type CodexDriverDeps = {
  /** codex の場所。呼ばれた時点の値を読む。無ければ null。 */
  bin: () => string | null;
  /** ログイン済みか（`codex login status`）。偽のときだけ、起動の前に断る（null は分からないので断らない）（run.agent.codex.loggedOut）。無ければ確かめない。 */
  loggedIn?: () => Promise<boolean | null>;
  /** hangar の置き場（~/.agent-hangar）。app-server の記録と token のファイルを置く。 */
  home: string;
  /** TUI へ持ち込まない変数（launch/env.ts の AGENT_RUN_DROPPED_ENV）。 */
  droppedEnv: readonly string[];
  /** 知らせ。hangar の MCP がつながらなかった（mcp）、止められなかった（stop）、スレッドの ID を拾えなかった（thread）。どれも起動は止めない。 */
  report?: (what: 'mcp' | 'stop' | 'thread', e: unknown) => void;
  mcpWaitMs?: number;
  mcpPollMs?: number;
  requestTimeoutMs?: number;
  /** 初期プロンプトが無いとき、TUI がつないで thread/started が届くのを待つ上限。 */
  threadWaitMs?: number;
  /** 止めるとき、動いているターンの interrupt を待つ上限と、SIGTERM から SIGKILL までの猶予。 */
  interruptMs?: number;
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  queue?: LaunchQueue;
  /** 状態、許可・質問、トランスクリプトの面。live と asks は B4（createCodexLive）、トランスクリプトは B5 が載せる。無ければ空の面を持つ。live が track・untrack を持てば、起動した会話を載せ、止めたら外す。 */
  live?: LiveSource & { track?(t: CodexLiveTarget): void; untrack?(providerSessionId: string): void };
  asks?: AskSource;
  transcript?: TranscriptSource;
  /**
   * 使用量の面（createCodexUsage）。呼ばれた時点で引く（配線の順で、driver の方が先に組まれるため）。null を返す間は何もしない。
   * 起動した会話は、スレッドの ID と接続が揃ったとき（trackLive と同じ位置）に track し、止めたら untrack する。
   */
  usage?: () => Pick<CodexUsage, 'track' | 'untrack'> | null | undefined;
};

export type CodexDriver = AgentDriver & {
  /** その hangar の会話の app-server。無ければ null。 */
  served(sessionId: string): CodexServed | null;
  /** app-server の立ち上がり、スレッドの ID の判明、止まりを知らせる。 */
  onServe(cb: (e: CodexServeEvent) => void): () => void;
};

type Served = CodexServed & { server: AppServerProcess; turnId: string | null; offs: (() => void)[]; cancelWatch: (() => void) | null; /** 起こしたときに指定したモデル（使用量の記録用）。 */ model?: string };

/** 上限までに終わらなければ、待つのをやめて true を返す（interrupt が返らなくても止める）。 */
function withTimeout(p: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<boolean>((r) => { timer = setTimeout(() => { r(true); }, ms); timer.unref?.(); })]).finally(() => { clearTimeout(timer); });
}

const EMPTY_LIVE: LiveSource = { start() {}, stop() {}, current: () => [], onChange: () => () => {}, kick() {}, isRunning: () => false };
const EMPTY_TRANSCRIPT: TranscriptSource = { start() {}, stop() {}, readPage: (_db, sessionId) => ({ sessionId, events: [], total: 0, nextSeq: null }) };

export function createCodexDriver(deps: CodexDriverDeps): CodexDriver {
  const report = deps.report ?? ((what: string, e: unknown) => { console.warn(`[codex] ${what}: ${e instanceof Error ? e.message : String(e)}`); });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const registry = new CodexRegistry(codexRegistryPath(deps.home));
  const tokenDir = path.join(deps.home, 'codex', 'tokens');
  const served = new Map<string, Served>();
  const listeners = new Set<(e: CodexServeEvent) => void>();
  const emit = (e: CodexServeEvent): void => { for (const cb of [...listeners]) cb(e); };

  /** hangar の接続の購読。動いているターンの ID を覚える（release の interrupt が使う）。 */
  function watchTurns(s: Served, rpc: CodexRpc): void {
    s.offs.push(
      rpc.on('turn/started', (p) => { if (p.threadId === s.threadId) s.turnId = p.turn.id; }),
      rpc.on('turn/completed', (p) => { if (p.threadId === s.threadId && s.turnId === p.turn.id) s.turnId = null; }),
    );
  }

  /** 状態の面に会話を載せる（接続とスレッドの ID が揃ってから）。購読済みかは、hangar の接続が thread/start したか（subscribed）で決める。 */
  function trackLive(s: Served, subscribed: boolean): void {
    if (!s.rpc || !s.threadId) return;
    deps.live?.track?.({ providerSessionId: s.threadId, cwd: s.cwd, pid: s.pid, rpc: s.rpc, subscribed });
    deps.usage?.()?.track({ providerSessionId: s.threadId, rpc: s.rpc, model: s.model ?? null });
  }
  function untrackLive(s: Served): void {
    if (s.threadId) { deps.live?.untrack?.(s.threadId); deps.usage?.()?.untrack(s.threadId); }
  }

  /** hangar の MCP が connected になるまで待つ。failed でも上限を過ぎても知らせるだけで、起動は続ける。 */
  async function waitForMcp(rpc: CodexRpc, threadId: string): Promise<void> {
    const deadline = Date.now() + (deps.mcpWaitMs ?? 15_000);
    let last = 'unknown';
    for (;;) {
      try {
        const r = await rpc.request<{ data?: { name: string; runtimeStatus?: string | null }[] }>('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' });
        last = r.data?.find((x) => x.name === HANGAR_MCP_NAME)?.runtimeStatus ?? 'missing';
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      if (last === 'connected') return;
      if (last === 'failed' || last === 'authenticationRequired' || last === 'cancelled' || last === 'disabled') break;
      if (Date.now() >= deadline) break;
      await sleep(deps.mcpPollMs ?? 250);
    }
    report('mcp', new Error(`the hangar MCP server is not connected (${last})`));
  }

  async function stopServed(s: Served): Promise<void> {
    for (const off of s.offs.splice(0)) off();
    s.rpc?.close();
    await stopAppServer(s.server, { graceMs: deps.graceMs });
  }

  /**
   * thread/resume。アーカイブ済みの会話（`codex archive` したもの、ほかの PC でアーカイブ済みの写しを置いたもの）は、実物が -32600 `session … is archived` で断る。
   * そのときは thread/unarchive で sessions/ へ戻してから 1 度だけ resume し直す（「この PC で再開」はアーカイブ済みの会話を戻して開く、計画の E2）。
   * ファイルを sessions/ へ動かすだけでは、codex の DB のアーカイブの印が残って断られる（0.164.0 で確かめた）。
   */
  async function resumeUnarchiving(rpc: CodexRpc, threadId: string, open: Omit<ThreadResumeParams, 'threadId'>): Promise<Awaited<ReturnType<CodexRpc['threadResume']>>> {
    try {
      return await rpc.threadResume({ threadId, ...open });
    } catch (e) {
      if (!(e instanceof Error && /is archived/i.test(e.message))) throw e;
      await rpc.request('thread/unarchive', { threadId });
      return rpc.threadResume({ threadId, ...open });
    }
  }

  async function materialize(mode: MaterializeMode, spec: LaunchSpec): Promise<{ providerSessionId: string; lateSessionId?: Promise<string> }> {
    // ID の無い会話（最初の入力の前）は、app-server を起こす前に断る。
    if (mode.kind !== 'start' && mode.id.startsWith(PENDING_PREFIX)) throw noRolloutError();
    const bin = deps.bin();
    if (!bin) throw new Error('codex was not found');
    // ログインしていない codex は、起こしてから落ちる。起こす前に分かる文で断る。
    if (deps.loggedIn && (await deps.loggedIn()) === false) throw loggedOutError();
    // app-server を起こす前に、指定が通るかを確かめる（通らなければ何も起こさない）。
    const perm = codexPermissionOf(spec.mode);
    const config = codexAppServerConfig(spec, perm);
    const flags = CODEX_PERMISSION_FLAGS[perm];
    const prior = served.get(spec.hangarSessionId);
    if (prior) {
      served.delete(spec.hangarSessionId);
      await stopServed(prior).catch(() => undefined);
    }
    const handle = await launchCodexAppServer({
      bin, directory: spec.cwd, config, tokenDir, queue: deps.queue,
      // 空の環境に、この run だけの MCP の秘密を足す。argv にも設定にも載せない。
      env: { ...codexBaseEnv(bin), ...(spec.env.CODEX_HOME?.trim() ? { CODEX_HOME: spec.env.CODEX_HOME.trim() } : {}), [MCP_TOKEN_ENV]: spec.mcp.secret },
    });
    const s: Served = {
      sessionId: spec.hangarSessionId, cwd: spec.cwd, pid: handle.server.pid, url: handle.server.url, token: handle.server.token,
      rpc: handle.rpc, threadId: null, server: handle.server, turnId: null, offs: [], cancelWatch: null, ...(spec.model?.trim() ? { model: spec.model.trim() } : {}),
    };
    served.set(s.sessionId, s);
    const record = (): void => { registry.set({ sessionId: s.sessionId, pid: s.pid, port: handle.server.port, tokenFile: handle.server.tokenFile, startedAt: handle.server.startedAt, cwd: s.cwd, ...(s.threadId ? { threadId: s.threadId } : {}) }); };
    record();
    emit({ type: 'up', sessionId: s.sessionId });
    try {
      if (mode.kind !== 'start') {
        // 既にある会話を開く。hangar の外で作られたものも同じ道である。cwd は、そのプロセスの最初の resume だけ上書きできる（E0）ので、起こしたてのここで渡す。
        const open = { cwd: spec.cwd, ...(spec.model?.trim() ? { model: spec.model.trim() } : {}), approvalPolicy: flags.approval, sandbox: flags.sandbox };
        const th = mode.kind === 'resume'
          ? await resumeUnarchiving(handle.rpc, mode.id, open)
          : await handle.rpc.request<{ thread: { id: string } }>('thread/fork', { threadId: mode.id, ...open });
        s.threadId = th.thread.id;
        const m = (th as { model?: unknown }).model;
        if (typeof m === 'string' && m) s.model = m;
        watchTurns(s, handle.rpc);
        record();
        trackLive(s, true);
        emit({ type: 'thread', sessionId: s.sessionId, threadId: s.threadId });
        await waitForMcp(handle.rpc, s.threadId);
        if (spec.prompt) await handle.rpc.turnStart({ threadId: s.threadId, input: [{ type: 'text', text: spec.prompt, text_elements: [] }], ...(spec.effort?.trim() ? { effort: spec.effort.trim() } : {}) });
        return { providerSessionId: s.threadId };
      }
      if (spec.prompt) {
        // 最初の入力の前のスレッドは TUI から resume できない。hangar が最初の入力を流してから、TUI を resume でつなぐ。
        const th = await handle.rpc.threadStart({
          cwd: spec.cwd, ...(spec.model?.trim() ? { model: spec.model.trim() } : {}), approvalPolicy: flags.approval, sandbox: flags.sandbox,
          ...(instructionValue(spec.instructions) !== null ? { developerInstructions: instructionValue(spec.instructions)! } : {}),
        });
        s.threadId = th.thread.id;
        const m = (th as { model?: unknown }).model;
        if (typeof m === 'string' && m) s.model = m;
        watchTurns(s, handle.rpc);
        record();
        trackLive(s, true);
        emit({ type: 'thread', sessionId: s.sessionId, threadId: s.threadId });
        // MCP がつながる前に最初の入力を流すと、1 歩目の道具の目録に hangar の道具が載らない。
        await waitForMcp(handle.rpc, s.threadId);
        await handle.rpc.turnStart({ threadId: s.threadId, input: [{ type: 'text', text: spec.prompt, text_elements: [] }], ...(spec.effort?.trim() ? { effort: spec.effort.trim() } : {}) });
        return { providerSessionId: s.threadId };
      }
      // 初期プロンプトが無いときは、TUI を resume なしでつなぐ。つないだ時点で全接続へ届く thread/started から ID を拾う。
      // 通知は TUI がつなぐ前に見張りを作らないと取り逃すので、TUI を起こす前（ここ）で作る。
      const watch = watchStartedThread(handle.rpc, { cwd: spec.cwd, timeoutMs: deps.threadWaitMs ?? 60_000 });
      s.cancelWatch = watch.cancel;
      const late = watch.promise.then((t) => {
        s.cancelWatch = null;
        s.threadId = t.id;
        watchTurns(s, handle.rpc);
        if (served.get(s.sessionId) === s) { record(); trackLive(s, false); emit({ type: 'thread', sessionId: s.sessionId, threadId: t.id }); }
        return t.id;
      });
      late.catch((e: unknown) => { if (served.get(s.sessionId) === s) report('thread', e); });
      return { providerSessionId: `${PENDING_PREFIX}${crypto.randomUUID()}`, lateSessionId: late };
    } catch (e) {
      if (served.get(s.sessionId) === s) served.delete(s.sessionId);
      registry.remove(s.sessionId);
      untrackLive(s);
      emit({ type: 'down', sessionId: s.sessionId });
      await stopServed(s).catch(() => undefined);
      // rollout が無いスレッドは、実物が -32600「no rollout found」で返す。分かる断りに直す。
      if (mode.kind !== 'start' && e instanceof Error && /no rollout found/i.test(e.message)) throw noRolloutError();
      throw e;
    }
  }

  /** hangar を起こし直したとき、前の hangar が残した app-server を記録から引き継ぐ。接続は、止めるときまで開かない。 */
  function reattach(target: { sessionId: string; providerSessionId: string; cwd: string }): boolean {
    const rec = registry.get(target.sessionId);
    if (!rec) return false;
    let token: string;
    try {
      token = fs.readFileSync(rec.tokenFile, 'utf8').trim();
    } catch {
      registry.remove(target.sessionId);
      return false;
    }
    if (!token || !isProcessAlive(rec.pid)) {
      registry.remove(target.sessionId);
      return false;
    }
    const url = `ws://127.0.0.1:${rec.port}`;
    // 引き継いだプロセスには子の口（ChildProcess）が無い。止める側が使うのは pid と終わりの知らせと token のファイルだけである。
    const server = { pid: rec.pid, port: rec.port, url, token, tokenFile: rec.tokenFile, startedAt: rec.startedAt, child: null, exited: watchExit(rec.pid, 100) } as unknown as AppServerProcess;
    const threadId = rec.threadId ?? (target.providerSessionId.startsWith(PENDING_PREFIX) ? null : target.providerSessionId);
    const s: Served = { sessionId: target.sessionId, cwd: rec.cwd, pid: rec.pid, url, token, rpc: null, threadId, server, turnId: null, offs: [], cancelWatch: null };
    served.set(target.sessionId, s);
    emit({ type: 'up', sessionId: target.sessionId });
    // 引き継いだ app-server は接続を持たないので、状態の面のために、ここでつなぎ直す（失敗しても引き継ぎは続ける）。
    // thread/start した接続ではないので、購読は状態の面が最初の active で行う。ID が分からない会話（TUI がまだつないでいなかった）は載せない。
    if ((deps.live?.track || deps.usage) && threadId) {
      void CodexRpc.connect({ url, token, requestTimeoutMs: deps.requestTimeoutMs ?? 3000, connectTimeoutMs: 2000 }).then((rpc) => {
        if (served.get(s.sessionId) !== s || s.rpc) { rpc.close(); return; }
        s.rpc = rpc;
        watchTurns(s, rpc);
        trackLive(s, false);
      }, (e: unknown) => { report('thread', e); });
    }
    return true;
  }

  /**
   * 動いているターンがあれば interrupt する（rollout に中断の行が残る）。接続は、引き継いだ app-server なら、ここで token を使ってつなぐ。
   * つなげなければ（別のプロセスに pid を使い回されたかもしれない）、false を返し、呼び手は何も止めない。
   */
  async function interruptActive(s: Served): Promise<boolean> {
    if (!s.rpc || s.rpc.isClosed) {
      s.rpc = await CodexRpc.connect({ url: s.url, token: s.token, requestTimeoutMs: deps.requestTimeoutMs ?? 3000, connectTimeoutMs: 2000 });
    }
    const rpc = s.rpc;
    if (!s.threadId) return true;
    let turnId = s.turnId;
    if (!turnId) {
      const r = await rpc.request<{ thread?: { turns?: { id: string; status?: string }[] } }>('thread/read', { threadId: s.threadId, includeTurns: true }).catch(() => null);
      turnId = r?.thread?.turns?.find((t) => t.status === 'inProgress')?.id ?? null;
    }
    if (!turnId) return true;
    const done = new Promise<void>((resolve) => { rpc.on('turn/completed', (p) => { if (p.threadId === s.threadId) resolve(); }); });
    await rpc.turnInterrupt(s.threadId, turnId);
    // 中断の行が rollout に書かれるのを、少しだけ待つ。
    await Promise.race([done, sleep(500)]);
    return true;
  }

  /**
   * その会話の app-server を止める。TUI は呼び手が先に閉じている（RunManager が release の直後、同じ手の中で画面を閉じる）。
   * app-server だけ先に止めると、TUI は「Reconnecting to server…」のまま居残る。
   * 動いているターンを interrupt してから SIGTERM を送る。interrupt だけでは孫（シェルの子など）が残るので、app-server ごと止める（B2-PROBE）。
   * TUI だけが閉じたとき（tui-gone）も、killed と parked も同じ止め方である（決定 2）。
   */
  async function release(target: { sessionId?: string; providerSessionId: string; cwd: string }): Promise<boolean> {
    const s = target.sessionId ? served.get(target.sessionId) : [...served.values()].find((x) => x.threadId === target.providerSessionId);
    if (!s) return false;
    served.delete(s.sessionId);
    s.cancelWatch?.();
    untrackLive(s);
    emit({ type: 'down', sessionId: s.sessionId });
    let ours = true;
    try {
      ours = await withTimeout(interruptActive(s), deps.interruptMs ?? 4000);
    } catch (e) {
      // 接続できない：自分の app-server なら止める（もう居ないか、応答しないだけ）。引き継いだものは、別のプロセスかもしれないので止めない。
      if (s.server.child === null) ours = false;
      report('stop', e);
    }
    registry.remove(s.sessionId);
    if (!ours) {
      for (const off of s.offs.splice(0)) off();
      s.rpc?.close();
      return false;
    }
    await stopServed(s).catch((e: unknown) => report('stop', e));
    return true;
  }

  return {
    kind: 'codex',
    // アカウントは CODEX_HOME で分ける。推論と権限の 3 段は持つ。フォークは driver が thread/fork まで持ち、RunManager.fork の materialize の道（B3c）で受ける。外の会話の引き取りは E 段。
    caps: { accounts: true, effort: true, permissionMode: true, remoteControl: false, fork: true, attachExternal: false, promptJump: false },
    launch: {
      // TUI は hangar が起こした app-server につなぐ。run の pid は TUI の包みで、RunManager は包みの生死で TUI の終わりを見る。
      servedByHangar: true,
      materialize,
      reattach,
      plan(bin, mode, spec) {
        const s = served.get(spec.hangarSessionId);
        if (!s) throw new Error('the codex app-server for this session is not running');
        return planCodex(bin, mode, spec, tuiRemote(s.url, s.token), deps.droppedEnv);
      },
      release: (target) => release(target),
    },
    live: deps.live ?? EMPTY_LIVE,
    transcript: deps.transcript ?? EMPTY_TRANSCRIPT,
    asks: deps.asks ?? {},
    // 追記は app-server の起動時の設定（developer_instructions）で渡す。動いている会話の差し替えは持たない。
    instructions: { when: 'launch' },
    served: (id) => served.get(id) ?? null,
    onServe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
}
