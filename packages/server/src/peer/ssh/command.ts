import fs from 'node:fs';
import path from 'node:path';
import { fingerprintOfPublicKey } from '../../config/deviceStatus.ts';
import type { PeerSshEntry } from './config.ts';

/**
 * OS の ssh と ssh-keyscan に渡す引数と、その出力の読み方。
 *
 * ホスト鍵の照合の流れ。
 * 同期に載るのはホスト鍵の指紋（SHA256:...）だけで、known_hosts には公開鍵そのものが要る。
 * そこで、まず ssh-keyscan で相手の ed25519 の公開鍵を取り、その指紋が同期の値と同じときだけ、hangar 専用の known_hosts に書く。
 * 書く名前は IP ではなく PC ごとの別名（HostKeyAlias）なので、IP が変わっても同じ行で照合できる。
 * そのうえで ssh を StrictHostKeyChecking=yes で起こすので、鍵を取ってから接続するまでの間に相手がすり替わっても、ssh が断る。
 * 利用者の ~/.ssh/config と known_hosts は読まない（-F none、専用の known_hosts、空の全体の known_hosts）。
 *
 * 出力の判定は、終了コードと、-v 無しでも必ず出る決まった 1 行（Host key verification failed.）だけを使う。
 */

/** 指紋の食い違い、または届かない。ok は照合に通ったこと。 */
export type SshFailure = 'ssh-host-key-mismatch' | 'ssh-unreachable';

/** ssh と ssh-keyscan の場所。Windows は OpenSSH for Windows の決まった場所、ほかは /usr/bin を先に見る。無ければ PATH に任せる。 */
export function sshBinaries(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (f: string) => boolean = (f) => fs.existsSync(f)): { ssh: string; keyscan: string } {
  if (platform === 'win32') {
    const dir = path.win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'OpenSSH');
    const ssh = path.win32.join(dir, 'ssh.exe');
    const keyscan = path.win32.join(dir, 'ssh-keyscan.exe');
    return { ssh: exists(ssh) ? ssh : 'ssh.exe', keyscan: exists(keyscan) ? keyscan : 'ssh-keyscan.exe' };
  }
  return { ssh: exists('/usr/bin/ssh') ? '/usr/bin/ssh' : 'ssh', keyscan: exists('/usr/bin/ssh-keyscan') ? '/usr/bin/ssh-keyscan' : 'ssh-keyscan' };
}

/**
 * `-o 名前=値` の値に入れるパス。
 * ssh は -o の値を設定ファイルの 1 行と同じく読み、空白で区切る。空白を含むときは二重引用符で包む。
 * Windows の \ は / にする（OpenSSH for Windows は / を受ける）。
 * % を展開する項目（UserKnownHostsFile）では % を %% にする。GlobalKnownHostsFile は展開しないので、そのまま渡す（ssh -G で確かめた）。
 */
