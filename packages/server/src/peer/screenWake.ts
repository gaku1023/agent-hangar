import { randomUUID } from 'node:crypto';
import { sealPeerLaunch, type PeerLaunchRequest } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { choosePeerRoute, resolvePeer } from './caller.ts';
import { getPeerRequest, recordPeerRequest, SCREEN_CALLER } from './outbox.ts';
import type { ScreenLaunchDeps } from './screenLaunch.ts';
import { versionAtLeast } from './version.ts';

/** 答えを待つ長さ。過ぎたら手元で起こす。受け側は、頼みが作られてから 15 秒より古い wake を断る（peer/launchInbox.ts）。 */
export const WAKE_WAIT_MS = 20_000;
const POLL_MS = 500;
const SYNC_EVERY_MS = 3_000;

export type ScreenWakeDeps = ScreenLaunchDeps & {
  /** 答えを取りに行く（PeerOutbox.sync）。呼び鈴が切れていても答えを拾うため、待つ間に数秒ごとに回す。投げてよい。 */
  sync(): Promise<void>;
  /** 待ち方。試験で差し替える。 */
  sleep?(ms: number): Promise<void>;
};

/**
 * 「今すぐ試す」を起こす PC。その会話の最後の run（started_at が最新）の PC が、手元でなければその PC を返す。
 * run が無い、最後が手元、PC の名前が引けないときは null（手元で起こす）。
 */
export function ownerOf(db: Db, selfId: string, sessionId: string): { deviceId: string; name: string } | null {
  const run = db.prepare('select device_id from runs where session_id = ? and deleted_at is null order by started_at desc, id desc limit 1').get(sessionId) as { device_id: string } | undefined;
  if (!run || run.device_id === selfId) return null;
  const d = db.prepare('select name from devices where id = ? and deleted_at is null').get(run.device_id) as { name: string } | undefined;
  return { deviceId: run.device_id, name: d?.name ?? run.device_id };
}

/**
 * Paused の会話を、最後に動いた PC で起こすよう頼み、答えを待つ。
 * 送る前に決まる断り（PC が引けない、黙っている、版が古い、経路が無い）は、送らずに fallback を返す。
 * 送ったあとは WAKE_WAIT_MS まで待ち、相手の答えが ok でなければ（断り、期限切れ、返事なし）fallback を返す。
 * fallback は、呼び手が手元で起こす印である。投げない。
 */
export async function wakeOnOwner(deps: ScreenWakeDeps, sessionId: string): Promise<'woken-remote' | 'fallback'> {
  try {
    return await wakeOnOwnerUnsafe(deps, sessionId);
  } catch (e) {
    console.error('[peer] could not ask the owner device to wake a session; waking here', e instanceof Error ? e.constructor.name : typeof e);
    return 'fallback';
  }
}

async function wakeOnOwnerUnsafe(deps: ScreenWakeDeps, sessionId: string): Promise<'woken-remote' | 'fallback'> {
  const clock = deps.peer.now ?? Date.now;
  const owner = ownerOf(deps.db, deps.deviceId, sessionId);
  if (!owner) return 'fallback';
  const peer = resolvePeer(deps.db, deps.deviceId, owner.deviceId);
  if (!peer) return 'fallback';
  if (peer.outdated || (deps.peer.version !== undefined && !versionAtLeast(peer.status?.hangar_version, deps.peer.version))) return 'fallback';
  const route = choosePeerRoute(peer, deps.peer, clock());
  if ('refuse' in route) return 'fallback';
  const requestId = (deps.peer.newId ?? randomUUID)();
  const start = clock();
  const req: PeerLaunchRequest = {
    v: 1, createdAt: start, parentSessionId: SCREEN_CALLER, projectId: null, scratch: true, agent: 'claude-code',
    account: '', permissionMode: '', model: '', prompt: '', op: 'wake', targetSessionId: sessionId,
  };
  const sealed = await sealPeerLaunch(await route.ring(), { requestId, from: deps.deviceId, to: peer.device_id }, req);
  await route.api.put({ id: requestId, to: peer.device_id, sealed, from: deps.deviceId });
  recordPeerRequest(deps.db, { requestId, to: peer.device_id, callerSessionId: SCREEN_CALLER, now: start, op: 'wake', childSessionId: sessionId });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastSync = start;
  for (;;) {
    const state = getPeerRequest(deps.db, requestId)?.state;
    if (state === 'done') return 'woken-remote';
    if (state === 'refused' || state === 'expired') return 'fallback';
    if (clock() - start >= WAKE_WAIT_MS) return 'fallback';
    await sleep(POLL_MS);
    if (clock() - lastSync >= SYNC_EVERY_MS) {
      lastSync = clock();
      await deps.sync().catch(() => undefined);
    }
  }
}
