import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os, { type NetworkInterfaceInfo } from 'node:os';
import path from 'node:path';
import { DEVICE_OPENCODE_MODELS_MAX, orchestratorIdsOf, parseDeviceStatus, type DeviceAccountStatus, type DeviceOpencodeStatus, type DeviceSshStatus, type DeviceStatus, type RemoteShellKind, type OpencodeOptionsDto, type PeerDeviceStatus } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import type { DeviceInfo } from './paths.ts';

/**
 * 様子を調べ直す間隔。調べるだけなら安く、書くのは中身が変わったときだけ（refreshDeviceStatus）。
 * 変わらない間は D1 に何も書かないので、同期の書き込みと読み取りの枠は増えない。
 */
export const DEVICE_STATUS_MS = 300_000;

/** 様子の読み取り元。OS やプロセスに触る部分をここに集め、試験では差し替える。 */
export type StatusSources = {
  accounts(): DeviceAccountStatus[];
  /** その PC で起こせるエージェント（入っていて、設定で有効なもの）。 */
  agents(): string[];
  lanIps(): string[];
  hostKey(): string | null;
  version: string;
  /** 手元に持った opencode の選択肢（取りに行かない）。まだ取れていなければ null。省けば載せない。 */
  opencode?: () => OpencodeOptionsDto | null;
  /** この PC が宿主になった統括の系譜（設定の orchestrator の sessionId と history）。省けば載せない。 */
  orchestratorIds?: () => readonly string[];
  /** SSH のシェルタブの宛先に要る様子。省けば載せない。 */
  ssh?: () => DeviceSshStatus | null;
  /** Tailscale の IPv4（100.64.0.0/10）。省けば載せない。 */
  tailnetIps?: () => string[];
};

/** ほかの PC に見せる opencode の一覧を取り直す間。取り直すと serve を起こすことがある（1〜2 秒）ので、様子の調べ直し（5 分）より長くする。 */
export const OPENCODE_STATUS_MAX_AGE_MS = 30 * 60_000;

/**
 * 様子に載せる opencode の一覧の読み口（#698）。手元に持った一覧（ホームのもの）を返し、無いか maxAgeMs より古ければ裏で取り直す。
 * 取り直しは 1 度に 1 つで、取れたら onFetched を呼ぶ（呼ぶ側が様子を書き直す）。opencode を起こせないときは取りに行かず null を返す。
 */
export function opencodeStatusFeed(o: {
  options: { last(dir: null): OpencodeOptionsDto | null; get(dir: null): Promise<OpencodeOptionsDto> };
  usable: () => boolean;
  now: () => number;
  maxAgeMs: number;
  onFetched: () => void;
}): () => OpencodeOptionsDto | null {
  let inFlight = false;
  return () => {
    if (!o.usable()) return null;
    const held = o.options.last(null);
    if (!inFlight && (held === null || o.now() - held.fetchedAt >= o.maxAgeMs)) {
      inFlight = true;
      o.options.get(null).then(() => { inFlight = false; o.onFetched(); }, () => { inFlight = false; });
    }
    return held;
  };
}

/** opencode の選択肢から、ほかの PC に見せる分を作る。いま動かせないモデル（missing）は載せず、時刻と版は落とす。 */
export function deviceOpencodeOf(dto: OpencodeOptionsDto): DeviceOpencodeStatus {
  const models = dto.models.filter((m) => m.missing !== true).slice(0, DEVICE_OPENCODE_MODELS_MAX)
    .map((m) => ({ id: m.id, label: m.label, group: m.group, provider: m.provider, tools: m.tools, context: m.context, cost: m.cost }));
  return { modes: dto.modes.map((m) => ({ id: m.id, description: m.description })), models, providers: dto.providers.map((p) => ({ id: p.id, name: p.name, where: p.where })), defaultModel: dto.defaultModel };
}

