import crypto from 'node:crypto';
import fs from 'node:fs';
import os, { type NetworkInterfaceInfo } from 'node:os';
import path from 'node:path';
import { parseDeviceStatus, type DeviceAccountStatus, type DeviceStatus, type PeerDeviceStatus } from '@agent-hangar/shared';
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
};

const byName = (a: DeviceAccountStatus, b: DeviceAccountStatus): number => (a.agent === b.agent ? 0 : a.agent < b.agent ? -1 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** 読み取りを集めて、比べやすい並びの様子にする。 */
export function collectDeviceStatus(s: StatusSources): DeviceStatus {
  return {
    accounts: [...s.accounts()].sort(byName),
    agents: [...new Set(s.agents())].sort(),
    lan_ips: [...new Set(s.lanIps())].sort(),
    ssh_host_key: s.hostKey(),
    hangar_version: s.version,
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
}): StatusSources {
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
    hostKey: () => hostKeyFingerprint(process.platform, process.env),
    version: o.version,
  };
}
