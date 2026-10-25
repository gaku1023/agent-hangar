import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeOpencodeVersion, type OpencodeVersionVerdict } from '../compat/version.ts';
import { serveEnv, type ServeConfig } from './env.ts';
import { LaunchQueue, retryOnLock } from './queue.ts';
import type { ServeRecord, ServeRegistry } from './registry.ts';
import { killGroup, serveHeaders, startServe, watchExit, type ServeProcess, type StartServeOptions } from './spawn.ts';

/**
 * 会話ごとの `opencode serve` を起こし、止める（docs/design.md「opencode の serve の管理」）。
 * 起動は待ち行列で 1 本ずつにし、ロックで落ちたら起こし直す。止めるときは interrupt、SIGTERM、SIGKILL の順にする。
 */

/** 起きている serve。directory は serve の作業フォルダ（会話のフォルダ）で、OpencodeClient は場所を言わない要求もここを指す。ServeManager は必ず埋める（試験の偽物は省ける）。 */
export type ServeInfo = { url: string; password: string; pid: number; directory?: string };

/**
 * 起こすときにだけ効く指定。directory は serve の作業フォルダで、会話のフォルダを渡す。
 * 省くと（会話に依らない選択肢とプロバイダーの問い合わせ）ホームにする。hangar の作業フォルダは継がない。
 * 渡した場所がフォルダとして無ければ（消した、まだ作っていない）ホームにする。無い場所を cwd にすると spawn が ENOENT で落ちるからである。
 */
export type ServeEnsureOptions = ServeConfig & { directory?: string };

/** serve の作業フォルダ。頼まれた場所、ホームの順に、フォルダとしてあるものを選ぶ。どちらも無ければ undefined（spawn は呼び手の場所を継ぐ）。 */
export function serveDirectory(requested: string | undefined, home: string = os.homedir()): string | undefined {
  for (const d of [requested, home]) {
    if (!d) continue;
    try { if (fs.statSync(d).isDirectory()) return d; } catch { /* 無い。次を見る */ }
  }
  return undefined;
}

/**
 * 確かめた範囲の外の版で serve を起こしたときの、知らせの種。表示（一度だけの札）は段 C（C7）で作る。
 * 起動は止めない（決定 8）。
 */
export type OpencodeVersionNoticeSeed = {
  kind: 'opencode-version';
  version: string | null;
  verdict: Exclude<OpencodeVersionVerdict, 'verified'>;
};

/**
 * serve の合言葉の作り方。起動ごとに元（nonce）を乱数で作り、合言葉はそれと hangar の置き場の鍵から作る。
 * 記録（serves.json）には元だけを書くので、記録を読まれても合言葉は漏れない。
 * hangar を起こし直したら、記録の元から同じ合言葉を作り直し、動いている会話の serve につなぎ直す（adopt）。
 */
export type ServeSecrets = { nonce: () => string; password: (nonce: string) => string };

/** 鍵のファイル（<HANGAR_HOME>/opencode/serve.key、0600）。無ければ作る。 */
export function serveSecrets(home: string): ServeSecrets {
  const file = path.join(home, 'opencode', 'serve.key');
  let key: Buffer | null = null;
  const keyOf = (): Buffer => {
    if (key) return key;
    try {
      const k = fs.readFileSync(file);
      if (k.length >= 32) return (key = k);
    } catch { /* 無い。下で作る。 */ }
    const k = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, k, { mode: 0o600 });
    return (key = k);
  };
  return {
    nonce: () => crypto.randomBytes(16).toString('base64url'),
    password: (nonce) => crypto.createHmac('sha256', keyOf()).update(`opencode-serve:${nonce}`).digest('base64url'),
  };
}

/** serve を起こす口。既定は直に起こす（spawn.ts）。Windows は画面の中で起こす（pane.ts）。key は会話の ID。 */
export type ServeStarter = (o: StartServeOptions & { key: string }) => Promise<ServeProcess>;

/** 設定の「opencode を有効にする」が切なので起こさない。 */
export class OpencodeDisabledError extends Error {
  constructor() {
    super('opencode is disabled in settings');
    this.name = 'OpencodeDisabledError';
  }
}

/** opencode が見つからない。 */
export class OpencodeNotFoundError extends Error {
  constructor() {
    super('opencode was not found');
    this.name = 'OpencodeNotFoundError';
  }
}

