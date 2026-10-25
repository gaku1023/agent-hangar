import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isSafeKeyId } from '@agent-hangar/shared';
import { OpencodeClient } from './client.ts';
import { opencodeProbeEnv } from './compat/version.ts';
import { LOCK_RETRY_DELAYS_MS } from './serve/queue.ts';
import type { ServeManager } from './serve/manager.ts';

/**
 * opencode の会話を PC の間で渡す口（docs/design.md「opencode の本文の同期」の取り込みと引き継ぎ）。
 *
 * - 取り込み（importSession）：ほかの PC が上げた export の JSON を、この PC の opencode に `session import` で入れる。
 *   作業の場所は `--directory` で、この PC の場所（RunManager の cwdFor の値）を渡す。2 台のパスの違いはここで吸収する。
 *   入れたら `GET /api/session/{id}` で場所が頼んだとおりかを確かめる。
 *   実物の 2.1.4 は、既にある ID への import を上書きも重複もせず、標準エラーに `Session already exists` を書いて 0 で終わる（2026-10-25 に確かめた）。
 *   そこで、手元の会話を置き換えるとき（replace）は、先に `session delete` で消してから入れる（未決 5 の仮の置き方。利用者に聞く件）。
 * - 止める（quiesce）：引き継ぎを頼まれたとき、会話の作業を interrupt し、`/api/session/active` から外れる（idle になる）まで待つ。
 *   TUI を閉じてもサーバの側の作業は続くので、書き出しの前に止める。
 *
 * どちらも会話の serve（ServeManager）につなぐ。私用のサーバ（--standalone）を別に起こすと、serve と同じ記録の置き場を 2 本で開き、`database is locked` で落ちうるからである。
 * CLI は空の環境から起こし（compat/version.ts の opencodeProbeEnv）、serve のパスワードは環境の `OPENCODE_PASSWORD` だけで渡す（argv は `ps` で誰からも読める）。
 */

/** 取り込みの失敗。reason は、exists（既にあって入らなかった）、location（場所が無い）、directory（入った場所が違う）、そのほか（CLI の終わり方など）。 */
export class OpencodeImportError extends Error {
  constructor(readonly reason: string) {
    super(`could not import the opencode session: ${reason}`);
    this.name = 'OpencodeImportError';
  }
}

export type OpencodeTransferDeps = {
  /** opencode の場所。見つからなければ null。 */
  bin: () => string | null;
  serves: Pick<ServeManager, 'ensure' | 'get'>;
  /** 空の環境を作る元。既定はサーバの環境。 */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** CLI の 1 回の上限。 */
  timeoutMs?: number;
  lockDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
};

type CliResult = { code: number | null; stdout: string; stderr: string };

const DEFAULT_TIMEOUT_MS = 60_000;
const OUT_CAP = 4096;
/** idle を待つ既定の上限。引き継ぎの応答を長く止めない。 */
const QUIESCE_TIMEOUT_MS = 30_000;
const QUIESCE_POLL_MS = 500;

