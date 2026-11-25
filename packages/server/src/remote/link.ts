import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceStatus, RemoteShellFailure, RemoteShellKind, RemoteShellStatusMsg } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import type { PtyProcess, PtySpawn } from '../pty/relay.ts';
import { createAddressBook, resolveAddresses, type AddressProbe } from './addresses.ts';
import { ensureHostKeys, type HostKeyInput, type HostKeyResult } from './hostKeys.ts';
import { cdArgv, classifySshFailure, closeArgv, hasSessionArgv, parsePrepareMark, prepareArgv, RemoteCommandError, shellArgv, sshBinaries, type RemoteSpec, type SshTarget } from './sshCommand.ts';
import { listPendingKills, markKillDone, setKillPending } from './store.ts';

/**
 * 別 PC のシェルタブの 1 本のつなぎ（docs/design.md「SSH のシェルタブ」）。
 * 住所を決め、ホスト鍵を用意し、tty なしの準備の ssh で相手の mux のセッションを作ってから、本番の ssh を pty で起こす。
 * 切れたら 1、2、4、8、16 秒の間を置いて最初から 5 回やり直し、だめなら failed（dropped）にして retry() を待つ。
 * 閉じたら別の ssh で kill-session を 1 回打ち、届かなければ kill_pending を立てて、次にその PC へつながったときに消す。
 */

export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];
const PREPARE_TIMEOUT_MS = 20_000;
const SIDE_TIMEOUT_MS = 15_000;
const TAIL_MAX = 4096;

export type LinkExec = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
export type LinkTimers = { now(): number; set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
export type AddressBook = ReturnType<typeof createAddressBook>;

/** 呼び出し側が渡すもの。status は devices.status（無ければ null で outdated）、override は getRemoteHost、cwd は会話の cwd。 */
export type RemoteShellLinkOptions = {
  tabId: string;
  deviceId: string;
  /** devices.platform。status に ssh の欄が無い古めの相手のシェルを決める。 */
  peerPlatform: string;
  status: DeviceStatus | null;
  override: string | null;
  cwd: string;
  cols: number;
  rows: number;
  onStatus(m: RemoteShellStatusMsg): void;
  onData(d: string): void;
  /** 相手のシェルが 0 で終わり、セッションも無かった（利用者が exit した）。やり直さない。 */
  onEnded?(): void;
};

export type RemoteShellLinkDeps = {
  db: Db;
  spawn: PtySpawn;
  addressBook: AddressBook;
  exec?: LinkExec;
  timers?: LinkTimers;
  probe?: AddressProbe;
  hostKeys?: (i: HostKeyInput) => Promise<HostKeyResult>;
  /** 手元に ssh があるか。 */
  hasClient?: () => boolean;
  /** 手元の OS。 */
  platform?: NodeJS.Platform;
  /** hangar 専用の known_hosts の置き場（既定は ~/.agent-hangar/ssh）。 */
  sshDir?: string;
  env?: NodeJS.ProcessEnv;
};

type Attempt = { ok: true } | { ok: false; reason: RemoteShellFailure; detail?: string; fatal: boolean };

const defaultExec: LinkExec = (file, args, opts) => new Promise((resolve) => {
  execFile(file, args, { timeout: opts?.timeoutMs ?? SIDE_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
    const c = (err as { code?: unknown } | null)?.code;
    resolve({ code: err ? (typeof c === 'number' ? c : 255) : 0, stdout: String(stdout), stderr: String(stderr) });
  });
});

const realTimers: LinkTimers = { now: () => Date.now(), set: (fn, ms) => setTimeout(fn, ms), clear: (h) => { clearTimeout(h as NodeJS.Timeout); } };

/** ssh が手元にあるか。決まった場所に無ければ PATH を探す。 */
export function sshClientAvailable(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  const { ssh } = sshBinaries(platform, env);
  if (path.isAbsolute(ssh)) return fs.existsSync(ssh);
  const sep = platform === 'win32' ? ';' : ':';
  return (env.PATH ?? env.Path ?? '').split(sep).some((d) => d !== '' && fs.existsSync(path.join(d, ssh)));
}

/** ssh 自体が届かなかった終わり方か。ssh は自分の失敗を 255 で返し、それ以外は相手のコマンドの終了コードを返す。 */
const reached = (code: number): boolean => code !== 255;
const lastLine = (s: string): string => s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '').at(-1) ?? '';
const FATAL: ReadonlySet<RemoteShellFailure> = new Set(['auth', 'host-key', 'bad-cwd', 'no-mux', 'no-client', 'outdated']);

