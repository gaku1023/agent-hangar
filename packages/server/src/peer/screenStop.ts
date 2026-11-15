import { randomUUID } from 'node:crypto';
import { sealPeerLaunch, type PeerLaunchOutcomeDto, type PeerLaunchRequest, type PeerStopBody } from '@agent-hangar/shared';
import { sessionLock } from '../db/queries.ts';
import { defaultLanguage } from '../i18n/language.ts';
import { msg, render } from '../i18n/message.ts';
import { PeerSshConnectError } from './ssh/link.ts';
import { choosePeerRoute, resolvePeer } from './caller.ts';
import { recordPeerRequest, SCREEN_CALLER } from './outbox.ts';
import { versionAtLeast } from './version.ts';
import type { ScreenLaunchDeps } from './screenLaunch.ts';

/**
 * 画面からの停止。ほかの PC で動いている会話を、サイドバーのメニューの「停止」から止める。
 * 止める先の PC は、その会話のロック（いま動いている run の PC）で決める。
 * 頼み方は、MCP の stop_session が起こした別の PC の会話を止める道（mcp/peerTools.ts の remoteControlTool）と同じで、違いは次のとおり。
 * - 呼び出し元の会話が無い。親の会話は空（SCREEN_CALLER）で置き、相手は結び付きを問わずに止める（peer/launchInbox.ts）。
 * - 断りは入力にせず、画面の札で知らせる（peer/outbox.ts）。止まったことは、ロックが外れてサイドバーに出る。
 * 相手が親の空の stop を読む版でなければ、置かずに断る（古い版は bad-payload で断るだけだが、理由を先に言える）。
 */
export async function stopFromScreen(deps: ScreenLaunchDeps, body: PeerStopBody): Promise<PeerLaunchOutcomeDto> {
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId.trim()) throw new TypeError('sessionId is required');
  const lang = deps.language ?? defaultLanguage;
  const now = deps.peer.now?.() ?? Date.now();
  const lock = sessionLock(deps.db, deps.deviceId, body.sessionId, now);
  if (!lock || lock.deviceId === deps.deviceId) throw new TypeError('the session is not running on another device');
  const peer = resolvePeer(deps.db, deps.deviceId, lock.deviceId);
  if (!peer) return { status: 'refused', reason: 'device-unknown', message: render(lang(), msg('mcp.device.offline', { device: lock.deviceName })) };
  const offline = (): PeerLaunchOutcomeDto => ({ status: 'refused', reason: 'device-offline', message: render(lang(), msg('mcp.device.offline', { device: peer.name })) });
  if (peer.outdated || (deps.peer.version !== undefined && !versionAtLeast(peer.status?.hangar_version, deps.peer.version))) {
    return { status: 'refused', reason: 'device-outdated', message: render(lang(), msg('mcp.device.outdated', { device: peer.name })) };
  }
  const route = choosePeerRoute(peer, deps.peer, now);
  if ('refuse' in route) {
    return route.refuse === 'device-outdated'
      ? { status: 'refused', reason: route.refuse, message: render(lang(), msg('mcp.device.outdated', { device: peer.name })) }
      : offline();
  }
  const requestId = (deps.peer.newId ?? randomUUID)();
  const req: PeerLaunchRequest = {
    v: 1, createdAt: now, parentSessionId: SCREEN_CALLER, projectId: null, scratch: true, agent: 'claude-code',
    account: '', permissionMode: '', model: '', prompt: '', op: 'stop', targetSessionId: body.sessionId,
  };
  try {
    const sealed = await sealPeerLaunch(await route.ring(), { requestId, from: deps.deviceId, to: peer.device_id }, req);
    await route.api.put({ id: requestId, to: peer.device_id, sealed, from: deps.deviceId });
  } catch (e) {
    if (e instanceof PeerSshConnectError) return offline();
    throw e;
  }
  recordPeerRequest(deps.db, { requestId, to: peer.device_id, callerSessionId: SCREEN_CALLER, now, op: 'stop', childSessionId: body.sessionId, via: route.via });
  return { status: 'requested', requestId, device: peer.name };
}
