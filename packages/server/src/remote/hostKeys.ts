import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RemoteShellFailure } from '@agent-hangar/shared';
import { hostAlias, keyscanArgs, knownHostsText, matchingHostKey, parseKeyscan, sshBinaries } from './sshCommand.ts';

/**
 * hangar 専用の known_hosts（~/.agent-hangar/ssh/known_hosts）と、空の全体の known_hosts を用意する。
 * 相手の status に host_pubkey があればそれを書く。無ければ ssh-keyscan して、指紋が同期の ssh_host_key と合ったときだけ書く。
 */

export type HostKeyExec = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
export type HostKeyFs = {
  mkdirSync(p: string, o: { recursive: true; mode: number }): void;
  readFileSync(p: string): string;
  writeFileSync(p: string, data: string, o: { mode: number }): void;
  renameSync(a: string, b: string): void;
  chmodSync(p: string, mode: number): void;
};

export type HostKeyInput = {
  deviceId: string;
  /** 宛先（IPv4、または上書きの Host 名）。 */
  address: string;
  port: number;
  override: string | null;
  sshHostKey: string | null;
  hostPubkey: string | null;
  dir: string;
  platform: NodeJS.Platform;
};
export type HostKeyResult = { ok: true; knownHosts: string; emptyKnownHosts: string } | { ok: false; reason: Extract<RemoteShellFailure, 'no-sshd' | 'host-key'> };
export type HostKeyDeps = { exec?: HostKeyExec; fs?: HostKeyFs; now?: () => number; env?: NodeJS.ProcessEnv };

const defaultExec: HostKeyExec = (file, args, opts) => new Promise((resolve) => {
  execFile(file, args, { timeout: opts?.timeoutMs ?? 10000, windowsHide: true }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

const realFs: HostKeyFs = {
  mkdirSync: (p, o) => { fs.mkdirSync(p, o); },
  readFileSync: (p) => fs.readFileSync(p, 'utf8'),
  writeFileSync: (p, d, o) => { fs.writeFileSync(p, d, o); },
  renameSync: (a, b) => { fs.renameSync(a, b); },
  chmodSync: (p, m) => { fs.chmodSync(p, m); },
};

const KEY_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** host_pubkey は base64 だけでも `ssh-ed25519 <base64>` でも受ける。 */
function normalizeKey(k: string): string | null {
  const t = k.trim().replace(/^ssh-ed25519\s+/, '').split(/\s+/)[0] ?? '';
  return KEY_RE.test(t) ? t : null;
}

function atomicWrite(f: HostKeyFs, file: string, data: string, now: number): void {
  const tmp = `${file}.${process.pid}.${now}.tmp`;
  f.writeFileSync(tmp, data, { mode: 0o600 });
  f.chmodSync(tmp, 0o600);
  f.renameSync(tmp, file);
}

export async function ensureHostKeys(input: HostKeyInput, deps: HostKeyDeps = {}): Promise<HostKeyResult> {
  const exec = deps.exec ?? defaultExec;
  const f = deps.fs ?? realFs;
  const now = (deps.now ?? Date.now)();
  const bins = sshBinaries(input.platform, deps.env ?? process.env);

  let key = input.hostPubkey ? normalizeKey(input.hostPubkey) : null;
  if (!key) {
    if (!input.sshHostKey) return { ok: false, reason: 'no-sshd' };
    let host = input.address;
    let port = input.port;
    if (input.override) {
      const g = await exec(bins.ssh, ['-G', '--', input.override], { timeoutMs: 5000 });
      const h = /^hostname (\S+)$/m.exec(g.stdout)?.[1];
      const p = Number(/^port (\d+)$/m.exec(g.stdout)?.[1]);
      if (g.code !== 0 || !h || !HOST_RE.test(h) || !Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, reason: 'no-sshd' };
      host = h;
      port = p;
    }
    let args: string[];
    try {
      args = input.override ? ['-T', '5', '-t', 'ed25519', '-p', String(port), host] : keyscanArgs({ ip: host, port });
    } catch { return { ok: false, reason: 'no-sshd' }; }
    const scan = await exec(bins.keyscan, args, { timeoutMs: 10000 });
    const keys = parseKeyscan(scan.stdout);
    if (keys.length === 0) return { ok: false, reason: 'no-sshd' };
    key = matchingHostKey(keys, input.sshHostKey);
    if (!key) return { ok: false, reason: 'host-key' };
  }

  const knownHosts = path.join(input.dir, 'known_hosts');
  const emptyKnownHosts = path.join(input.dir, 'known_hosts.empty');
  f.mkdirSync(input.dir, { recursive: true, mode: 0o700 });
  let existing = '';
  try { existing = f.readFileSync(knownHosts); } catch { /* まだ無い */ }
  const alias = hostAlias(input.deviceId);
  const kept = existing.split('\n').filter((l) => l.trim() !== '' && l.split(/\s+/)[0] !== alias);
  atomicWrite(f, knownHosts, kept.map((l) => `${l}\n`).join('') + knownHostsText(input.deviceId, key), now);
  atomicWrite(f, emptyKnownHosts, '', now);
  return { ok: true, knownHosts, emptyKnownHosts };
}