export class RemoteShellLink {
  private readonly exec: LinkExec;
  private readonly timers: LinkTimers;
  private readonly platform: NodeJS.Platform;
  private readonly sshDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly ssh: string;
  private gen = 0;
  private pty: PtyProcess | null = null;
  private timer: unknown = null;
  private retries = 0;
  private target: SshTarget | null = null;
  private closed = false;
  private busy: Promise<void> = Promise.resolve();
  private kills: Promise<void> = Promise.resolve();

  constructor(private readonly opts: RemoteShellLinkOptions, private readonly deps: RemoteShellLinkDeps) {
    this.exec = deps.exec ?? defaultExec;
    this.timers = deps.timers ?? realTimers;
    this.platform = deps.platform ?? process.platform;
    this.env = deps.env ?? process.env;
    this.sshDir = deps.sshDir ?? path.join(os.homedir(), '.agent-hangar', 'ssh');
    this.ssh = sshBinaries(this.platform, this.env).ssh;
  }

  /** 最初のつなぎ。ready か failed になるまでを待てる。 */
  start(): Promise<void> { return this.begin(); }

  /** failed のあと（またはいつでも）最初からやり直す。 */
  retry(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.stopChild();
    return this.begin();
  }

  /** いま走っているつなぎと後始末が終わるまで待つ（試験と呼び出し側の待ち合わせ用）。 */
  async whenIdle(): Promise<void> {
    let b: Promise<void>;
    let k: Promise<void>;
    do { b = this.busy; k = this.kills; await b; await k; } while (b !== this.busy || k !== this.kills);
  }

  write(d: string): void { this.pty?.write(d); }

  resize(cols: number, rows: number): void {
    this.opts.cols = cols;
    this.opts.rows = rows;
    this.pty?.resize(cols, rows);
  }