export type ServeManagerDeps = {
  /** 設定の opencodeEnabled。呼ばれた時点の値を読む。 */
  enabled: () => boolean;
  /** opencode の場所。見つからなければ null。 */
  bin: () => string | null;
  /** 手元の opencode の版（compat/version.ts の LocalOpencode）。読めなければ null。 */
  version: () => Promise<string | null>;
  registry: ServeRegistry;
  /** 起動の前に済ませること（残った serve の掃除）。済むまで 1 本も起こさない。 */
  ready?: Promise<unknown>;
  /** 空の環境を作る元。既定はサーバの環境。 */
  env?: NodeJS.ProcessEnv;
  onVersionNotice?: (seed: OpencodeVersionNoticeSeed) => void;
  log?: (line: string) => void;
  queue?: LaunchQueue;
  /** ロックで落ちたときの起こし直しの間。 */
  lockDelaysMs?: readonly number[];
  pickPort?: () => Promise<number>;
  readyTimeoutMs?: number;
  /** SIGTERM から SIGKILL までの間。 */
  killGraceMs?: number;
  /** interrupt の 1 回の上限。serve が固まっていても、止めるのを引き延ばさない。 */
  interruptTimeoutMs?: number;
  /** 合言葉の作り方。省くと起動ごとの乱数にし、元を記録に書かない（引き継げない）。 */
  secrets?: ServeSecrets;
  /** serve を起こす口。省くと直に起こす。 */
  start?: ServeStarter;
  /** 止めた serve の画面を閉じ、ファイルを片付ける（pane.ts の disposeServePane）。 */
  disposePane?: (name: string) => void;
  /** 子として持たない serve の生死を見る間隔。 */
  watchMs?: number;
};

export class ServeManager {
  private readonly live = new Map<string, ServeProcess>();
  private readonly launching = new Map<string, Promise<ServeProcess>>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly queue: LaunchQueue;

  constructor(private readonly deps: ServeManagerDeps) {
    this.queue = deps.queue ?? new LaunchQueue();
  }

  /**
   * 会話の serve。起きていればそれを返し、無ければ待ち行列で起こす。同じ会話を同時に頼まれても 1 本だけ起こす。
   * config は起こすときにだけ渡す設定（hangar の MCP）と作業フォルダで、起きている serve には効かない。
   */
  async ensure(sessionId: string, config: ServeEnsureOptions = {}): Promise<ServeInfo> {
    const s = this.live.get(sessionId) ?? (await this.launch(sessionId, config));
    return infoOf(s);
  }

  /** 起きている serve。無ければ null。 */
  get(sessionId: string): ServeInfo | null {
    const s = this.live.get(sessionId);
    return s ? infoOf(s) : null;
  }

  /** 起きている serve のどれか 1 本。1 本も無ければ null。会話に依らない問い合わせ（新しいセッションの選択肢）が、新しく起こさずに済ませるために使う。 */
  any(): ServeInfo | null {
    const s = this.live.values().next();
    return s.done ? null : infoOf(s.value);
  }

  /**
   * 会話の serve を止める。起動の途中なら起き切るのを待ってから止める。
   * 止めている途中に重ねて頼まれたら、同じ止め終わりを待つ（画面が閉じた run の後始末と、起動の失敗の後始末が重なることがある）。
   */
  async stop(sessionId: string): Promise<void> {
    await this.launching.get(sessionId)?.catch(() => undefined);
    const inflight = this.stopping.get(sessionId);
    if (inflight) return inflight;
    const s = this.live.get(sessionId);
    if (!s) return;
    this.live.delete(sessionId);
    const p = this.terminate(s).finally(() => { if (this.stopping.get(sessionId) === p) this.stopping.delete(sessionId); });
    this.stopping.set(sessionId, p);
    await p;
  }

  /**
   * 全部を止める。hangar の終わりの後片付けで呼ぶ。
   * keep が真の会話（動いている run の会話）の serve は止めずに残す。TUI はその serve につながったまま動き続け、次に起きた hangar が引き継ぐ（adopt）。
   * 起動の途中のものは、起き切るのを待ってから keep で決める。
   */
  async stopAll(o: { keep?: (sessionId: string) => boolean } = {}): Promise<void> {
    await Promise.all([...this.launching.values()].map((p) => p.catch(() => undefined)));
    await Promise.all([...this.live.keys()].filter((id) => !o.keep?.(id)).map((id) => this.stop(id)));
  }

  /**
   * 前の hangar が起こし、いまも動いている serve を引き継ぐ。記録の元から合言葉を作り直す。
   * 呼び手（boot/opencode.ts）が、動いている会話の serve で、いまも hangar の起こした serve であるものだけを渡す（registry.ts の adoptableServes）。
   * 引き継いだ serve は子として持たないので、終わりは間をおいて生死を見て拾う。
   */
  adopt(records: readonly ServeRecord[]): string[] {
    const { secrets } = this.deps;
    if (!secrets) return [];
    const out: string[] = [];
    for (const r of records) {
      if (!r.nonce || this.live.has(r.sessionId)) continue;
      const url = `http://127.0.0.1:${r.port}`;
      const s: ServeProcess = {
        pid: r.pid, port: r.port, url, password: secrets.password(r.nonce), directory: r.directory ?? null, startedAt: r.startedAt,
        nonce: r.nonce, exited: watchExit(r.pid, this.deps.watchMs),
        ...(r.pane ? { pane: r.pane } : {}),
      };
      this.hold(r.sessionId, s);
      out.push(r.sessionId);
      this.deps.log?.(`[opencode] serve adopted for ${r.sessionId} (pid ${r.pid}, port ${r.port})`);
    }
    return out;
  }

