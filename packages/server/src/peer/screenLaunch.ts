import { randomUUID } from 'node:crypto';
import { isAgentKind, sealPeerLaunch, type PeerDeviceDto, type PeerLaunchBody, type PeerLaunchOutcomeDto, type PeerLaunchRefusal, type PeerLaunchRequest } from '@agent-hangar/shared';
import { readPeerStatuses } from '../config/deviceStatus.ts';
import type { Db } from '../db/open.ts';
import { defaultLanguage, type GetLanguage } from '../i18n/language.ts';
import { msg, render } from '../i18n/message.ts';
import { PeerSshConnectError } from './ssh/link.ts';
import { choosePeerRoute, resolvePeer, type PeerCallDeps, type PeerCallRefusal } from './caller.ts';
import { recordPeerRequest, SCREEN_CALLER } from './outbox.ts';
import { screenRefusalText } from './text.ts';
import { versionAtLeast } from './version.ts';
import type { PeerDeviceStatus } from '@agent-hangar/shared';

/**
 * 画面からの起動（案 1C）。新規ダイアログで選んだ PC に、人が直接起動を頼む（D8：人が画面から起こすときは承認しない）。
 * MCP の create_session（mcp/peerTools.ts）と同じ封じ方と置き方で、違いは次のとおり。
 * - 呼び出し元の会話が無い。親の会話は空（SCREEN_CALLER）で記録し、相手は結び付きも結果の返却も作らない。
 * - ほかのプロジェクトやクイックセッションも、そのまま置く。
 * - 置く前に、相手の様子（同期で届いたもの）で断れるものは断る。選ぶ前に画面が見せているので、ここは食い違いと直接の呼び出しへの備えである。
 * 起きたかどうかの答えは、後から PeerOutbox が画面の札で知らせる。
 */

type RouteDeps = Pick<PeerCallDeps, 'link' | 'workerOk' | 'ssh' | 'version'>;

/** 頼めるか。経路と、相手がこの機能（親の会話が空の頼み）を読む版かで決める。 */
function stateOf(p: PeerDeviceStatus, deps: RouteDeps, now: number): PeerDeviceDto['state'] {
  if (p.outdated || (deps.version !== undefined && !versionAtLeast(p.status?.hangar_version, deps.version))) return 'outdated';
  const route = choosePeerRoute(p, deps, now);
  if (!('refuse' in route)) return 'ready';
  return route.refuse === 'device-outdated' ? 'outdated' : 'offline';
}

/** 相手に、解決済みの置き場があるプロジェクトの id。 */
function projectsOn(db: Db, deviceId: string): string[] {
  const rows = db.prepare('select distinct r.project_id id from project_roots r join projects p on p.id = r.project_id where r.device_id = ? and r.deleted_at is null and r.resolved = 1 and p.deleted_at is null and p.is_scratch = 0 order by r.project_id').all(deviceId) as { id: string }[];
  return rows.map((r) => r.id);
}

