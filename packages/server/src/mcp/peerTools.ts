import { randomUUID } from 'node:crypto';
import { isAgentKind, sealPeerLaunch, type AgentKind, type PeerLaunchRequest } from '@agent-hangar/shared';
import { accountOfSession, getSession } from '../db/queries.ts';
import { defaultLanguage } from '../i18n/language.ts';
import { msg, render, type Message } from '../i18n/message.ts';
import { choosePeerRoute, listPeerDevices, resolvePeer, type PeerCallRefusal } from '../peer/caller.ts';
import { recordPeerRequest } from '../peer/outbox.ts';
import { versionAtLeast } from '../peer/version.ts';
import { getSpawn, isSpawnedBy, isSpawnedFromOtherDevice, type SpawnLink } from '../sessions/spawns.ts';
import { ToolError, type ToolContext, type ToolDeps } from './tools.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** 別の PC には渡せない引数（頼みの型に無い）。 */
const LOCAL_ONLY_ARGS = ['handoff', 'worktree', 'add_dirs', 'cwd'] as const;

const render_ = (deps: ToolDeps, m: Message): string => render((deps.language ?? defaultLanguage)(), m);

export function listDevicesTool(deps: ToolDeps) {
  const now = deps.peer?.now?.() ?? Date.now();
  const none = { link: () => null, workerOk: () => false };
  return { devices: listPeerDevices(deps.db, deps.deviceId, deps.peer ?? none, now) };
}

/** device が自分を指しているか。自分なら今までどおり手元で起こす。 */
export function isThisDevice(deps: ToolDeps, key: string): boolean {
  if (key === deps.deviceId) return true;
  const me = deps.db.prepare('select name from devices where id = ? and deleted_at is null').get(deps.deviceId) as { name: string | null } | undefined;
  return !!me?.name && me.name.toLowerCase() === key.trim().toLowerCase();
}

/** 頼みを置く前の断り。request_id は無い（何も置いていない）。 */
function refused(deps: ToolDeps, reason: PeerCallRefusal, device: string, m: Message) {
  return { status: 'refused' as const, reason, device, note: render_(deps, m) };
}

/**
 * 呼び出し元の会話のアカウントの名前。頼まれた PC が account を省かれたときに使う（D7）。
 * 起こすエージェントと呼び出し元のエージェントが違えば、そのアカウントは使えないので空にする。
 */
function callerAccountName(deps: ToolDeps, callerId: string, agent: AgentKind): string {
  const s = getSession(deps.db, deps.live(), callerId, { deviceId: deps.deviceId });
  if (!s || s.provider !== agent) return '';
  const store = agent === 'claude-code' ? deps.accounts?.store : agent === 'codex' ? deps.codexAccounts : undefined;
  if (!store) return '';
  const inherited = accountOfSession(deps.db, callerId, deps.deviceId);
  return ((inherited ? store.get(inherited) : null) ?? store.current())?.name ?? '';
}

/**
 * create_session に device を付けたときの本体。同じプロジェクトなら頼みを封じて置き、結果は後から入力で届く（D12）。
 * ほかのプロジェクトやクイックセッションは approval-pending を返す口だけで、承認の行と札は peer/approvals.ts が作る（D8）。
 * 返り値の status は requested、approval-pending、refused のどれか。断りは例外にせず reason で返す。
 */
export async function createRemoteSessionTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, key: string) {
  const peerDeps = deps.peer;
  const now = peerDeps?.now?.() ?? Date.now();
  const peer = peerDeps ? resolvePeer(deps.db, deps.deviceId, key) : null;
  if (!peer) {
    const names = listPeerDevices(deps.db, deps.deviceId, { link: () => null, workerOk: () => false }, now).map((d) => d.name);
    return refused(deps, 'device-unknown', key.slice(0, 40), msg('mcp.device.unknown', { device: key.slice(0, 40), names }));
  }
  if (!ctx.sessionId) throw new ToolError(msg('mcp.device.needsSession'));
  for (const a of LOCAL_ONLY_ARGS) if (args[a] !== undefined) throw new ToolError(msg('mcp.device.unsupportedArg', { arg: a }));
  const agent = args.agent;
  if (agent !== undefined && !isAgentKind(agent)) throw new ToolError(msg('run.agent.unknown', { agent: String(agent).slice(0, 40) }));
  const kind: AgentKind = agent ?? 'claude-code';
  const route = choosePeerRoute(peer, peerDeps!, now);
  if ('refuse' in route) return refused(deps, route.refuse, peer.name, msg(route.refuse === 'device-outdated' ? 'mcp.device.outdated' : 'mcp.device.offline', { device: peer.name }));
  // 深さは 1 まで（D11）。受ける側でも断るが、送る前に断れば無駄な往復を避けられる。
  if (isSpawnedFromOtherDevice(deps.db, deps.deviceId, ctx.sessionId)) return refused(deps, 'depth-exceeded', peer.name, msg('mcp.device.depthExceeded'));
  const callerProject = getSession(deps.db, deps.live(), ctx.sessionId, { deviceId: deps.deviceId })?.projectId ?? null;
  const quick = bool(args.scratch) === true && !str(args.project_id);
  const projectId = quick ? null : str(args.project_id) ?? callerProject;
  const newId = peerDeps!.newId ?? randomUUID;
  // プロジェクトを引けない呼び出し元（クイックセッション）から省かれたときも、クイックセッションとして承認に回す。
  const scratch = quick || projectId === null;
  const requestId = newId();
  const req: PeerLaunchRequest = {
    v: 1, createdAt: now, parentSessionId: ctx.sessionId, projectId, scratch, agent: kind,
    account: str(args.account) ?? '', permissionMode: str(args.permission_mode) ?? '', model: str(args.model) ?? '', prompt: str(args.prompt) ?? '',
    ...(str(args.effort) ? { effort: str(args.effort)! } : {}), ...(str(args.mode) ? { mode: str(args.mode)! } : {}),
    ...(bool(args.auto_approve) === true ? { autoApprove: true } : {}), ...(str(args.name) ? { name: str(args.name)! } : {}),
    callerAccount: callerAccountName(deps, ctx.sessionId, kind),
  };
  // 呼び出し元と同じプロジェクトだけ、承認なしで起こせる。人が画面から起こす経路はここを通らない（D8）。
  if (scratch || projectId !== callerProject) {
    peerDeps!.requestApproval?.({ requestId, to: peer.device_id, toName: peer.name, callerSessionId: ctx.sessionId, projectId, scratch, request: req });
    return { status: 'approval-pending' as const, request_id: requestId, device: peer.name, note: render_(deps, msg('mcp.device.approvalPending', { device: peer.name })) };
  }
  try {
    const sealed = await sealPeerLaunch(await route.ring(), { requestId, from: deps.deviceId, to: peer.device_id }, req);
    await route.api.put({ id: requestId, to: peer.device_id, sealed, from: deps.deviceId });
  } catch (e) {
    throw new ToolError(msg('mcp.device.sendFailed', { reason: e instanceof Error ? e.message : String(e) }));
  }
  recordPeerRequest(deps.db, { requestId, to: peer.device_id, callerSessionId: ctx.sessionId, now });
  return { status: 'requested' as const, request_id: requestId, device: peer.name, note: render_(deps, msg('mcp.device.requested', { device: peer.name })) };
}