export function sshOptionPath(p: string, platform: NodeJS.Platform, expandsTokens = true): string {
  if (/["\r\n\0]/.test(p)) throw new Error('path cannot be passed to ssh');
  const slashed = platform === 'win32' ? p.replace(/\\/g, '/') : p;
  const v = expandsTokens ? slashed.replace(/%/g, '%%') : slashed;
  return /\s/.test(v) ? `"${v}"` : v;
}


/** known_hosts に書く、PC ごとの別名。 */
export const hostAlias = (deviceId: string): string => `hangar-peer-${deviceId}`;

/** 同期の lan_ips の 1 つとして使ってよい値か。IPv4 の 4 つの数字だけを通す（ssh の引数に入るため）。 */
export function isIpv4(ip: string): boolean {
  const p = ip.split('.');
  return p.length === 4 && p.every((n) => /^(0|[1-9]\d{0,2})$/.test(n) && Number(n) <= 255);
}

/** ssh-keyscan の引数。ed25519 だけを、短い待ちで取る。 */
export function keyscanArgs(o: { ip: string; port: number; timeoutSec?: number }): string[] {
  if (!isIpv4(o.ip)) throw new Error('not an IPv4 address');
  return ['-T', String(o.timeoutSec ?? 5), '-t', 'ed25519', '-p', String(o.port), o.ip];
}

/** ssh-keyscan の出力から ed25519 の公開鍵（base64）を取る。注釈の行と別の種類は読み捨てる。 */
export function parseKeyscan(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\S+\s+ssh-ed25519\s+([A-Za-z0-9+/]+={0,2})\s*$/.exec(line.trim());
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** 取れた公開鍵のうち、指紋が同期の値と同じもの。無ければ null。 */
export function matchingHostKey(keys: string[], fingerprint: string): string | null {
  return keys.find((k) => fingerprintOfPublicKey(`ssh-ed25519 ${k}`) === fingerprint) ?? null;
}

/** hangar 専用の known_hosts の中身（その PC の 1 行だけ）。 */
export function knownHostsText(deviceId: string, publicKey: string): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) throw new Error('bad public key');
  return `${hostAlias(deviceId)} ssh-ed25519 ${publicKey}\n`;
}

/** 接続の間、切れを見張る間隔（秒）と回数。15 秒おきに 3 回応答が無ければ ssh が終わる。 */
export const SERVER_ALIVE_INTERVAL_SEC = 15;
export const SERVER_ALIVE_COUNT_MAX = 3;
export const CONNECT_TIMEOUT_SEC = 10;

/**
 * トンネルを張る ssh の引数。
 * -N でシェルのコマンドを打たず、-L で手元の 127.0.0.1 の口を相手の 127.0.0.1 の hangar へつなぐ。
 * 利用者の ~/.ssh/config は読まない（-F none）。多重化、代理、エージェントの転送も使わない。
 */
export function tunnelArgs(o: {
  deviceId: string;
  ip: string;
  entry: PeerSshEntry;
  localPort: number;
  knownHosts: string;
  emptyKnownHosts: string;
  platform: NodeJS.Platform;
}): string[] {
  if (!isIpv4(o.ip)) throw new Error('not an IPv4 address');
  const opt = (name: string, value: string): string[] => ['-o', `${name}=${value}`];
  return [
    '-N', '-T',
    '-F', 'none',
    ...opt('BatchMode', 'yes'),
    ...opt('StrictHostKeyChecking', 'yes'),
    ...opt('UserKnownHostsFile', sshOptionPath(o.knownHosts, o.platform)),
    ...opt('GlobalKnownHostsFile', sshOptionPath(o.emptyKnownHosts, o.platform, false)),
    ...opt('HostKeyAlgorithms', 'ssh-ed25519'),
    ...opt('HostKeyAlias', hostAlias(o.deviceId)),
    ...opt('CheckHostIP', 'no'),
    ...opt('UpdateHostKeys', 'no'),
    ...opt('IdentitiesOnly', 'yes'),
    ...opt('ExitOnForwardFailure', 'yes'),
    ...opt('ServerAliveInterval', String(SERVER_ALIVE_INTERVAL_SEC)),
    ...opt('ServerAliveCountMax', String(SERVER_ALIVE_COUNT_MAX)),
    ...opt('ConnectTimeout', String(CONNECT_TIMEOUT_SEC)),
    ...opt('ControlMaster', 'no'),
    ...opt('ControlPath', 'none'),
    ...opt('ForwardAgent', 'no'),
    ...opt('PermitLocalCommand', 'no'),
    // 鍵は -i でなく -o IdentityFile で渡す。-i は渡したままの字でファイルの有無を見てから後で % を展開するので、% を含むパスを正しく渡せない（ssh -G で確かめた）。
    ...opt('IdentityFile', sshOptionPath(o.entry.keyPath, o.platform)),
    '-l', o.entry.user,
    '-p', String(o.entry.sshPort),
    '-L', `127.0.0.1:${o.localPort}:127.0.0.1:${o.entry.hangarPort}`,
    o.ip,
  ];
}

/** ssh が終わったときの読み方。ホスト鍵の照合に落ちたときだけ mismatch、ほかは届かない。detail は画面の手掛かり。 */
export function classifySshExit(code: number | null, stderr: string): { reason: SshFailure; detail: 'host-key' | 'auth' | 'forward' | 'network' } {
  if (stderr.includes('Host key verification failed')) return { reason: 'ssh-host-key-mismatch', detail: 'host-key' };
  if (code === 255 && /Permission denied/.test(stderr)) return { reason: 'ssh-unreachable', detail: 'auth' };
  if (/forwarding failed|Could not request local forwarding|cannot listen to port/i.test(stderr)) return { reason: 'ssh-unreachable', detail: 'forward' };
  return { reason: 'ssh-unreachable', detail: 'network' };
}