/** 2 つの場所が同じか。綴りが同じか、実体（realpath）が同じなら同じとみなす（`/tmp` と `/private/tmp` など）。 */
function samePlace(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

export class OpencodeTransfer {
  constructor(private readonly deps: OpencodeTransferDeps) {}

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);
  }

  /**
   * export の JSON（file）を、この PC の opencode に会話 providerSessionId として入れる。場所は directory。
   * replace なら、先に同じ ID の会話を消す（無ければ消さずに進む）。
   * 会話の serve を起こしてつなぐ。起こした serve は止めない（続く再開が新しい MCP の秘密で起こし直す）。
   * 入らなかったら OpencodeImportError で投げる。
   */
  async importSession(o: { hangarSessionId: string; providerSessionId: string; file: string; directory: string; replace: boolean }): Promise<void> {
    if (!isSafeKeyId(o.providerSessionId)) throw new OpencodeImportError('session id');
    const bin = this.deps.bin();
    if (bin === null) throw new OpencodeImportError('opencode not found');
    const serve = await this.deps.serves.ensure(o.hangarSessionId, { directory: o.directory });
    const via = ['--server', serve.url];
    if (o.replace) {
      // 消せなかった（無い会話など）ときは、そのまま入れてみる。入らなければ下で exists になる。
      await this.cli(bin, ['session', 'delete', ...via, o.providerSessionId], serve.password);
    }
    const r = await this.cli(bin, ['session', 'import', ...via, '--directory', o.directory, o.file], serve.password);
    if (r.code !== 0) throw new OpencodeImportError(/LocationNotFound|Location not found/i.test(r.stderr) ? 'location' : r.code === null ? 'timeout' : `exit ${r.code}`);
    // 実物の 2.1.4 は、既にある ID には何もせずに 0 で終わる。中身が入れ替わっていないので失敗にする。
    if (/already exists/i.test(r.stderr)) throw new OpencodeImportError('exists');
    let directory: string | null;
    try {
      directory = (await new OpencodeClient(serve, { timeoutMs: this.deps.requestTimeoutMs ?? 10_000 }).session(o.providerSessionId)).directory;
    } catch {
      throw new OpencodeImportError('not found after import');
    }
    if (directory === null || !samePlace(directory, o.directory)) throw new OpencodeImportError('directory');
  }

  /**
   * 会話の作業を止めて、idle になるまで待つ。serve が無ければ何もしない（no-serve）。
   * 動いていなければ interrupt を送らずに idle。上限を過ぎたら timeout（呼び手は止めるのを続ける）。
   */
  async quiesce(hangarSessionId: string, providerSessionId: string, o: { timeoutMs?: number; pollMs?: number } = {}): Promise<'idle' | 'timeout' | 'no-serve'> {
    const serve = this.deps.serves.get(hangarSessionId);
    if (!serve) return 'no-serve';
    const client = new OpencodeClient(serve, { timeoutMs: this.deps.requestTimeoutMs ?? 5_000 });
    const deadline = Date.now() + (o.timeoutMs ?? QUIESCE_TIMEOUT_MS);
    const busy = async (): Promise<boolean> => {
      try { return (await client.active()).has(providerSessionId); } catch { return false; }
    };
    if (!(await busy())) return 'idle';
    await client.interrupt(providerSessionId).catch(() => undefined);
    for (;;) {
      if (!(await busy())) return 'idle';
      if (Date.now() >= deadline) return 'timeout';
      await this.sleep(o.pollMs ?? QUIESCE_POLL_MS);
    }
  }

  /** CLI を 1 回起こす。`database is locked` で落ちたら、serve の起動と同じ間をあけて起こし直す。 */
  private async cli(bin: string, argv: string[], password: string): Promise<CliResult> {
    const delays = this.deps.lockDelaysMs ?? LOCK_RETRY_DELAYS_MS;
    for (let i = 0; ; i++) {
      const r = await this.once(bin, argv, password);
      const delay = delays[i];
      if (r.code === 0 || !/database is locked/i.test(r.stderr) || delay === undefined) return r;
      await this.sleep(delay);
    }
  }

  private once(bin: string, argv: string[], password: string): Promise<CliResult> {
    const env: NodeJS.ProcessEnv = { ...opencodeProbeEnv(bin, this.deps.env ?? process.env, this.deps.platform ?? process.platform), OPENCODE_PASSWORD: password };
    return new Promise<CliResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const done = (r: CliResult): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
      const child = spawn(bin, argv, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref?.();
      child.stdout.on('data', (c: Buffer) => { if (stdout.length < OUT_CAP) stdout += c.toString('utf8'); });
      child.stderr.on('data', (c: Buffer) => { if (stderr.length < OUT_CAP) stderr += c.toString('utf8'); });
      child.on('error', (e: NodeJS.ErrnoException) => { done({ code: -1, stdout, stderr: e.code ?? 'spawn' }); });
      child.on('close', (code) => { done({ code, stdout, stderr }); });
    });
  }
}