/**
 * この会話が起こした、別の PC の会話か（D16）。そうならその結び付きを返す。
 * 別の PC の会話でも、自分が起こしたものでなければ null で、呼び出し側は今までどおり断る。
 */
export function remoteSpawnOf(deps: ToolDeps, ctx: ToolContext, targetId: string): SpawnLink | null {
  if (!ctx.sessionId) return null;
  const link = getSpawn(deps.db, deps.deviceId, targetId);
  if (!link || link.childDeviceId === deps.deviceId) return null;
  return isSpawnedBy(deps.db, deps.deviceId, ctx.sessionId, targetId) ? link : null;
}

/**
 * 起こした別の PC の会話への send と stop（D16）。頼みを封じて置き、答えと断りは後から入力で届く。
 * 相手が op を読む版（deps.peer.version 以上）でなければ、置かずに device-outdated で断る。
 * 読まない版は launch と扱い、ダミーの欄で新しい会話を起こしてしまうからである。
 * 返り値の status は requested か refused。
 */
export async function remoteControlTool(deps: ToolDeps, ctx: ToolContext, op: 'send' | 'stop', link: SpawnLink, text: string) {
  const peerDeps = deps.peer;
  const now = peerDeps?.now?.() ?? Date.now();
  const peer = peerDeps ? resolvePeer(deps.db, deps.deviceId, link.childDeviceId) : null;
  if (!peer) {
    const names = listPeerDevices(deps.db, deps.deviceId, { link: () => null, workerOk: () => false }, now).map((d) => d.name);
    return refused(deps, 'device-unknown', link.childDeviceId.slice(0, 40), msg('mcp.device.unknown', { device: link.childDeviceId.slice(0, 40), names }));
  }
  if (!ctx.sessionId) throw new ToolError(msg('mcp.device.needsSession'));
  if (peer.outdated || (peerDeps!.version !== undefined && !versionAtLeast(peer.status?.hangar_version, peerDeps!.version))) {
    return refused(deps, 'device-outdated', peer.name, msg('mcp.device.outdated', { device: peer.name }));
  }
  const route = choosePeerRoute(peer, peerDeps!, now);
  if ('refuse' in route) return refused(deps, route.refuse, peer.name, msg(route.refuse === 'device-outdated' ? 'mcp.device.outdated' : 'mcp.device.offline', { device: peer.name }));
  const requestId = (peerDeps!.newId ?? randomUUID)();
  const req: PeerLaunchRequest = {
    v: 1, createdAt: now, parentSessionId: ctx.sessionId, projectId: null, scratch: true, agent: 'claude-code',
    account: '', permissionMode: '', model: '', prompt: op === 'send' ? text : '', op, targetSessionId: link.childId,
  };
  try {
    const sealed = await sealPeerLaunch(await route.ring(), { requestId, from: deps.deviceId, to: peer.device_id }, req);
    await route.api.put({ id: requestId, to: peer.device_id, sealed, from: deps.deviceId });
  } catch (e) {
    throw new ToolError(msg('mcp.device.sendFailed', { reason: e instanceof Error ? e.message : String(e) }));
  }
  recordPeerRequest(deps.db, { requestId, to: peer.device_id, callerSessionId: ctx.sessionId, now, op, childSessionId: link.childId });
  return { status: 'requested' as const, request_id: requestId, device: peer.name, note: render_(deps, msg(op === 'send' ? 'mcp.device.requestedSend' : 'mcp.device.requestedStop', { device: peer.name })) };
}
