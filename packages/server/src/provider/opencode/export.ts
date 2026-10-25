import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSafeKeyId } from '@agent-hangar/shared';
import { opencodeProbeEnv } from './compat/version.ts';
import { LOCK_RETRY_DELAYS_MS } from './serve/queue.ts';

/**
 * opencode の本文の書き出し（docs/design.md「opencode の本文の同期」）。
 *
 * opencode の本文は opencode の SQLite にあり、同期で上げられるファイルが無い。
 * そこで `opencode session export <ID>` で会話 1 つを JSON（info と messages の全体）に書き出し、
 * `~/.agent-hangar/opencode/export/<ID>.json` に置く。上げる側（sync/uploader.ts）は、そのファイルを Claude の本文と同じ道で上げる。
 *
 * - CLI を既定にする。serve の `/api/experimental/session/{id}/export` は実験用で、版で変わりうるからである。
 * - 会話の serve が起きていれば `--server <url>` でつなぎ、パスワードは環境の `OPENCODE_PASSWORD` だけで渡す（argv は `ps` で誰からも読める）。
 *   serve が無ければ（止まった後の run の終わり）`--standalone` で、私用のサーバを一時だけ起こして書き出す。
 *   `--server` で失敗したら（serve が先に止まった）`--standalone` で取り直す。
 * - 空の環境から起こす（compat/version.ts の opencodeProbeEnv）。hangar の環境の CLAUDE 系と HANGAR_* と API キーを渡さない。
 * - 原子的に書く。同じ置き場の一時ファイルに書き、終わりの状態が 0 で、中身が JSON で、会話の ID が頼んだ ID と同じときだけ名前を付け替える。
 *   失敗したら一時ファイルを消し、前に書いたファイルはそのまま残す。上げる側は途中まで書いたファイルを決して読まない。
 * - `database is locked` で落ちたら、serve の起動と同じ間をあけて取り直す（serve/queue.ts）。
 * - 同じ会話を同時に頼まれたら、書き出しを重ねずに同じ結果を返す。
 *
 * 本文を含むので、置き場は 0700、ファイルは 0600 にする。ログには本文も会話の ID も秘密も出さない。
 */

/** 書き出しの置き場。 */
export function opencodeExportDir(home: string): string {
  return path.join(home, 'opencode', 'export');
}