const byName = (a: DeviceAccountStatus, b: DeviceAccountStatus): number => (a.agent === b.agent ? 0 : a.agent < b.agent ? -1 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** 読み取りを集めて、比べやすい並びの様子にする。 */
export function collectDeviceStatus(s: StatusSources): DeviceStatus {
  const agents = [...new Set(s.agents())].sort();
  const opencode = agents.includes('opencode') ? s.opencode?.() ?? null : null;
  const orchestratorIds = orchestratorIdsOf(s.orchestratorIds?.() ?? []);
  const ssh = s.ssh?.() ?? null;
  const tailnetIps = [...new Set(s.tailnetIps?.() ?? [])].sort();
  return {
    accounts: [...s.accounts()].sort(byName),
    agents,
    lan_ips: [...new Set(s.lanIps())].sort(),
    ssh_host_key: s.hostKey(),
    hangar_version: s.version,
    ...(opencode ? { opencode: deviceOpencodeOf(opencode) } : {}),
    ...(orchestratorIds.length > 0 ? { orchestrator_ids: orchestratorIds } : {}),
    ...(ssh ? { ssh } : {}),
    ...(tailnetIps.length > 0 ? { tailnet_ips: tailnetIps } : {}),
  };
}

const VIRTUAL_IFACE = /^(docker|veth|br-|virbr|vmnet|vboxnet|utun|tun|tap|tailscale|zt|wg|lo|awdl|llw|bridge|anpi|ap\d)|vethernet|virtualbox|vmware|hyper-v|wsl|loopback|bluetooth/i;

const isPrivateV4 = (ip: string): boolean => {
  const p = ip.split('.').map(Number) as [number, number, number, number];
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
};

/** LAN の IP。プライベートの IPv4 だけで、ループバック、リンクローカル、仮想の口は外す。 */
export function lanIpv4s(ifaces: Record<string, Pick<NetworkInterfaceInfo, 'address' | 'family' | 'internal'>[] | undefined>): string[] {
  const out = new Set<string>();
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const i of list ?? []) {
      if ((i.family as string | number) !== 'IPv4' && (i.family as string | number) !== 4) continue;
      if (i.internal || !isPrivateV4(i.address)) continue;
      out.add(i.address);
    }
  }
  return [...out].sort();
}

const v4Parts = (ip: string): number[] | null => {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
};

/** Tailscale の IPv4（100.64.0.0/10）。lan の口の除外より前に、口の名前に依らず範囲で拾う（lan_ips には入れない）。 */
export function tailnetIpv4s(ifaces: Record<string, Pick<NetworkInterfaceInfo, 'address' | 'family' | 'internal'>[] | undefined>): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if ((i.family as string | number) !== 'IPv4' && (i.family as string | number) !== 4) continue;
      const p = v4Parts(i.address);
      if (i.internal || !p || p[0] !== 100 || (p[1] as number) < 64 || (p[1] as number) > 127) continue;
      out.add(i.address);
    }
  }
  return [...out].sort();
}

/** ssh のホスト鍵（ed25519）の公開鍵の置き場。 */
export function hostKeyPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') return [path.win32.join(env.ProgramData ?? 'C:\\ProgramData', 'ssh', 'ssh_host_ed25519_key.pub')];
  return ['/etc/ssh/ssh_host_ed25519_key.pub'];
}

/** 公開鍵の 1 行（ssh-ed25519 AAAA...）から、ssh-keygen -lf と同じ SHA256:... の指紋を作る。読めなければ null。 */
export function fingerprintOfPublicKey(text: string): string | null {
  const m = /^\s*ssh-ed25519\s+([A-Za-z0-9+/]+={0,2})/.exec(text);
  if (!m) return null;
  const blob = Buffer.from(m[1] ?? '', 'base64');
  if (blob.length === 0) return null;
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** この PC の ssh のホスト鍵の指紋。鍵が無い、読めない、ssh サーバが入っていないときは null。 */
export function hostKeyFingerprint(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, read: (file: string) => string = (f) => fs.readFileSync(f, 'utf8')): string | null {
  for (const file of hostKeyPaths(platform, env)) {
    try { const fp = fingerprintOfPublicKey(read(file)); if (fp) return fp; } catch { /* 無い、または読めない */ }
  }
  return null;
}

/** ホスト公開鍵（ed25519）の base64。指紋（hostKeyFingerprint）と同じファイルと同じ鍵で、無ければ null。 */
export function hostPublicKeyBase64(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, read: (file: string) => string = (f) => fs.readFileSync(f, 'utf8')): string | null {
  for (const file of hostKeyPaths(platform, env)) {
    try {
      const m = /^\s*ssh-ed25519\s+([A-Za-z0-9+/]+={0,2})/.exec(read(file));
      if (m?.[1] && fingerprintOfPublicKey(read(file))) return m[1];
    } catch { /* 無い、または読めない */ }
  }
  return null;
}

/** 自分の sshd を ssh-keyscan した出力から ed25519 の公開鍵（base64）を取る。無ければ null。 */
export function parseOwnKeyscan(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\S+\s+ssh-ed25519\s+([A-Za-z0-9+/]+={0,2})\s*$/.exec(line.trim());
    if (m?.[1] && fingerprintOfPublicKey(`ssh-ed25519 ${m[1]}`)) return m[1];
  }
  return null;
}

