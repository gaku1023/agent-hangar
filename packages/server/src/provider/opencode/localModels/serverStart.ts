import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Language } from '@agent-hangar/shared';
import { findInDirs, splitPathEnv } from '../../../platform/exec.ts';
import { defaultLanguage } from '../../../i18n/language.ts';
import { errorText, MessageError, msg } from '../../../i18n/message.ts';
import { LaunchPrepCancelled, type LaunchPrep } from '../../../runs/launchPrep.ts';
import { opencodeBaseEnv } from '../serve/env.ts';

type Provider = { id: string; baseURL: string | null };
type Command = (bin: string, args: string[], signal: AbortSignal) => Promise<void>;
type Job = { controller: AbortController; promise: Promise<void>; users: number };
type Deps = { find?: () => string | null; run?: Command; fetch?: typeof fetch; timeoutMs?: number; pollMs?: number; language?: () => Language };

/** 停止中には API から製品を判定できないので、明示された lmstudio だけを扱う。 */
function targetOf(p: Provider): URL | null {
  if (p.id !== 'lmstudio' || !p.baseURL) return null;
  try {
    const u = new URL(p.baseURL);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
      && !u.username && !u.password && !u.search && !u.hash && /^\/v1\/?$/.test(u.pathname) ? u : null;
  } catch { return null; }
}

/** Finder 起動でも標準の CLI を見つける。シェルの設定は実行しない。 */
export function findLms(): string | null {
  const found = findInDirs('lms', [path.join(os.homedir(), '.lmstudio', 'bin'), ...splitPathEnv(process.env.PATH ?? process.env.Path)]);
  // .cmd/.bat はシェルを要する。自動起動では公式の実行ファイルだけを使う。
  return found && !/\.(cmd|bat)$/i.test(found) ? found : null;
}

/** CLI には API キーや HANGAR_* を継がせず、アプリのウィンドウも開かない。 */
export const runLms: Command = (bin, args, signal) => new Promise<void>((resolve, reject) => {
  execFile(bin, args, { signal, killSignal: 'SIGKILL', windowsHide: true, cwd: os.homedir(), env: opencodeBaseEnv(bin), maxBuffer: 64 * 1024 }, (error) => {
    if (error) reject(error); else resolve();
  });
});

/** 会話が必要とするときだけ API サーバーを起こす。同時起動は共有し、終了時にはサーバーを止めない。 */
export class LmServerStarter {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly deps: Deps = {}) {}

  async ensure(provider: Provider, prep: LaunchPrep): Promise<void> {
    const url = targetOf(provider);
    if (!url) return;
    prep.throwIfCancelled();
    const initial = await this.probe(url, prep.signal);
    prep.throwIfCancelled();
    // 401 や別 API の応答も「起動済み」。既存サービスを起こし直さない。
    if (initial !== 'down') return;
    const step = prep.step('local-server', 'LM Studio', 'server-start');
    let job = this.jobs.get(url.origin);
    if (!job) {
      const controller = new AbortController();
      job = { controller, users: 0, promise: this.start(url, controller.signal) };
      this.jobs.set(url.origin, job);
      const current = job;
      void job.promise.finally(() => { if (this.jobs.get(url.origin) === current) this.jobs.delete(url.origin); }).catch(() => {});
    }
    job.users++;
    try {
      await waitFor(job.promise, prep.signal);
      prep.throwIfCancelled();
      step.done();
    } catch (e) {
      if (prep.signal.aborted) { step.skip(); throw new LaunchPrepCancelled(); }
      const error = e instanceof MessageError ? e : new MessageError(msg('launchPrep.server.failed', { url: url.origin }));
      step.fail(errorText((this.deps.language ?? defaultLanguage)(), error));
      throw error;
    } finally {
      job.users--;
      if (!job.users) {
        if (this.jobs.get(url.origin) === job) this.jobs.delete(url.origin);
        job.controller.abort();
      }
    }
  }

  private async start(url: URL, cancelled: AbortSignal): Promise<void> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.deps.timeoutMs ?? 30_000);
    timer.unref();
    const signal = AbortSignal.any([cancelled, timeout.signal]);
    try {
      const bin = (this.deps.find ?? findLms)();
      if (!bin) throw new MessageError(msg('launchPrep.server.cliMissing'));
      const run = this.deps.run ?? runLms;
      signal.throwIfAborted();
      await run(bin, ['daemon', 'up'], signal);
      signal.throwIfAborted();
      const bind = url.hostname === '[::1]' ? '::1' : '127.0.0.1';
      await run(bin, ['server', 'start', '--port', url.port || '80', '--bind', bind], signal);
      for (;;) {
        signal.throwIfAborted();
        if (await this.probe(url, signal) === 'ready') return;
        await delay(this.deps.pollMs ?? 250, undefined, { signal });
      }
    } finally { clearTimeout(timer); }
  }

  private async probe(url: URL, signal: AbortSignal): Promise<'down' | 'ready' | 'other'> {
    try {
      const response = await (this.deps.fetch ?? fetch)(`${url.origin}/api/v1/models`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: 'error' });
      if (!response.ok) return 'other';
      const data: unknown = await response.json().catch(() => null);
      return data && typeof data === 'object' && 'models' in data && Array.isArray(data.models) ? 'ready' : 'other';
    } catch {
      signal.throwIfAborted();
      return 'down';
    }
  }
}

/** 一人の取消を共有している別の起動に伝えない。リスナーは成功・失敗でも外す。 */
function waitFor(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new LaunchPrepCancelled());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