/** 新規ダイアログの PC の選択（GET /api/peers）。自分は含めない。 */
export function listPeersForScreen(db: Db, selfId: string, deps: RouteDeps, now: number): PeerDeviceDto[] {
  return readPeerStatuses(db, selfId).map((p) => ({
    id: p.device_id, name: p.name, platform: p.platform, state: stateOf(p, deps, now),
    accounts: (p.status?.accounts ?? []).map((a) => ({ name: a.name, agent: a.agent, loggedIn: a.logged_in })),
    agents: p.status?.agents ?? [],
    projects: projectsOn(db, p.device_id),
  }));
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** 本体の形を確かめる。合わなければ TypeError（呼び手は 400 にする）。 */
function check(b: PeerLaunchBody): void {
  if (!b || typeof b.device !== 'string' || !b.device.trim()) throw new TypeError('device is required');
  if (!isAgentKind(b.agent)) throw new TypeError('agent is not known');
  if (typeof b.scratch !== 'boolean') throw new TypeError('scratch is required');
  if (b.scratch ? b.projectId !== null : typeof b.projectId !== 'string' || !b.projectId) throw new TypeError('projectId and scratch do not agree');
}

export type ScreenLaunchDeps = { db: Db; deviceId: string; peer: PeerCallDeps; language?: GetLanguage };

export async function launchFromScreen(deps: ScreenLaunchDeps, body: PeerLaunchBody): Promise<PeerLaunchOutcomeDto> {
  check(body);
  const lang = deps.language ?? defaultLanguage;
  const now = deps.peer.now?.() ?? Date.now();
  const peer = resolvePeer(deps.db, deps.deviceId, body.device);
  const names = readPeerStatuses(deps.db, deps.deviceId).map((p) => p.name);
  const refuse = (reason: PeerCallRefusal | PeerLaunchRefusal, device: string, message: string): PeerLaunchOutcomeDto => ({ status: 'refused', reason, message });
  const launchRefusal = (reason: PeerLaunchRefusal, p: PeerDeviceStatus, detail?: string) => refuse(reason, p.name, screenRefusalText(lang(), { device: p.name, reason, ...(detail ? { detail } : {}) }));
  if (!peer) return refuse('device-unknown', body.device, render(lang(), msg('mcp.device.unknown', { device: body.device.slice(0, 40), names })));
  const state = stateOf(peer, deps.peer, now);
  if (state !== 'ready') {
    const reason: PeerCallRefusal = state === 'outdated' ? 'device-outdated' : 'device-offline';
    return refuse(reason, peer.name, render(lang(), msg(state === 'outdated' ? 'mcp.device.outdated' : 'mcp.device.offline', { device: peer.name })));
  }
  const st = peer.status!;
  if (!st.agents.includes(body.agent)) return launchRefusal('agent-missing', peer);
  if (!body.scratch && !projectsOn(deps.db, peer.device_id).includes(body.projectId!)) return launchRefusal('project-missing', peer);
  const account = body.agent === 'opencode' ? '' : str(body.account) ?? '';
  if (account) {
    const a = st.accounts.find((x) => x.agent === body.agent && x.name === account);
    if (!a) return launchRefusal('account-missing', peer, account);
    if (a.logged_in === false) return launchRefusal('account-logged-out', peer, account);
  }
  const route = choosePeerRoute(peer, deps.peer, now);
  if ('refuse' in route) return refuse(route.refuse, peer.name, render(lang(), msg(route.refuse === 'device-outdated' ? 'mcp.device.outdated' : 'mcp.device.offline', { device: peer.name })));
  const requestId = (deps.peer.newId ?? randomUUID)();
  const req: PeerLaunchRequest = {
    v: 1, createdAt: now, parentSessionId: SCREEN_CALLER, projectId: body.scratch ? null : body.projectId, scratch: body.scratch, agent: body.agent,
    account, permissionMode: body.agent === 'opencode' ? '' : str(body.permissionMode) ?? '', model: str(body.model) ?? '', prompt: str(body.prompt) ?? '',
    ...(str(body.effort) && body.agent !== 'opencode' ? { effort: str(body.effort)! } : {}), ...(str(body.mode) ? { mode: str(body.mode)! } : {}),
    ...(body.autoApprove === true ? { autoApprove: true } : {}), ...(str(body.name) ? { name: str(body.name)! } : {}),
  };
  try {
    const sealed = await sealPeerLaunch(await route.ring(), { requestId, from: deps.deviceId, to: peer.device_id }, req);
    await route.api.put({ id: requestId, to: peer.device_id, sealed, from: deps.deviceId });
  } catch (e) {
    if (e instanceof PeerSshConnectError) return refuse('device-offline', peer.name, render(lang(), msg('mcp.device.offline', { device: peer.name })));
    throw e;
  }
  recordPeerRequest(deps.db, { requestId, to: peer.device_id, callerSessionId: SCREEN_CALLER, now, via: route.via });
  return { status: 'requested', requestId, device: peer.name };
}