  private launch(sessionId: string, config: ServeEnsureOptions): Promise<ServeProcess> {
    const inflight = this.launching.get(sessionId);
    if (inflight) return inflight;
    const p = this.startOne(sessionId, config).finally(() => this.launching.delete(sessionId));
    this.launching.set(sessionId, p);
    return p;
  }

  private async startOne(sessionId: string, config: ServeEnsureOptions): Promise<ServeProcess> {
    const { deps } = this;
    await deps.ready?.catch(() => undefined);
    if (!deps.enabled()) throw new OpencodeDisabledError();
    const bin = deps.bin();
    if (!bin) throw new OpencodeNotFoundError();
    // 版は起動のたびに見る（同じファイルなら LocalOpencode が覚えた版を返す）。範囲の外でも起動は続ける。
    const version = await deps.version().catch(() => null);
    const verdict = judgeOpencodeVersion(version);
    if (verdict !== 'verified') deps.onVersionNotice?.({ kind: 'opencode-version', version, verdict });
    const env = serveEnv(bin, deps.env, undefined, { configContent: config.configContent });
    const directory = serveDirectory(config.directory);
    const nonce = deps.secrets?.nonce();
    const password = nonce !== undefined ? deps.secrets!.password(nonce) : undefined;
    const start: ServeStarter = deps.start ?? startServe;
    const started = await this.queue.run(() => retryOnLock(
      () => start({ key: sessionId, bin, env, directory, password, pickPort: deps.pickPort, readyTimeoutMs: deps.readyTimeoutMs }),
      { delaysMs: deps.lockDelaysMs },
    ));
    const s: ServeProcess = nonce !== undefined ? { ...started, nonce } : started;
    deps.registry.add({
      sessionId, pid: s.pid, port: s.port, startedAt: s.startedAt,
      ...(nonce !== undefined ? { nonce } : {}), ...(s.directory ? { directory: s.directory } : {}), ...(s.pane ? { pane: s.pane } : {}),
    });
    this.hold(sessionId, s);
    deps.log?.(`[opencode] serve started for ${sessionId} (pid ${s.pid}, port ${s.port}${s.pane ? `, pane ${s.pane}` : ''})`);
    return s;
  }

  /** 起きている serve として持つ。自分で終わった serve は手放し（次の ensure で起こし直す）、画面を片付ける。 */
  private hold(sessionId: string, s: ServeProcess): void {
    this.live.set(sessionId, s);
    void s.exited.then(() => {
      if (this.live.get(sessionId) === s) this.live.delete(sessionId);
      this.deps.registry.remove(s.pid);
      if (s.pane) this.deps.disposePane?.(s.pane);
    });
  }

  /** interrupt（API）→ SIGTERM → 間をおいて SIGKILL。 */
  private async terminate(s: ServeProcess): Promise<void> {
    await this.interruptAll(s).catch(() => undefined);
    const graceMs = this.deps.killGraceMs ?? 3000;
    if (killGroup(s.pid, 'SIGTERM')) {
      const timer = new Promise<'timeout'>((r) => { setTimeout(() => r('timeout'), graceMs).unref?.(); });
      if ((await Promise.race([s.exited.then(() => 'gone' as const), timer])) === 'timeout') {
        killGroup(s.pid, 'SIGKILL');
        await s.exited;
      }
    }
    this.deps.registry.remove(s.pid);
    if (s.pane) this.deps.disposePane?.(s.pane);
  }

  /** serve の上で走っている会話を全部 interrupt する。TUI を閉じてもサーバ側の処理は続くので、信号の前に止める。 */
  private async interruptAll(s: ServeProcess): Promise<void> {
    const ms = this.deps.interruptTimeoutMs ?? 1500;
    const headers = { ...serveHeaders(s), 'content-type': 'application/json' };
    const r = await fetch(`${s.url}/api/session/active`, { headers, signal: AbortSignal.timeout(ms) });
    if (!r.ok) return;
    const body = (await r.json()) as { data?: Record<string, unknown> } | null;
    const ids = Object.keys(body?.data ?? {});
    for (const id of ids) {
      await fetch(`${s.url}/api/session/${encodeURIComponent(id)}/interrupt`, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(ms) })
        .then((x) => x.arrayBuffer())
        .catch(() => undefined);
    }
  }
}

const infoOf = (s: ServeProcess): ServeInfo => ({ url: s.url, password: s.password, pid: s.pid, ...(s.directory ? { directory: s.directory } : {}) });