/**
 * この PC の ssh のホスト鍵（公開鍵の base64 と指紋）。
 * Windows の OpenSSH は鍵の .pub まで Administrators と SYSTEM だけに絞るので、管理者でない hangar には読めない。
 * そのときは自分の sshd（127.0.0.1）を keyscan して取る。自分の PC に聞くので、取った鍵はそのまま信じてよい。
 */
export function ownHostKey(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, read: (file: string) => string, keyscan: () => string | null): { pubkey: string | null; fingerprint: string | null } {
  const fromFile = hostPublicKeyBase64(platform, env, read);
  const pubkey = fromFile ?? (platform === 'win32' ? keyscan() : null);
  return { pubkey, fingerprint: pubkey ? fingerprintOfPublicKey(`ssh-ed25519 ${pubkey}`) : null };
}

/** 自分の sshd の ed25519 の鍵を keyscan で取る（Windows の System32\OpenSSH）。sshd が無い、止まっているときは null。 */
function keyscanOwnSshd(env: NodeJS.ProcessEnv): string | null {
  const dir = path.win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'OpenSSH');
  const exe = path.win32.join(dir, 'ssh-keyscan.exe');
  try { return parseOwnKeyscan(execFileSync(fs.existsSync(exe) ? exe : 'ssh-keyscan.exe', ['-T', '3', '-t', 'ed25519', '127.0.0.1'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; }
}

/** reg query HKLM\SOFTWARE\OpenSSH /v DefaultShell の出力から、DefaultShell の値（実行ファイルのパス）を取る。無ければ null。 */
export function parseDefaultShell(out: string): string | null {
  const m = /DefaultShell\s+REG_\w+\s+(.+?)\s*$/m.exec(out);
  return m?.[1] ? m[1] : null;
}

/** 相手の sshd のログインシェル。Windows は DefaultShell（powershell.exe、pwsh.exe、無ければ cmd）、ほかは posix。 */
export function sshShellOf(platform: NodeJS.Platform, defaultShell: () => string | null): RemoteShellKind {
  if (platform !== 'win32') return 'posix';
  let v: string | null = null;
  try { v = defaultShell(); } catch { v = null; }
  const exe = (v ?? '').replace(/^"|"$/g, '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return exe === 'powershell.exe' ? 'powershell' : exe === 'pwsh.exe' ? 'pwsh' : 'cmd';
}

/** status の ssh の欄。鍵が無い PC（sshd なし）も欄は残し、host_pubkey を null にする（ssh_host_key=null と同じ意味）。 */
export function sshStatusOf(o: { platform: NodeJS.Platform; user: string; hostPubkey: string | null; tmuxPath: string | null; defaultShell: () => string | null }): DeviceSshStatus {
  return { user: o.user, host_pubkey: o.hostPubkey, mux: o.tmuxPath ? { kind: o.platform === 'win32' ? 'psmux' : 'tmux', path: o.tmuxPath } : null, shell: sshShellOf(o.platform, o.defaultShell) };
}

/** レジストリから Windows の sshd の DefaultShell を読む。無ければ null。 */
function readRegistryDefaultShell(): string | null {
  try { return parseDefaultShell(execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\OpenSSH', '/v', 'DefaultShell'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; }
}

/**
 * 自分の様子を調べ、前に書いたものと違うときだけ devices の自分の行へ書く（同期に載る）。書いたら真。
 * 調べるのに失敗しても例外は出さず、何も書かない（サーバの起動と同期を止めない）。
 */
export function refreshDeviceStatus(o: { db: Db; device: DeviceInfo; collect: () => DeviceStatus }): boolean {
  let next: string;
  try { next = JSON.stringify(o.collect()); } catch { return false; }
  const row = o.db.prepare('select * from devices where id = ?').get(o.device.id) as (Record<string, unknown> & { status?: string | null; deleted_at?: number | null }) | undefined;
  if (row && row.deleted_at == null && row.status === next) return false;
  upsertShared(o.db, 'devices', { ...(row ?? {}), id: o.device.id, name: o.device.name, platform: o.device.platform, status: next, deleted_at: null }, o.device.id);
  return true;
}

/**
 * 同期で届いた、ほかの PC の様子（自分と消された PC を除く）。
 * 様子の欄が無い、または読めない PC は status が null で outdated が真（この機能より前の版の hangar）。
 * list_devices と、別の PC へ起こす前の検査が使う。
 */
export function readPeerStatuses(db: Db, selfId: string): PeerDeviceStatus[] {
  const rows = db.prepare('select id, name, platform, last_seen_at, status from devices where deleted_at is null and id <> ? order by name').all(selfId) as { id: string; name: string; platform: string; last_seen_at: number | null; status: string | null }[];
  return rows.map((r) => {
    const status = parseDeviceStatus(r.status);
    return { device_id: r.id, name: r.name, platform: r.platform, last_seen_at: r.last_seen_at, status, outdated: status === null };
  });
}

type AuthedStore = { list(): { id: string; name: string }[]; auth: { get(id: string): { loggedIn: boolean } | null; ensureChecked(a: never): void } };

/** 実機の読み取り元。アカウントの一覧と認証は、起動の配線（boot/runs.ts）が持つものを渡す。 */
export function liveStatusSources(o: {
  claude: AuthedStore;
  codex: AuthedStore & { enabled(): boolean };
  /** エージェントごとの、起こせるか（入っていて、設定で有効）。 */
  agentUsable: (kind: string) => boolean;
  agentKinds: readonly string[];
  version: string;
  /** 手元に持った opencode の選択肢（OpencodeOptionsService の last）。 */
  opencode?: () => OpencodeOptionsDto | null;
  /** 統括の系譜（設定の orchestrator から）。 */
  orchestratorIds?: () => readonly string[];
  /** hangar が使う tmux（Windows は psmux）の絶対パス。設定の tmuxPath。 */
  tmuxPath?: () => string | null;
  /** DefaultShell の読み口（試験で差し替える）。 */
  defaultShell?: () => string | null;
}): StatusSources {
  // レジストリは 1 度だけ読む（調べ直しは 5 分ごと）。
  let shellCache: { v: string | null } | null = null;
  const defaultShell = (): string | null => (shellCache ??= { v: (o.defaultShell ?? readRegistryDefaultShell)() }).v;
  // 指紋と公開鍵は 1 回の調べ直しで 2 度引くので、短く持って keyscan を 1 回にする（sshd の起動や停止は次の調べ直しで拾う）。
  let keyCache: { at: number; v: { pubkey: string | null; fingerprint: string | null } } | null = null;
  const hostKey = () => {
    const now = Date.now();
    if (!keyCache || now - keyCache.at > 60_000) keyCache = { at: now, v: ownHostKey(process.platform, process.env, (f) => fs.readFileSync(f, 'utf8'), () => keyscanOwnSshd(process.env)) };
    return keyCache.v;
  };
  const rows = (agent: DeviceAccountStatus['agent'], store: AuthedStore): DeviceAccountStatus[] =>
    store.list().map((a) => {
      // まだ読んでいない認証は裏で読ませる。読めたら次の調べ直しで拾う。
      if (store.auth.get(a.id) === null) store.auth.ensureChecked(a as never);
      return { agent, name: a.name, logged_in: store.auth.get(a.id)?.loggedIn ?? null };
    });
  return {
    accounts: () => [...rows('claude-code', o.claude), ...(o.codex.enabled() ? rows('codex', o.codex) : [])],
    agents: () => o.agentKinds.filter((k) => o.agentUsable(k)),
    lanIps: () => lanIpv4s(os.networkInterfaces()),
    hostKey: () => hostKey().fingerprint,
    ssh: () => sshStatusOf({ platform: process.platform, user: os.userInfo().username, hostPubkey: hostKey().pubkey, tmuxPath: o.tmuxPath?.() ?? null, defaultShell }),
    tailnetIps: () => tailnetIpv4s(os.networkInterfaces()),
    version: o.version,
    ...(o.opencode ? { opencode: o.opencode } : {}),
    ...(o.orchestratorIds ? { orchestratorIds: o.orchestratorIds } : {}),
  };
}
