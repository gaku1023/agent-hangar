import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { PeerDeviceStatus } from '@agent-hangar/shared';
import { classifySshExit, isIpv4, keyscanArgs, knownHostsText, matchingHostKey, parseKeyscan, tunnelArgs, type SshFailure } from './command.ts';
import type { PeerSshEntry } from './config.ts';

/**
 * SSH の予備の経路のトンネル（計画の D3・D5）。
 *
 * 相手の PC の 127.0.0.1 で待つ hangar へ、`ssh -N -L` の子プロセスで手元の 127.0.0.1 の空きの口をつなぐ。
 * シェルのコマンドは打たない。
 * 宛先は同期の lan_ips を順に試し、ホスト鍵は同期の ssh_host_key で照合する（command.ts）。
 * 張れたかどうかは、トンネル越しに相手の `/peer/health` を PC どうしの token で叩いて確かめる（相手の device_id も確かめる）。
 * 切れは ServerAliveInterval で ssh が終わることで分かり、知らせる。張り直しは呼び手（T11）が行う。
 * 止めるのは、ここで起こした子プロセスだけである（ポートや名前で探して止めない）。
 */

export type SshChild = {
  pid?: number | undefined;
  stderr: NodeJS.ReadableStream | null;
  once(ev: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(): boolean;
};
export type SshSpawn = (file: string, args: string[]) => SshChild;
export type SshRun = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;
/** トンネル越しの確かめ。ok は相手の hangar が正しい token で応え、device_id も合った。refused は応えたが断った、または別の PC だった。down は応えない。 */
export type SshProbe = (baseUrl: string, deviceId: string) => Promise<'ok' | 'refused' | 'down'>;

/** 利用者へ知らせること。boot が画面の知らせ（toast）に換える。 */
export type SshPeerNotice =
  | { kind: 'host-key-mismatch'; deviceId: string; name: string }
  | { kind: 'tunnel-closed'; deviceId: string; name: string; detail: string }
  | { kind: 'gave-up'; deviceId: string; name: string };

/** 張れなかった理由。登録が無い、同期にホスト鍵が無いときは SSH を使わない（経路の選び方が別の経路か断るかを決める）。 */
export type SshConnectFailure = SshFailure | 'ssh-not-registered' | 'ssh-no-host-key';
export type SshConnectResult = { ok: true; tunnel: SshTunnel } | { ok: false; reason: SshConnectFailure; detail?: string };

/** 照合の様子。画面の「ほかの PC」に出す。 */
export type HostKeyState = 'ok' | 'mismatch' | 'unchecked';

export type SshConnectorDeps = {
  /** hangar のデータの置き場。この下の peer-ssh に専用の known_hosts を置く。 */
  home: string;
  platform: NodeJS.Platform;
  binaries: { ssh: string; keyscan: string };
  store: { get(deviceId: string): PeerSshEntry | null };
  /** 同期で届いたほかの PC の様子（config/deviceStatus.ts の readPeerStatuses）。 */
  peers: () => PeerDeviceStatus[];
  run: SshRun;
  spawn: SshSpawn;
  freePort: () => Promise<number>;
  probe: SshProbe;
  notify: (n: SshPeerNotice) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** トンネルが応えるまで待つ上限。 */
  readyTimeoutMs?: number;
};

const STDERR_CAP = 8 * 1024;
const PROBE_EVERY_MS = 250;
const KEYSCAN_TIMEOUT_MS = 8_000;

/** 張ったトンネル。close は自分が起こした ssh だけを止める。 */
export class SshTunnel {
  private closedBy: 'self' | 'exit' | null = null;
  private readonly listeners = new Set<(detail: string) => void>();

  constructor(
    readonly deviceId: string,
    readonly ip: string,
    readonly localPort: number,
    private readonly child: SshChild,
  ) {}

  /** トンネル越しの相手の hangar の入口。 */
  get baseUrl(): string { return `http://127.0.0.1:${this.localPort}`; }
  get pid(): number | undefined { return this.child.pid; }
  get closed(): boolean { return this.closedBy !== null; }

  /** 自分で閉じたのでなく切れたときに呼ぶ。戻り値で外す。 */
  onClose(cb: (detail: string) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  close(): void {
    if (this.closedBy) return;
    this.closedBy = 'self';
    try { this.child.kill(); } catch { /* もう終わっている */ }
  }

  /** ssh が終わった。自分で閉じたのでなければ、聞き手に知らせる。 */
  exited(detail: string): void {
    if (this.closedBy) return;
    this.closedBy = 'exit';
    for (const cb of this.listeners) { try { cb(detail); } catch { /* 聞き手の誤りは広げない */ } }
  }
}

export class SshPeerConnector {
  private readonly live = new Set<SshTunnel>();
  private readonly states = new Map<string, HostKeyState>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly d: SshConnectorDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => { setTimeout(r, ms); }));
    this.now = d.now ?? Date.now;
  }

  /** その PC の照合の様子。まだつないでいなければ unchecked。 */
  hostKeyState(deviceId: string): HostKeyState {
    return this.states.get(deviceId) ?? 'unchecked';
  }

  /** 専用の known_hosts の置き場。 */
  get dir(): string { return path.join(this.d.home, 'peer-ssh'); }

  /** 張っているトンネル。 */
  tunnels(): SshTunnel[] { return [...this.live]; }

  async connect(deviceId: string): Promise<SshConnectResult> {
    const entry = this.d.store.get(deviceId);
    if (!entry) return { ok: false, reason: 'ssh-not-registered' };
    const peer = this.d.peers().find((p) => p.device_id === deviceId);
    const fp = peer?.status?.ssh_host_key ?? null;
    if (!peer || !fp) return { ok: false, reason: 'ssh-no-host-key' };
    const ips = (peer.status?.lan_ips ?? []).filter(isIpv4);
    let mismatch = false;
    let last: { reason: SshFailure; detail: string } = { reason: 'ssh-unreachable', detail: 'network' };
    for (const ip of ips) {
      const scan = await this.d.run(this.d.binaries.keyscan, keyscanArgs({ ip, port: entry.sshPort }), KEYSCAN_TIMEOUT_MS).catch(() => null);
      const keys = scan ? parseKeyscan(scan.stdout) : [];
      if (keys.length === 0) continue;
      const key = matchingHostKey(keys, fp);
      if (!key) { mismatch = true; continue; }
      const r = await this.open(deviceId, ip, entry, key);
      if (r.ok) {
        this.states.set(deviceId, 'ok');
        const name = peer.name;
        r.tunnel.onClose((detail) => { this.d.notify({ kind: 'tunnel-closed', deviceId, name, detail }); });
        return r;
      }
      if (r.reason === 'ssh-host-key-mismatch') mismatch = true;
      last = { reason: r.reason, detail: r.detail };
    }
    if (mismatch) {
      this.states.set(deviceId, 'mismatch');
      this.d.notify({ kind: 'host-key-mismatch', deviceId, name: peer.name });
      return { ok: false, reason: 'ssh-host-key-mismatch' };
    }
    return { ok: false, reason: last.reason, detail: last.detail };
  }

  /** 張っているトンネルを全部閉じる（hangar の終了）。 */
  closeAll(): void {
    for (const t of this.live) t.close();
    this.live.clear();
  }

  private writeKnownHosts(deviceId: string, publicKey: string): { knownHosts: string; emptyKnownHosts: string } {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const knownHosts = path.join(this.dir, `known_hosts-${deviceId}`);
    const emptyKnownHosts = path.join(this.dir, 'empty_known_hosts');
    fs.writeFileSync(knownHosts, knownHostsText(deviceId, publicKey), { mode: 0o600 });
    fs.writeFileSync(emptyKnownHosts, '', { mode: 0o600 });
    return { knownHosts, emptyKnownHosts };
  }

  /** 1 つの IP へ張る。口の取り合いで落ちたときだけ、別の口で 1 度だけ張り直す。 */
  private async open(deviceId: string, ip: string, entry: PeerSshEntry, publicKey: string): Promise<{ ok: true; tunnel: SshTunnel } | { ok: false; reason: SshFailure; detail: 'host-key' | 'auth' | 'forward' | 'network' | 'timeout' | 'token' }> {
    const files = this.writeKnownHosts(deviceId, publicKey);
    for (let attempt = 0; attempt < 2; attempt++) {
      const localPort = await this.d.freePort();
      const child = this.d.spawn(this.d.binaries.ssh, tunnelArgs({ deviceId, ip, entry, localPort, ...files, platform: this.d.platform }));
      let stderr = '';
      child.stderr?.on('data', (b: Buffer | string) => { if (stderr.length < STDERR_CAP) stderr += String(b); });
      const tunnel = new SshTunnel(deviceId, ip, localPort, child);
      let exit: { code: number | null } | null = null;
      child.once('exit', (code) => {
        exit = { code };
        this.live.delete(tunnel);
        tunnel.exited(classifySshExit(code, stderr).detail);
      });
      this.live.add(tunnel);
      const deadline = this.now() + (this.d.readyTimeoutMs ?? 15_000);
      for (;;) {
        if (exit) {
          const c = classifySshExit((exit as { code: number | null }).code, stderr);
          if (c.detail === 'forward' && attempt === 0) break;
          return { ok: false, ...c };
        }
        const p = await this.d.probe(tunnel.baseUrl, deviceId);
        if (p === 'ok') return { ok: true, tunnel };
        if (p === 'refused') { tunnel.close(); this.live.delete(tunnel); return { ok: false, reason: 'ssh-unreachable', detail: 'token' }; }
        if (this.now() >= deadline) { tunnel.close(); this.live.delete(tunnel); return { ok: false, reason: 'ssh-unreachable', detail: 'timeout' }; }
        await this.sleep(PROBE_EVERY_MS);
      }
    }
    return { ok: false, reason: 'ssh-unreachable', detail: 'forward' };
  }
}

/** 実機の ssh の起こし方。窓を出さず、標準入出力は閉じて stderr だけを読む。 */
export const nodeSshSpawn: SshSpawn = (file, args) => nodeSpawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

/** 実機の ssh-keyscan の起こし方。上限の時間で止める。 */
export const nodeSshRun: SshRun = (file, args, timeoutMs) => new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  let child: ReturnType<typeof nodeSpawn>;
  try {
    child = nodeSpawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: timeoutMs });
  } catch {
    resolve({ code: null, stdout: '', stderr: '' });
    return;
  }
  child.stdout?.on('data', (b: Buffer) => { if (stdout.length < 64 * 1024) stdout += b.toString('utf8'); });
  child.stderr?.on('data', (b: Buffer) => { if (stderr.length < STDERR_CAP) stderr += b.toString('utf8'); });
  child.on('error', () => { resolve({ code: null, stdout, stderr }); });
  child.on('close', (code) => { resolve({ code, stdout, stderr }); });
});

/** 手元の 127.0.0.1 の空きの口。 */
export const freeLocalPort = (): Promise<number> => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    srv.close(() => { resolve(port); });
  });
});