export type OpencodeExporterDeps = {
  /** hangar の home（`~/.agent-hangar`）。 */
  home: string;
  /** opencode の場所。見つからなければ null。呼ばれた時点の値を読む。 */
  bin: () => string | null;
  /** 会話（opencode の ID）の serve。起きていなければ null。 */
  serveOf: (providerSessionId: string) => { url: string; password: string } | null;
  /** 空の環境を作る元。既定はサーバの環境。 */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** 1 回の書き出しの上限。過ぎたら止めて失敗にする。 */
  timeoutMs?: number;
  lockDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

/** 1 回の書き出しの結果。locked は取り直してよい失敗である。 */
type Attempt = { ok: true } | { ok: false; locked: boolean; reason: string };

const DEFAULT_TIMEOUT_MS = 60_000;
/** 標準エラーは理由を見分けるのにだけ使う。長い出力を抱えない。 */
const STDERR_CAP = 4096;

export class OpencodeExporter {
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(private readonly deps: OpencodeExporterDeps) {}

  get dir(): string { return opencodeExportDir(this.deps.home); }

  /** 会話を書き出し直し、書いたファイルの絶対パスを返す。書けなければ null（前に書いたファイルは残る）。 */
  export(providerSessionId: string): Promise<string | null> {
    const running = this.inflight.get(providerSessionId);
    if (running) return running;
    const p = this.run(providerSessionId).finally(() => { this.inflight.delete(providerSessionId); });
    this.inflight.set(providerSessionId, p);
    return p;
  }

  private log(line: string): void { (this.deps.log ?? ((l: string) => { console.warn(l); }))(line); }

  private async run(id: string): Promise<string | null> {
    // 置き場の外を指す名前にしない。ID は opencode が振った `ses_…` で、鍵に使える形しか受けない。
    if (!isSafeKeyId(id)) return null;
    const bin = this.deps.bin();
    if (bin === null) return null;
    const dir = this.dir;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    } catch (e) {
      this.log(`[opencode] could not prepare the export folder: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
      return null;
    }
    const target = path.join(dir, `${id}.json`);
    const serve = this.deps.serveOf(id);
    let last = 'unknown';
    // serve が起きていればまずそれにつなぎ、だめなら私用のサーバで取り直す。
    for (const via of serve ? (['server', 'standalone'] as const) : (['standalone'] as const)) {
      const r = await this.withLockRetry(() => this.attempt(bin, id, target, via === 'server' ? serve : null));
      if (r.ok) return target;
      last = r.reason;
    }
    this.log(`[opencode] could not export a session for sync: ${last}`);
    return null;
  }

  private async withLockRetry(job: () => Promise<Attempt>): Promise<Attempt> {
    const delays = this.deps.lockDelaysMs ?? LOCK_RETRY_DELAYS_MS;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; ; i++) {
      const r = await job();
      const delay = delays[i];
      if (r.ok || !r.locked || delay === undefined) return r;
      await sleep(delay);
    }
  }

  /** 1 回書き出す。一時ファイルに書き、確かめてから名前を付け替える。 */
  private attempt(bin: string, id: string, target: string, serve: { url: string; password: string } | null): Promise<Attempt> {
    const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const drop = (): void => { try { fs.rmSync(tmp, { force: true }); } catch { /* 消せなくても次の回の名前は別である */ } };
    const env: NodeJS.ProcessEnv = { ...opencodeProbeEnv(bin, this.deps.env ?? process.env, this.deps.platform ?? process.platform) };
    if (serve) env.OPENCODE_PASSWORD = serve.password;
    const argv = ['session', 'export', ...(serve ? ['--server', serve.url] : ['--standalone']), id];
    return new Promise<Attempt>((resolve) => {
      let out: fs.WriteStream;
      try {
        out = fs.createWriteStream(tmp, { mode: 0o600, flags: 'wx' });
      } catch (e) {
        resolve({ ok: false, locked: false, reason: (e as NodeJS.ErrnoException).code ?? 'tmp' });
        return;
      }
      let stderr = '';
      let settled = false;
      const finish = (r: Attempt): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!r.ok) drop();
        resolve(r);
      };
      const child = spawn(bin, argv, { cwd: path.dirname(target), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref?.();
      child.stderr.on('data', (c: Buffer) => { if (stderr.length < STDERR_CAP) stderr += c.toString('utf8'); });
      child.stdout.pipe(out);
      child.on('error', (e: NodeJS.ErrnoException) => { out.destroy(); finish({ ok: false, locked: false, reason: e.code ?? 'spawn' }); });
      // 終わりの状態と、標準出力を書き切ったことの両方がそろってから確かめる。
      const closed = new Promise<void>((r) => { out.on('close', () => r()); out.on('error', () => r()); });
      child.on('close', (code, signal) => {
        void closed.then(() => {
          if (settled) return;
          if (code !== 0) {
            const locked = /database is locked/i.test(stderr);
            finish({ ok: false, locked, reason: locked ? 'locked' : signal ? `signal ${signal}` : `exit ${String(code)}` });
            return;
          }
          if (!this.valid(tmp, id)) { finish({ ok: false, locked: false, reason: 'invalid output' }); return; }
          try {
            fs.renameSync(tmp, target);
          } catch (e) {
            finish({ ok: false, locked: false, reason: (e as NodeJS.ErrnoException).code ?? 'rename' });
            return;
          }
          finish({ ok: true });
        });
      });
    });
  }

  /** 書き出した中身が、頼んだ会話の export か。JSON で、info.id が同じで、messages が配列であること。 */
  private valid(file: string, id: string): boolean {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { info?: { id?: unknown }; messages?: unknown };
      return v.info?.id === id && Array.isArray(v.messages);
    } catch {
      return false;
    }
  }
}
