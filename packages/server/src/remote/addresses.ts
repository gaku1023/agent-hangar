import net from 'node:net';
import type { RemoteShellFailure } from '@agent-hangar/shared';

/**
 * 別 PC のシェルタブの宛先の候補を決める。
 * 上書きの Host 名があればそれだけ（~/.ssh/config に任せるので試さない）。
 * 無ければ前回つながった住所、lan_ips、tailnet_ips の順の候補に 22 番へ TCP をつなぎ、応えた順に並べる。
 */

export const PROBE_TIMEOUT_MS = 2000;

export type AddressProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export const tcpProbe: AddressProbe = (host, port, timeoutMs) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (ok: boolean): void => { s.destroy(); resolve(ok); };
  s.setTimeout(timeoutMs, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

export type AddressInput = { lan_ips: string[]; tailnet_ips: string[]; override: string | null; lastGood?: string };
export type AddressResult = { ok: true; addresses: string[] } | { ok: false; reason: Extract<RemoteShellFailure, 'unreachable'> };

export async function resolveAddresses(input: AddressInput, deps: { probe?: AddressProbe } = {}): Promise<AddressResult> {
  if (input.override) return { ok: true, addresses: [input.override] };
  const probe = deps.probe ?? tcpProbe;
  const candidates = [...new Set([...(input.lastGood ? [input.lastGood] : []), ...input.lan_ips, ...input.tailnet_ips])];
  const answered: string[] = [];
  await Promise.all(candidates.map(async (c) => {
    let ok = false;
    try { ok = await probe(c, 22, PROBE_TIMEOUT_MS); } catch { ok = false; }
    if (ok) answered.push(c);
  }));
  return answered.length > 0 ? { ok: true, addresses: answered } : { ok: false, reason: 'unreachable' };
}

/** 前回つながった住所を PC ごとにメモリで覚える。 */
export function createAddressBook(): { get(deviceId: string): string | undefined; set(deviceId: string, address: string): void } {
  const m = new Map<string, string>();
  return { get: (d) => m.get(d), set: (d, a) => { m.set(d, a); } };
}
