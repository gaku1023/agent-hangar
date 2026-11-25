import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findInDirs, knownDirs, splitPathEnv } from '../platform/exec.ts';

/**
 * AI の英語の返答と思考を、表示する側で日本語にする翻訳の口。PFN の `plamo-translate`（PLaMo 翻訳の CLI）を使う。
 *
 * - `plamo-translate server` は MCP のサーバ（streamable-http）で、`plamo-translate` という道具を 1 つ持つ。
 *   待ち受けのポートはモデルを載せ終えてから決まり、一時フォルダの `plamo-translate-config.json` に書かれる。
 *   hangar はそのファイルからポートを読み、MCP の道具を呼ぶ。
 * - 利用者が自分で起こしたサーバがすでに居れば、それを使い、止めない。
 *   居なければ hangar が起こし、しばらく使わなければ（IDLE_STOP_MS）止める。止めないとモデルがメモリに残る（2B の 4bit で 2.6GB 前後）。
 * - 翻訳は 1 本ずつ順に回す。サーバは 1 本のモデルで順に訳すので、並べて投げても速くならない。
 * - Windows は plamo-translate が動かない（WSL だけ）ので、使えないものとして扱う。
 */

/** 使わない時間がこれを超えたら、hangar が起こしたサーバを止める。 */
export const IDLE_STOP_MS = 10 * 60_000;
/** 起こしてから応答するまで待つ上限。初回はモデル（5.8GB）を落とすので長く取る。 */
export const START_TIMEOUT_MS = 20 * 60_000;
/** 起動を待つ間の見回りの間隔。 */
const START_POLL_MS = 1000;
/** 1 回の翻訳の上限。長い返答でも数十秒で終わる。 */
export const CALL_TIMEOUT_MS = 120_000;
/** 居るかの確かめの上限。 */
const PROBE_TIMEOUT_MS = 3000;

export type PlamoProc = { pid: number; exited: Promise<void>; kill(): void };

export type PlamoDeps = {
  platform: NodeJS.Platform;
  /** plamo-translate の場所。無ければ null。 */
  find(): string | null;
  /** `plamo-translate server` を起こす。 */
  spawn(bin: string): PlamoProc;
  /** 一時フォルダの設定ファイルに書かれたポート。無ければ null。 */
  readPort(): number | null;
  /** そのポートに plamo-translate の道具を持つサーバが居るか。 */
  probe(port: number): Promise<boolean>;
  /** 英語を日本語に訳す。 */
  call(port: number, text: string): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log?(msg: string): void;
};

export class PlamoUnavailableError extends Error {
  constructor() {
    super('plamo-translate is not installed');
    this.name = 'PlamoUnavailableError';
  }
}

export class PlamoTranslator {
  private port: number | null = null;
  /** hangar が起こしたサーバ。利用者が起こしたものは持たない（止めない）。 */
  private owned: PlamoProc | null = null;
  private starting: Promise<number> | null = null;
  /** 待っている翻訳。新しく頼まれたものから訳す（後入れ先出し）。 */
  private readonly waiting: { text: string; resolve(out: string): void; reject(e: unknown): void }[] = [];
  private working = false;
  private lastUsed = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: PlamoDeps, private readonly enabled: () => boolean = () => true) {}

  available(): boolean {
    return this.deps.platform !== 'win32' && this.deps.find() !== null;
  }

  /**
   * 英語を日本語に訳す。1 本ずつ回し、待っているものは新しく頼まれたものから訳す。
   * 画面は会話を上から順に描いて頼むので、いちばん下（最新）の返答が最後に頼まれる。古い順に訳すと、見ている最新の返答が最後まで英語のまま残る。
   * サーバが落ちていたら 1 度だけ起こし直してやり直す。
   */
  translate(text: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.waiting.push({ text, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (let job = this.waiting.pop(); job; job = this.waiting.pop()) {
        try {
          job.resolve(await this.run(job.text));
        } catch (e) {
          job.reject(e);
        }
      }
    } finally {
      this.working = false;
    }
  }

  private async run(text: string): Promise<string> {
    this.lastUsed = this.deps.now();
    for (let attempt = 0; ; attempt++) {
      const port = await this.ensure();
      try {
        const out = await this.deps.call(port, text);
        this.lastUsed = this.deps.now();
        return out;
      } catch (e) {
        this.port = null;
        if (attempt >= 1) throw e;
        this.deps.log?.(`translate: call failed, retrying (${(e as Error).message})`);
      }
    }
  }

  private async ensure(): Promise<number> {
    if (this.port !== null && await this.deps.probe(this.port)) return this.port;
    this.port = null;
    const known = this.deps.readPort();
    if (known !== null && await this.deps.probe(known)) return (this.port = known);
    if (!this.starting) this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<number> {
    if (this.deps.platform === 'win32') throw new PlamoUnavailableError();
    const bin = this.deps.find();
    if (!bin) throw new PlamoUnavailableError();
    // 前に起こしたものが残っていれば止めてから起こす（応答しなくなったサーバ）。
    this.stopOwned();
    const proc = this.deps.spawn(bin);
    this.owned = proc;
    let gone = false;
    void proc.exited.then(() => {
      gone = true;
      if (this.owned === proc) { this.owned = null; this.port = null; }
    });
    const until = this.deps.now() + START_TIMEOUT_MS;
    while (this.deps.now() < until) {
      if (gone) throw new Error('plamo-translate server exited while starting');
      const port = this.deps.readPort();
      if (port !== null && await this.deps.probe(port)) {
        this.deps.log?.(`translate: plamo-translate server is ready on ${port}`);
        return (this.port = port);
      }
      await this.deps.sleep(START_POLL_MS);
    }
    this.stopOwned();
    throw new Error('plamo-translate server did not become ready');
  }

  /** 見回り。使わない時間が長いか、設定が切なら、hangar が起こしたサーバを止める。 */
  tick(): void {
    if (!this.owned || this.starting || this.working) return;
    if (!this.enabled() || this.deps.now() - this.lastUsed > IDLE_STOP_MS) {
      this.deps.log?.('translate: stopping idle plamo-translate server');
      this.stopOwned();
    }
  }

  startWatch(everyMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), everyMs);
    this.timer.unref?.();
  }

  /** hangar の終わり。見回りを止め、hangar が起こしたサーバを止める。 */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.stopOwned();
  }

  private stopOwned(): void {
    const p = this.owned;
    if (!p) return;
    this.owned = null;
    this.port = null;
    p.kill();
  }
}

