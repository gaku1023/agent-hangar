import fs from 'node:fs';
import path from 'node:path';
import { fingerprintOfPublicKey } from '../config/deviceStatus.ts';

/**
 * 別 PC のシェルタブのための、OS の ssh と ssh-keyscan に渡す引数と、その出力の読み方。純粋な関数だけを置く。
 *
 * 利用者の ~/.ssh/config は読む（-F none も IdentityFile の指定も使わない）。
 * ホスト鍵だけは hangar 専用の known_hosts で照合し、全体の known_hosts は空にする。
 * ssh の -o の組と、相手の PC で動かすコマンドの引用（PowerShell と POSIX）がここにある。
 * どの argv にも kill-server は入れない。相手の tmux・psmux のサーバには hangar 本体も載っているため。
 */

// TODO: packages/shared に RemoteShellFailure の型ができたら、この定義を import に差し替える。
export type RemoteShellFailure = 'no-sshd' | 'unreachable' | 'auth' | 'host-key' | 'no-mux' | 'no-client' | 'outdated' | 'dropped' | 'bad-cwd';

export type RemoteShellKind = 'posix' | 'powershell' | 'pwsh' | 'cmd';
export interface RemoteMux { kind: string; path: string }

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
 * % を展開する項目（UserKnownHostsFile）では % を %% にする。GlobalKnownHostsFile は展開しないので、そのまま渡す。
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

export const SERVER_ALIVE_INTERVAL_SEC = 15;
export const SERVER_ALIVE_COUNT_MAX = 3;
export const CONNECT_TIMEOUT_SEC = 8;

/** ssh の宛先と照合の設定。user が null のときは -l を付けず、~/.ssh/config の User に任せる（上書きの Host 名のとき）。 */
export interface SshTarget {
  deviceId: string;
  host: string;
  user: string | null;
  port?: number;
  knownHosts: string;
  emptyKnownHosts: string;
  platform: NodeJS.Platform;
}

/** 相手で動かすものの指定。tabId は hangar-ssh-<tabId> のセッション名になる。 */
export interface RemoteSpec {
  shell: RemoteShellKind;
  mux: RemoteMux | null;
  tabId: string;
  cwd: string;
}

export const remoteSessionName = (tabId: string): string => `hangar-ssh-${tabId}`;

