/** 各 PC が自分の様子として devices に載せるアカウント 1 件。logged_in が null なのは、まだ読めていない（未確認）こと。 */
export type DeviceAccountStatus = { agent: 'claude-code' | 'codex'; name: string; logged_in: boolean | null };

/**
 * 各 PC が devices.status（JSON）に載せる自分の様子。同期の行の鍵で封じられるので、Worker は読めない。
 * 別の PC へセッションを起こす前の検査（アカウント、エージェント）と、SSH の宛先の照合（lan_ips、ssh_host_key）が読む。
 * agents は、その PC で起こせるエージェント（入っていて、設定で有効なもの）である。
 * ssh_host_key は ssh-keygen -lf と同じ SHA256:... の形で、ホスト鍵が無ければ null。
 * 時刻は持たない。変わっていなければ書かない比較のためである（鮮度は devices.last_seen_at を見る）。
 */
export type DeviceStatus = { accounts: DeviceAccountStatus[]; agents: string[]; lan_ips: string[]; ssh_host_key: string | null; hangar_version: string };

/**
 * 別の PC の様子。status が null の PC は様子の欄を持たない版（この機能より前の hangar）で、outdated が真になる。
 * 呼ぶ側は device-unknown ではなく版が古いことを返す。
 */
export type PeerDeviceStatus = { device_id: string; name: string; platform: string; last_seen_at: number | null; status: DeviceStatus | null; outdated: boolean };

const isStr = (v: unknown): v is string => typeof v === 'string';

/** devices.status の JSON を読む。形が違う、読めない、空なら null（様子の欄が無いのと同じ扱い）。 */
export function parseDeviceStatus(raw: string | null | undefined): DeviceStatus | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.accounts) || !Array.isArray(o.agents) || !Array.isArray(o.lan_ips) || !isStr(o.hangar_version)) return null;
  const accounts: DeviceAccountStatus[] = [];
  for (const a of o.accounts) {
    if (typeof a !== 'object' || a === null) continue;
    const r = a as Record<string, unknown>;
    if ((r.agent !== 'claude-code' && r.agent !== 'codex') || !isStr(r.name)) continue;
    accounts.push({ agent: r.agent, name: r.name, logged_in: typeof r.logged_in === 'boolean' ? r.logged_in : null });
  }
  return { accounts, agents: o.agents.filter(isStr), lan_ips: o.lan_ips.filter(isStr), ssh_host_key: isStr(o.ssh_host_key) ? o.ssh_host_key : null, hangar_version: o.hangar_version };
}