/** plamo-translate の設定ファイルのある一時フォルダ。plamo-translate の config_directory と同じ決め方にする（TMPDIR、無ければ一時フォルダの下の利用者ごとのフォルダ）。 */
export function plamoConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TMPDIR) return env.TMPDIR;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `plamo-translate-${uid}`);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

async function withClient<T>(port: number, ms: number, f: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'agent-hangar', version: '1' });
  try {
    return await withTimeout((async () => {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      return f(client);
    })(), ms, 'plamo-translate');
  } finally {
    void client.close().catch(() => undefined);
  }
}

/** plamo-translate を探す。`~/.local/bin`（uv tool の置き場）、PATH、既知の置き場の順に見る。無ければ null。 */
export function findPlamoTranslate(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir(), known: string[] = knownDirs()): string | null {
  return findInDirs('plamo-translate', [path.join(homeDir, '.local', 'bin'), ...splitPathEnv(env.PATH), ...known]);
}

/** 実物の口。 */
export function realPlamoDeps(log?: (msg: string) => void): PlamoDeps {
  const env = process.env;
  return {
    platform: process.platform,
    find: () => findPlamoTranslate(env),
    spawn: (bin) => {
      // hangar の秘密（HANGAR_ で始まるもの）は渡さない。TMPDIR は継ぐ（設定ファイルの場所を hangar と合わせるため）。
      const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('HANGAR_')));
      const child = spawn(bin, ['server'], { env: childEnv, cwd: os.homedir(), stdio: 'ignore', detached: true });
      child.unref();
      const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
      return {
        pid: child.pid ?? -1,
        exited,
        kill: () => {
          const pid = child.pid;
          if (!pid || pid <= 0) return;
          // まとまり（Python とその下の子）ごと止める。
          try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* もう居ない */ } }
        },
      };
    },
    readPort: () => {
      try {
        const c = JSON.parse(readFileSync(path.join(plamoConfigDir(env), 'plamo-translate-config.json'), 'utf8')) as { port?: unknown };
        return typeof c.port === 'number' && Number.isInteger(c.port) && c.port > 0 ? c.port : null;
      } catch {
        return null;
      }
    },
    probe: async (port) => {
      try {
        return await withClient(port, PROBE_TIMEOUT_MS, async (c) => (await c.listTools()).tools.some((t) => t.name === 'plamo-translate'));
      } catch {
        return false;
      }
    },
    call: (port, text) => withClient(port, CALL_TIMEOUT_MS, async (c) => {
      // plamo-translate の CLI と同じ形で渡す（入力の言語と出力の言語を、それぞれ 1 通の頭に書く）。
      const res = await c.callTool({
        name: 'plamo-translate',
        arguments: {
          request: { messages: [{ role: 'user', content: `input lang=English\n${text}` }, { role: 'user', content: 'output lang=Japanese\n' }], source_language: '', target_language: '' },
          stream: false,
        },
      });
      const parts = (res.content as { type: string; text?: string }[] | undefined) ?? [];
      const out = parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
      if (res.isError) throw new Error(out || 'plamo-translate returned an error');
      return out.replace(/\n$/, '');
    }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  };
}