export class RemoteCommandError extends Error {
  readonly reason: RemoteShellFailure;
  constructor(reason: RemoteShellFailure) {
    super(reason);
    this.reason = reason;
  }
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const pq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function checkSpec(spec: RemoteSpec): void {
  if (!/^[A-Za-z0-9_-]+$/.test(spec.tabId)) throw new Error('bad tab id');
  if (spec.cwd === '' || /[\x00-\x1f\x7f]/.test(spec.cwd)) throw new RemoteCommandError('bad-cwd');
  if (spec.shell === 'cmd' && /["%]/.test(spec.cwd)) throw new RemoteCommandError('bad-cwd');
  if (spec.mux && /[\x00-\x1f\x7f]/.test(spec.mux.path)) throw new Error('bad mux path');
  if (spec.mux && spec.shell === 'cmd' && /["%]/.test(spec.mux.path)) throw new Error('bad mux path');
}

const isWindowsShell = (s: RemoteShellKind): boolean => s !== 'posix';

/** `-o` の共通の組。-F と IdentityFile は使わない。 */
function commonOptions(t: SshTarget): string[] {
  const opt = (name: string, value: string): string[] => ['-o', `${name}=${value}`];
  return [
    ...opt('BatchMode', 'yes'),
    ...opt('StrictHostKeyChecking', 'yes'),
    ...opt('UserKnownHostsFile', sshOptionPath(t.knownHosts, t.platform)),
    ...opt('GlobalKnownHostsFile', sshOptionPath(t.emptyKnownHosts, t.platform, false)),
    ...opt('HostKeyAlgorithms', 'ssh-ed25519'),
    ...opt('HostKeyAlias', hostAlias(t.deviceId)),
    ...opt('CheckHostIP', 'no'),
    ...opt('UpdateHostKeys', 'no'),
    ...opt('ConnectTimeout', String(CONNECT_TIMEOUT_SEC)),
    ...opt('ServerAliveInterval', String(SERVER_ALIVE_INTERVAL_SEC)),
    ...opt('ServerAliveCountMax', String(SERVER_ALIVE_COUNT_MAX)),
    ...opt('ControlMaster', 'no'),
  ];
}

function sshArgv(tty: '-tt' | '-T', t: SshTarget, command: string): string[] {
  if (/[\s\0]/.test(t.host) || t.host.startsWith('-')) throw new Error('bad host');
  if (t.user !== null && (!/^[A-Za-z0-9._-]+$/.test(t.user) || t.user.startsWith('-'))) throw new Error('bad user');
  return [
    tty,
    ...commonOptions(t),
    ...(t.port !== undefined ? ['-p', String(t.port)] : []),
    ...(t.user !== null ? ['-l', t.user] : []),
    t.host,
    command,
  ];
}

/** 相手で mux を動かす 1 本のコマンド。args の字は引用済みのものを渡す。target は呼び出し側が引用の要る形にする。 */
function muxLine(spec: RemoteSpec, args: string): string {
  if (isWindowsShell(spec.shell)) return `& ${pq(spec.mux?.path ?? 'psmux')} -L hangar ${args}`;
  return `${q(spec.mux?.path ?? 'tmux')} -L hangar ${args}`;
}

/** 相手の既定のシェルが解釈する形に包む。POSIX で mux の絶対パスが無いときは、ログインシェルを通して PATH を得る。 */
function wrap(spec: RemoteSpec, script: string): string {
  if (spec.shell === 'cmd') return `powershell -NoProfile -Command "${script}"`;
  if (spec.shell === 'posix' && !spec.mux) return `exec "$SHELL" -l -c ${q(script)}`;
  return script;
}

const nameOf = (spec: RemoteSpec): string => remoteSessionName(spec.tabId);
/** target は =名前（完全一致）。zsh が =word を展開するので、POSIX では引用する。 */
const targetOf = (spec: RemoteSpec): string => (isWindowsShell(spec.shell) ? `=${nameOf(spec)}` : q(`=${nameOf(spec)}`));

/** 本番：tty を取り、相手の mux のセッションに入る（無ければ作る）。 */
export function shellArgv(t: SshTarget, spec: RemoteSpec): string[] {
  checkSpec(spec);
  const cwdArg = isWindowsShell(spec.shell) ? pq(spec.cwd) : q(spec.cwd);
  return sshArgv('-tt', t, wrap(spec, muxLine(spec, `new-session -A -s ${nameOf(spec)} -c ${cwdArg}`)));
}

/**
 * 準備：tty なしで、セッションの有無を見て無ければ作り、場所を読み、1 行の印を出す。
 * 印は `hangar-prep created|existed match|mismatch`。作れなかったときは 70 で終わる。
 */
export function prepareArgv(t: SshTarget, spec: RemoteSpec): string[] {
  checkSpec(spec);
  if (isWindowsShell(spec.shell)) {
    const m = spec.mux?.path ?? 'psmux';
    const script = [
      `$m=${pq(m)}`, `$n=${pq(nameOf(spec))}`, `$c=${pq(spec.cwd)}`, `$t='='+$n`,
      `& $m -L hangar has-session -t $t 2>$null`,
      `if($LASTEXITCODE -eq 0){$s='existed'}else{& $m -L hangar new-session -d -s $n -c $c;if($LASTEXITCODE -ne 0){exit 70};$s='created'}`,
      `$p=(& $m -L hangar display-message -p -t $t '#{pane_current_path}')`,
      `if($p -eq $c){$k='match'}else{$k='mismatch'}`,
      `Write-Output ('hangar-prep '+$s+' '+$k)`,
    ].join(';');
    return sshArgv('-T', t, wrap(spec, script));
  }
  const script = [
    `M=${q(spec.mux?.path ?? 'tmux')}`, `N=${q(nameOf(spec))}`, `C=${q(spec.cwd)}`,
    `if "$M" -L hangar has-session -t "=$N" 2>/dev/null; then s=existed; else "$M" -L hangar new-session -d -s "$N" -c "$C" || exit 70; s=created; fi`,
    `p=$("$M" -L hangar display-message -p -t "=$N" '#{pane_current_path}')`,
    `if [ "$p" = "$C" ]; then k=match; else k=mismatch; fi`,
    `echo "hangar-prep $s $k"`,
  ].join('; ');
  // ログインシェルが fish などでも動くよう、sh に渡す。
  return sshArgv('-T', t, wrap(spec, `sh -c ${q(script)}`));
}

/** 準備の標準出力から印を読む。無ければ null。 */
export function parsePrepareMark(stdout: string): { created: boolean; cwdMatches: boolean } | null {
  const m = /^hangar-prep (created|existed) (match|mismatch)\s*$/m.exec(stdout.replace(/\r/g, ''));
  return m ? { created: m[1] === 'created', cwdMatches: m[2] === 'match' } : null;
}

/** 作ったばかりのセッションの場所が違うとき、中のシェルに cd を打ち込む。 */
export function cdArgv(t: SshTarget, spec: RemoteSpec): string[] {
  checkSpec(spec);
  const win = isWindowsShell(spec.shell);
  const text = win ? `Set-Location -LiteralPath ${pq(spec.cwd)}; Clear-Host` : `cd -- ${q(spec.cwd)}; clear`;
  const tg = targetOf(spec);
  const script = `${muxLine(spec, `send-keys -t ${tg} -l ${win ? pq(text) : q(text)}`)}; ${muxLine(spec, `send-keys -t ${tg} Enter`)}`;
  return sshArgv('-T', t, wrap(spec, script));
}

/** 閉じる：その 1 つのセッションだけを消す。kill-server は組み立てない。 */
export function closeArgv(t: SshTarget, spec: RemoteSpec): string[] {
  checkSpec(spec);
  return sshArgv('-T', t, wrap(spec, muxLine(spec, `kill-session -t ${targetOf(spec)}`)));
}

/**
 * ssh（準備でも本番でも）が終わったときの読み方。終了コードが 0 でないときに使う。
 * detail は stderr の最後の空でない 1 行（画面の手掛かり）。
 * 判定は OpenSSH 9.x の mac と Windows（8.1・9.5）が出す文に合わせてある。
 */
export function classifySshFailure(code: number | null, stderr: string): { reason: RemoteShellFailure; detail: string } {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  const detail = lines[lines.length - 1] ?? '';
  const has = (re: RegExp): boolean => re.test(stderr);
  const reason = ((): RemoteShellFailure => {
    if (has(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i)) return 'host-key';
    if (has(/Permission denied|Too many authentication failures/i)) return 'auth';
    if (has(/Connection refused/i) && has(/connect to host/i)) return 'no-sshd';
    if (has(/closed by remote host|Broken pipe|Connection reset by|Timeout, server .* not responding/i) && !has(/kex_exchange_identification/i)) return 'dropped';
    if (has(/timed out|No route to host|Could not resolve|Network is unreachable|Host is down|kex_exchange_identification|Connection closed by .* port|banner exchange/i)) return 'unreachable';
    if (code === 127 || code === 9009 || has(/command not found|is not recognized as|No such file or directory|not found/i)) return 'no-mux';
    return code === 255 ? 'unreachable' : 'dropped';
  })();
  return { reason, detail };
}
