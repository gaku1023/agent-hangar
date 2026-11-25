import type { DeviceSshStatus, RemoteMux } from './remoteShell.ts';
import type { OpencodeModelOption, OpencodeModeOption, OpencodeProviderOption } from './opencodeOptions.ts';

/** 各 PC が自分の様子として devices に載せるアカウント 1 件。logged_in が null なのは、まだ読めていない（未確認）こと。 */
export type DeviceAccountStatus = { agent: 'claude-code' | 'codex'; name: string; logged_in: boolean | null };

/**
 * 各 PC が載せる opencode の選択肢（#698）。別の PC へ opencode を起こすとき、作成画面はこの一覧からモードとモデルを出す。
 * models はその PC でいま動かせるモデルだけ（ローカルのサーバーに無いモデルは載せない）。defaultModel はその PC の opencode.json の既定。
 * 料金を取った時刻は持たない（DeviceStatus は時刻を持たない決まり）。
 */
export type DeviceOpencodeStatus = { modes: OpencodeModeOption[]; models: OpencodeModelOption[]; providers: OpencodeProviderOption[]; defaultModel: string | null };

/** 載せるモデルの上限。同期の 1 行は封じた後で 180KB までなので、それに収まる数で切る。 */
export const DEVICE_OPENCODE_MODELS_MAX = 300;

/**
 * 各 PC が devices.status（JSON）に載せる自分の様子。同期の行の鍵で封じられるので、Worker は読めない。
 * 別の PC へセッションを起こす前の検査（アカウント、エージェント）と、SSH の宛先の照合（lan_ips、ssh_host_key）が読む。
 * agents は、その PC で起こせるエージェント（入っていて、設定で有効なもの）である。
 * ssh_host_key は ssh-keygen -lf と同じ SHA256:... の形で、ホスト鍵が無ければ null。
 * 時刻は持たない。変わっていなければ書かない比較のためである（鮮度は devices.last_seen_at を見る）。
 * opencode はその PC の opencode の選択肢で、opencode を起こせない PC、まだ一覧を取れていない PC、この欄を知らない古い版は持たない。
 * orchestrator_ids はその PC が宿主になった統括の系譜（今と前の会話の hangar の id、shared の orchestratorLineage）である。
 * 統括の設定は PC ごとで同期しないので、ほかの PC はこの欄で統括の会話を見分け、サイドバーから外す（docs/design.md「統括」）。
 * 系譜が無い PC と、この欄を知らない古い版は持たない。
 */
export type DeviceStatus = { accounts: DeviceAccountStatus[]; agents: string[]; lan_ips: string[]; ssh_host_key: string | null; hangar_version: string; opencode?: DeviceOpencodeStatus; orchestrator_ids?: string[]; /** SSH のシェルタブの宛先に要る様子（ユーザー名、ホスト公開鍵、端末の多重化、ログインシェル）。この欄を知らない古い版は持たない。 */ ssh?: DeviceSshStatus; /** Tailscale の IPv4（100.64/10）。無い PC と古い版は持たない。 */ tailnet_ips?: string[] };

/** 載せる統括の系譜の上限。系譜は今の 1 本と前の 20 件（ORCHESTRATOR_HISTORY_MAX）なので、余裕を見た数で切る。 */
export const DEVICE_ORCHESTRATOR_IDS_MAX = 64;

/** 統括の系譜の id を、空でない文字列だけ、重なりなしで、上限までに揃える。 */
export function orchestratorIdsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))].slice(0, DEVICE_ORCHESTRATOR_IDS_MAX);
}

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
  const opencode = parseOpencodeStatus(o.opencode);
  const orchestratorIds = orchestratorIdsOf(o.orchestrator_ids);
  const ssh = parseSshStatus(o.ssh);
  const tailnetIps = Array.isArray(o.tailnet_ips) ? o.tailnet_ips.filter((x): x is string => isStr(x) && x !== '') : [];
  return { accounts, agents: o.agents.filter(isStr), lan_ips: o.lan_ips.filter(isStr), ssh_host_key: isStr(o.ssh_host_key) ? o.ssh_host_key : null, hangar_version: o.hangar_version, ...(opencode ? { opencode } : {}), ...(orchestratorIds.length > 0 ? { orchestrator_ids: orchestratorIds } : {}), ...(ssh ? { ssh } : {}), ...(tailnetIps.length > 0 ? { tailnet_ips: tailnetIps } : {}) };
}

/** ssh の欄を読む。形が違えば欄ごと無いことにする（ほかの欄は活かす）。 */
function parseSshStatus(v: unknown): DeviceSshStatus | null {
  const o = rec(v);
  if (!o || !isStr(o.user) || (o.host_pubkey !== null && !isStr(o.host_pubkey))) return null;
  if (o.shell !== 'posix' && o.shell !== 'powershell' && o.shell !== 'pwsh' && o.shell !== 'cmd') return null;
  let mux: RemoteMux | null = null;
  if (o.mux !== null) {
    const m = rec(o.mux);
    if (!m || (m.kind !== 'tmux' && m.kind !== 'psmux') || !isStr(m.path)) return null;
    mux = { kind: m.kind, path: m.path };
  }
  return { user: o.user, host_pubkey: o.host_pubkey, mux, shell: o.shell };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** opencode の欄を読む。形が違えば欄ごと無いことにする（ほかの欄は活かす）。行の形が違うものは捨てる。 */
function parseOpencodeStatus(v: unknown): DeviceOpencodeStatus | null {
  const o = rec(v);
  if (!o || !Array.isArray(o.modes) || !Array.isArray(o.models) || !Array.isArray(o.providers)) return null;
  const modes: OpencodeModeOption[] = o.modes.flatMap((m) => {
    const r = rec(m);
    return r && isStr(r.id) ? [{ id: r.id, description: isStr(r.description) ? r.description : null }] : [];
  });
  const models: OpencodeModelOption[] = o.models.slice(0, DEVICE_OPENCODE_MODELS_MAX).flatMap((m) => {
    const r = rec(m);
    if (!r || !isStr(r.id) || !isStr(r.label) || !isStr(r.group) || !isStr(r.provider)) return [];
    const c = rec(r.cost);
    const cost = c && isNum(c.input) && isNum(c.output) ? { input: c.input, output: c.output } : null;
    return [{ id: r.id, label: r.label, group: r.group, provider: r.provider, tools: r.tools !== false, context: isNum(r.context) ? r.context : null, cost }];
  });
  const providers: OpencodeProviderOption[] = o.providers.flatMap((p) => {
    const r = rec(p);
    return r && isStr(r.id) && isStr(r.name) && (r.where === 'device' || r.where === 'lan' || r.where === 'remote') ? [{ id: r.id, name: r.name, where: r.where }] : [];
  });
  return { modes, models, providers, defaultModel: isStr(o.defaultModel) ? o.defaultModel : null };
}