  /** ssh の子を止め、相手のセッションを kill-session で消す。届かなければ kill_pending を立てる。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopChild();
    const spec = this.specFor(this.opts.tabId);
    const t = this.target;
    let ok = false;
    if (t) {
      try {
        const r = await this.exec(this.ssh, closeArgv(t, spec), { timeoutMs: SIDE_TIMEOUT_MS });
        ok = reached(r.code);
      } catch { ok = false; }
    }
    if (!ok) setKillPending(this.deps.db, this.opts.tabId, true);
  }

  /** 画面の WS が閉じた。ssh の子だけを止め、相手のセッションは残す。この link はもう使わない。 */
  detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopChild();
  }

  /**
   * つないでいない link でタブを閉じる（どの画面も開いていないタブの DELETE）。
   * 本番の ssh は起こさず、住所と鍵だけを用意して kill-session を打つ。宛先が決まらなければ kill_pending を立てる。
   */
  async closeUnattached(): Promise<void> {
    if (this.closed) return;
    if (!this.target) this.target = await this.findTarget().catch(() => null);
    await this.close();
  }

  private async findTarget(): Promise<SshTarget | null> {
    const st = this.opts.status;
    if (!st) return null;
    if (!(this.deps.hasClient ?? (() => sshClientAvailable(this.platform, this.env)))()) return null;
    const lastGood = this.deps.addressBook.get(this.opts.deviceId);
    const res = await resolveAddresses({ lan_ips: st.lan_ips, tailnet_ips: st.tailnet_ips ?? [], override: this.opts.override, ...(lastGood ? { lastGood } : {}) }, this.deps.probe ? { probe: this.deps.probe } : {});
    if (!res.ok) return null;
    for (const address of res.addresses) {
      const t = await this.targetFor(address);
      if (t.ok) return t.target;
    }
    return null;
  }

  /** その住所の鍵を用意して、ssh の宛先を組む。 */
  private async targetFor(address: string): Promise<{ ok: true; target: SshTarget } | { ok: false; reason: 'no-sshd' | 'host-key' }> {
    const st = this.opts.status!;
    const keys = await (this.deps.hostKeys ?? ensureHostKeys)({
      deviceId: this.opts.deviceId, address, port: 22, override: this.opts.override, sshHostKey: st.ssh_host_key, hostPubkey: st.ssh?.host_pubkey ?? null, dir: this.sshDir, platform: this.platform,
    });
    if (!keys.ok) return { ok: false, reason: keys.reason };
    return { ok: true, target: { deviceId: this.opts.deviceId, host: address, user: this.opts.override ? null : (st.ssh?.user ?? null), knownHosts: keys.knownHosts, emptyKnownHosts: keys.emptyKnownHosts, platform: this.platform } };
  }

  private begin(): Promise<void> {
    this.retries = 0;
    const g = ++this.gen;
    this.emit({ t: 'remote', phase: 'connecting' });
    const run = this.connectOnce(g).then((a) => {
      if (g !== this.gen || this.closed || a.ok) return;
      this.emit({ t: 'remote', phase: 'failed', reason: a.reason, ...(a.detail ? { detail: a.detail } : {}) });
    });
    this.busy = run;
    return run;
  }

  private emit(m: RemoteShellStatusMsg): void { if (!this.closed) this.opts.onStatus(m); }

  private stopChild(): void {
    this.gen++;
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    const p = this.pty;
    this.pty = null;
    if (p) { try { p.kill(); } catch { /* 既に終わっている */ } }
  }

  private shellKind(): RemoteShellKind {
    return this.opts.status?.ssh?.shell ?? (this.opts.peerPlatform === 'win32' ? 'powershell' : 'posix');
  }

  private specFor(tabId: string): RemoteSpec {
    return { shell: this.shellKind(), mux: this.opts.status?.ssh?.mux ?? null, tabId, cwd: this.opts.cwd };
  }

  /** 住所を決めてから、住所ごとに鍵・準備・本番を試す。 */
  private async connectOnce(g: number): Promise<Attempt> {
    const st = this.opts.status;
    if (!st) return { ok: false, reason: 'outdated', fatal: true };
    if (!(this.deps.hasClient ?? (() => sshClientAvailable(this.platform, this.env)))()) return { ok: false, reason: 'no-client', fatal: true };
    const spec = this.specFor(this.opts.tabId);
    try { prepareArgv({ deviceId: 'x', host: 'x', user: null, knownHosts: 'x', emptyKnownHosts: 'x', platform: this.platform }, spec); } catch (e) {
      if (e instanceof RemoteCommandError) return { ok: false, reason: e.reason, fatal: true };
      throw e;
    }
    const lastGood = this.deps.addressBook.get(this.opts.deviceId);
    const res = await resolveAddresses({ lan_ips: st.lan_ips, tailnet_ips: st.tailnet_ips ?? [], override: this.opts.override, ...(lastGood ? { lastGood } : {}) }, this.deps.probe ? { probe: this.deps.probe } : {});
    if (g !== this.gen) return { ok: true };
    if (!res.ok) return { ok: false, reason: 'unreachable', fatal: false };
    let last: Attempt = { ok: false, reason: 'unreachable', fatal: false };
    for (const address of res.addresses) {
      const a = await this.tryAddress(g, address, spec);
      if (g !== this.gen) return { ok: true };
      if (a.ok || a.fatal) return a;
      last = a;
    }
    return last;
  }

  private async tryAddress(g: number, address: string, spec: RemoteSpec): Promise<Attempt> {
    const t = await this.targetFor(address);
    if (!t.ok) return { ok: false, reason: t.reason, fatal: t.reason === 'host-key' };
    const { target } = t;
    let prepArgs: string[];
    try { prepArgs = prepareArgv(target, spec); } catch { return { ok: false, reason: 'unreachable', fatal: false }; }
    const prep = await this.exec(this.ssh, prepArgs, { timeoutMs: PREPARE_TIMEOUT_MS });
    if (g !== this.gen) return { ok: true };
    if (prep.code !== 0) {
      if (prep.code === 70) return { ok: false, reason: 'no-mux', detail: lastLine(prep.stderr), fatal: true };
      const c = classifySshFailure(prep.code, prep.stderr);
      return { ok: false, reason: c.reason, ...(c.detail ? { detail: c.detail } : {}), fatal: FATAL.has(c.reason) };
    }
    const mark = parsePrepareMark(prep.stdout);
    if (!mark) return { ok: false, reason: 'no-mux', detail: lastLine(prep.stderr) || lastLine(prep.stdout), fatal: true };
    if (mark.created && !mark.cwdMatches) {
      try { await this.exec(this.ssh, cdArgv(target, spec), { timeoutMs: SIDE_TIMEOUT_MS }); } catch { /* 場所の保険が届かなくても本番へ進む */ }
      if (g !== this.gen) return { ok: true };
    }
    this.target = target;
    if (!this.opts.override) this.deps.addressBook.set(this.opts.deviceId, address);
    this.spawnShell(g, target, spec, address);
    this.kills = this.killPending(target);
    return { ok: true };
  }

  private spawnShell(g: number, target: SshTarget, spec: RemoteSpec, address: string): void {
    const p = this.deps.spawn(this.ssh, shellArgv(target, spec), { name: 'xterm-256color', cols: this.opts.cols, rows: this.opts.rows, cwd: os.homedir(), env: this.env });
    this.pty = p;
    let tail = '';
    p.onData((d) => {
      if (g !== this.gen || this.closed) return;
      tail = (tail + d).slice(-TAIL_MAX);
      this.opts.onData(d);
    });
    p.onExit(({ exitCode }) => {
      if (g !== this.gen || this.closed) return;
      this.pty = null;
      if (exitCode === 0) { void this.afterCleanExit(g, target, spec); return; }
      const c = classifySshFailure(exitCode, tail);
      if (c.reason === 'auth' || c.reason === 'host-key') { this.emit({ t: 'remote', phase: 'failed', reason: c.reason, ...(c.detail ? { detail: c.detail } : {}) }); return; }
      this.retries = 0;
      this.scheduleRetry(c.reason, c.detail);
    });
    this.retries = 0;
    this.emit({ t: 'remote', phase: 'ready', address });
  }

  /**
   * 本番の ssh が 0 で終わった。シェルの exit なら相手のセッションは無く、tmux の detach なら残っている。
   * 別の ssh（tty なし）で有無を見て、残っていれば閉じずにすぐつなぎ直す。届かなければ dropped と同じ道。
   */
  private async afterCleanExit(g: number, target: SshTarget, spec: RemoteSpec): Promise<void> {
    let code = 255;
    try { code = (await this.exec(this.ssh, hasSessionArgv(target, spec), { timeoutMs: SIDE_TIMEOUT_MS })).code; } catch { code = 255; }
    if (g !== this.gen || this.closed) return;
    if (code === 0 || code === 255) { this.retries = 0; this.scheduleRetry('dropped', '', 0); return; }
    this.opts.onEnded?.();
  }

  /** 切れた後のやり直しの 1 回を予約する。5 回使い切ったら failed（dropped）。firstDelay は 1 回目だけの間の上書き。 */
  private scheduleRetry(reason: RemoteShellFailure, detail: string, firstDelay?: number): void {
    if (this.retries >= RETRY_DELAYS_MS.length) {
      this.emit({ t: 'remote', phase: 'failed', reason: 'dropped', ...(detail ? { detail } : {}) });
      return;
    }
    const delay = this.retries === 0 && firstDelay !== undefined ? firstDelay : RETRY_DELAYS_MS[this.retries]!;
    this.retries += 1;
    const attempt = this.retries;
    this.emit({ t: 'remote', phase: 'retrying', attempt, retryAt: this.timers.now() + delay, reason, ...(detail ? { detail } : {}) });
    const g = ++this.gen;
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (g !== this.gen || this.closed) return;
      const run = this.connectOnce(g).then((a) => {
        if (g !== this.gen || this.closed || a.ok) return;
        if (a.fatal) { this.emit({ t: 'remote', phase: 'failed', reason: a.reason, ...(a.detail ? { detail: a.detail } : {}) }); return; }
        this.scheduleRetry(a.reason, a.detail ?? detail);
      });
      this.busy = run;
    }, delay);
  }

  /** 前に閉じて届かなかった、この PC のタブの相手のセッションを消す。 */
  private async killPending(target: SshTarget): Promise<void> {
    for (const row of listPendingKills(this.deps.db, this.opts.deviceId)) {
      if (row.id === this.opts.tabId) continue;
      const spec = this.specFor(row.id);
      try {
        const r = await this.exec(this.ssh, closeArgv(target, spec), { timeoutMs: SIDE_TIMEOUT_MS });
        if (reached(r.code)) markKillDone(this.deps.db, row.id);
      } catch { /* 次の機会に */ }
    }
  }
}
