/**
 * PC どうしの封（別の PC への起動の頼み、その答え、ターンが止まるたびの結果）。
 *
 * 鍵は世代鍵から導いた peer の用途の鍵（`hangar-e2e-v2/peer`）で、グループの PC はどれも同じ鍵を持つ。
 * 封は sealJson の形（版、IV、AES-256-GCM、大きければ gzip）を base64url にし、頭に世代の番号を付けた `<世代>.<base64url>` の文字列である。
 * Worker はこの文字列をそのまま置いて渡し、中身を読まない。
 * 開く側は、封が名乗る世代の鍵で開く（行と同じく、世代を回した後も古い世代の鍵で開ける）。
 *
 * AAD は配列の JSON で、頭に用途の印（peer-launch、peer-answer、peer-result）を置く。
 * スマホの AAD（`launch:...` などの文字列）や、行と名簿の AAD（`["row", ...]` など）とは頭が違うので重ならない。
 * 世代を AAD に入れるので、頭の世代を書き換えた封は開けない。
 * 頼み・答え・結果のどれも、頼みの向き（from は頼んだ PC、to は頼まれた PC）をそのまま入れ、向きは印で決める。
 * 結果には連番（seq）を入れ、並べ替えや差し替えを落とす。
 *
 * グループの PC はどれも同じ鍵を持つので、封はグループの外（Worker、別のグループ、解除した後に回した世代を持たない PC）に対する守りである。
 * グループの中のどの PC が封じたかは鍵では区別できない。from が名乗る PC と、Worker が端末トークンで確かめた送り手が同じことは Worker が検める。
 */

import { isAgentKind, type AgentKind } from '../agents.ts';
import { fromBase64Url, toBase64Url } from './bytes.ts';
import type { EpochKeys } from './keys.ts';
import { E2eOpenError, openJson, sealJson } from './seal.ts';

/** 封じるときは今の世代、開くときは封が名乗る世代の鍵を引く鍵の束（サーバの Keyring がこの形を満たす）。 */
export type PeerKeyring = { current(): EpochKeys; at(epoch: number): EpochKeys | null };

/** 頼みの宛先。from は頼んだ PC の ID、to は頼まれた PC の ID。答えと結果も同じ値を渡す。 */
export type PeerRoute = { requestId: string; from: string; to: string };

/** 封が名乗る世代の鍵を持っていない。呼び手は keybox を読み直してから開き直せる。 */
export class PeerUnknownEpochError extends E2eOpenError {
  constructor(readonly epoch: number) {
    super(`世代 ${epoch} の鍵を持っていません`);
    this.name = 'PeerUnknownEpochError';
  }
}

/**
 * 別の PC への起動の頼み（封の中身）。
 * parentSessionId は頼んだ PC の会話（結果を送り込む先）。
 * account はアカウントの名前で、呼び手が既定（呼び出し元と同じ名前）を埋めて送る。アカウントを持たないエージェントでは空。
 * scratch が true のとき projectId は null（クイックセッション）。
 * 後のタスクが欄を足すときは省ける欄にし、古い版の PC は知らない欄を読み捨てる。
 */
export type PeerLaunchRequest = {
  v: 1;
  createdAt: number;
  parentSessionId: string;
  projectId: string | null;
  scratch: boolean;
  agent: AgentKind;
  account: string;
  permissionMode: string;
  model: string;
  prompt: string;
  effort?: string;
  mode?: string;
  autoApprove?: boolean;
  name?: string;
  /** 頼んだ PC の会話のアカウントの名前。account が空のとき、頼まれた PC はこの名前のアカウントで起こす（D7）。 */
  callerAccount?: string;
  /** 頼んだ PC の会話が、さらに別の PC から起こされたものなら true（D11 の深さの検査。同期の遅れで結び付きが届いていなくても断れる）。 */
  spawnedRemotely?: boolean;
  /**
   * 頼みの種類。省けば launch（起動）。send は起こした会話への入力、stop は起こした会話を止める。
   * 古い版の PC はこの欄を読まずに launch と扱うので、send と stop は版が新しい PC にしか送らない（呼ぶ側が相手の hangar_version で確かめる）。
   * send と stop では起動の欄（projectId、scratch、agent など）は使われない。形の検査を通るように、scratch を真、projectId を null、agent を claude-code、ほかを空にして送る。
   * send の本文は prompt に入れる。
   */
  op?: PeerLaunchOp;
  /** send と stop の対象。頼まれた PC にある、頼んだ側が起こした会話の ID。 */
  targetSessionId?: string;
};

export const PEER_LAUNCH_OPS = ['launch', 'send', 'stop'] as const;
export type PeerLaunchOp = (typeof PEER_LAUNCH_OPS)[number];

/** 頼まれた PC が起動を断る理由（計画の断る理由のうち、頼まれた PC が決めるもの）。 */
export const PEER_LAUNCH_REFUSALS = ['project-missing', 'account-missing', 'account-logged-out', 'agent-missing', 'depth-exceeded', 'bad-payload', 'expired', 'launch-failed', 'not-spawned-by-caller'] as const;
export type PeerLaunchRefusal = (typeof PEER_LAUNCH_REFUSALS)[number];

/** 頼みへの答え（封の中身）。 */
export type PeerLaunchAnswer = { ok: true; sessionId: string; title: string } | { ok: false; reason: PeerLaunchRefusal; detail?: string };

/** 結果を返すときの止まった理由。stopped はプロセスが終わったこと（閉じた、落ちた、止めた）で、結び付きは残り、再開して send が入ればまた返る。ended は会話が Done にされたか消えたことで、その後は返さない。 */
export const PEER_STOP_REASONS = ['idle', 'question', 'permission', 'stopped', 'ended'] as const;
export type PeerStopReason = (typeof PEER_STOP_REASONS)[number];

/**
 * ターンが止まるたびの結果（封の中身）。連番は封の AAD に入れ、中身には入れない。
 * lastReply は最後の返答で、上限で切ったら truncated を真にする。summary と status は set_session_summary の値で、無ければ null。
 */
export type PeerLaunchResult = {
  v: 1;
  at: number;
  sessionId: string;
  title: string;
  reason: PeerStopReason;
  summary: string | null;
  status: string | null;
  lastReply: string;
  truncated: boolean;
};

const ids = (r: PeerRoute): [string, string, string] => [r.requestId, r.from, r.to];

/** 頼みの AAD。 */
export const aadPeerLaunch = (epoch: number, r: PeerRoute): string => JSON.stringify(['peer-launch', epoch, ...ids(r)]);
/** 答えの AAD。向きは頼みの逆（to から from へ）。 */
export const aadPeerAnswer = (epoch: number, r: PeerRoute): string => JSON.stringify(['peer-answer', epoch, ...ids(r)]);
/** 結果の AAD。seq は 1 から数える連番。 */
export const aadPeerResult = (epoch: number, r: PeerRoute, seq: number): string => JSON.stringify(['peer-result', epoch, ...ids(r), seq]);

const SEALED_RE = /^([1-9][0-9]{0,8})\.([A-Za-z0-9_-]+)$/;

/** 封の頭の世代を読む。形が違えば null。開けるかどうかは見ない。 */
export function peerSealEpoch(sealed: string): number | null {
  if (typeof sealed !== 'string') return null;
  const m = SEALED_RE.exec(sealed);
  return m ? Number(m[1]) : null;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optStr = (v: unknown): boolean => v === undefined || isStr(v);

function checkRoute(r: PeerRoute): void {
  if (!r || !isStr(r.requestId) || !isStr(r.from) || !isStr(r.to) || !r.requestId || !r.from || !r.to) throw new TypeError('頼みの宛先の形が違います');
}

function isRequest(v: unknown): v is PeerLaunchRequest {
  if (!isObj(v) || v.v !== 1 || !isTime(v.createdAt) || !isStr(v.parentSessionId) || typeof v.scratch !== 'boolean') return false;
  if (!(v.projectId === null || isStr(v.projectId)) || !isAgentKind(v.agent)) return false;
  if (!isStr(v.account) || !isStr(v.permissionMode) || !isStr(v.model) || !isStr(v.prompt)) return false;
  return optStr(v.effort) && optStr(v.mode) && optStr(v.name) && optStr(v.callerAccount) && (v.spawnedRemotely === undefined || typeof v.spawnedRemotely === 'boolean') && (v.autoApprove === undefined || typeof v.autoApprove === 'boolean') && (v.op === undefined || (isStr(v.op) && (PEER_LAUNCH_OPS as readonly string[]).includes(v.op))) && optStr(v.targetSessionId);
}

function pickRequest(v: PeerLaunchRequest): PeerLaunchRequest {
  const out: PeerLaunchRequest = {
    v: 1,
    createdAt: v.createdAt,
    parentSessionId: v.parentSessionId,
    projectId: v.projectId,
    scratch: v.scratch,
    agent: v.agent,
    account: v.account,
    permissionMode: v.permissionMode,
    model: v.model,
    prompt: v.prompt,
  };
  if (v.effort !== undefined) out.effort = v.effort;
  if (v.mode !== undefined) out.mode = v.mode;
  if (v.autoApprove !== undefined) out.autoApprove = v.autoApprove;
  if (v.name !== undefined) out.name = v.name;
  if (v.callerAccount !== undefined) out.callerAccount = v.callerAccount;
  if (v.spawnedRemotely !== undefined) out.spawnedRemotely = v.spawnedRemotely;
  if (v.op !== undefined) out.op = v.op;
  if (v.targetSessionId !== undefined) out.targetSessionId = v.targetSessionId;
  return out;
}

const REFUSALS: ReadonlySet<string> = new Set(PEER_LAUNCH_REFUSALS);

/** 答えを読む。知らない断りの理由（新しい版の PC が足したもの）は launch-failed にし、元の理由を detail に残す。 */
function readAnswer(v: unknown): PeerLaunchAnswer | null {
  if (!isObj(v)) return null;
  if (v.ok === true) return isStr(v.sessionId) && isStr(v.title) ? { ok: true, sessionId: v.sessionId, title: v.title } : null;
  if (v.ok !== false || !isStr(v.reason) || !v.reason || !optStr(v.detail)) return null;
  if (!REFUSALS.has(v.reason)) return { ok: false, reason: 'launch-failed', detail: v.reason };
  const out: PeerLaunchAnswer = { ok: false, reason: v.reason as PeerLaunchRefusal };
  if (v.detail !== undefined) out.detail = v.detail as string;
  return out;
}

const STOPS: ReadonlySet<string> = new Set(PEER_STOP_REASONS);

function isResult(v: unknown): v is PeerLaunchResult {
  if (!isObj(v) || v.v !== 1 || !isTime(v.at) || !isStr(v.sessionId) || !isStr(v.title)) return false;
  if (!isStr(v.reason) || !STOPS.has(v.reason)) return false;
  if (!(v.summary === null || isStr(v.summary)) || !(v.status === null || isStr(v.status))) return false;
  return isStr(v.lastReply) && typeof v.truncated === 'boolean';
}

const pickResult = (v: PeerLaunchResult): PeerLaunchResult => ({
  v: 1,
  at: v.at,
  sessionId: v.sessionId,
  title: v.title,
  reason: v.reason,
  summary: v.summary,
  status: v.status,
  lastReply: v.lastReply,
  truncated: v.truncated,
});

async function sealWith(ring: PeerKeyring, aad: (epoch: number) => string, value: unknown): Promise<string> {
  const keys = ring.current();
  return `${keys.epoch}.${toBase64Url(await sealJson(keys.peer, aad(keys.epoch), value))}`;
}

async function openWith(ring: PeerKeyring, aad: (epoch: number) => string, sealed: string): Promise<unknown> {
  const m = typeof sealed === 'string' ? SEALED_RE.exec(sealed) : null;
  if (!m) throw new E2eOpenError();
  const epoch = Number(m[1]);
  const raw = fromBase64Url(m[2]!);
  if (!raw) throw new E2eOpenError();
  const keys = ring.at(epoch);
  if (!keys) throw new PeerUnknownEpochError(epoch);
  return openJson(keys.peer, aad(epoch), raw);
}

/** 起動の頼みを今の世代の鍵で封じる（頼む PC が呼ぶ）。 */
export async function sealPeerLaunch(ring: PeerKeyring, route: PeerRoute, req: PeerLaunchRequest): Promise<string> {
  checkRoute(route);
  if (!isRequest(req)) throw new TypeError('頼みの形が違います');
  return sealWith(ring, (e) => aadPeerLaunch(e, route), pickRequest(req));
}

/** 起動の頼みを開く（頼まれた PC が呼ぶ）。鍵、AAD、中身の形のどれが違っても E2eOpenError を投げる。 */
export async function openPeerLaunch(ring: PeerKeyring, route: PeerRoute, sealed: string): Promise<PeerLaunchRequest> {
  const v = await openWith(ring, (e) => aadPeerLaunch(e, route), sealed);
  if (!isRequest(v)) throw new E2eOpenError();
  return pickRequest(v);
}

/** 頼みへの答えを封じる（頼まれた PC が呼ぶ）。route は頼みと同じ値を渡す。 */
export async function sealPeerAnswer(ring: PeerKeyring, route: PeerRoute, ans: PeerLaunchAnswer): Promise<string> {
  checkRoute(route);
  const v = readAnswer(ans);
  if (!v || (!v.ok && v.reason !== (ans as { reason?: unknown }).reason)) throw new TypeError('答えの形が違います');
  return sealWith(ring, (e) => aadPeerAnswer(e, route), v);
}

/** 頼みへの答えを開く（頼んだ PC が呼ぶ）。 */
export async function openPeerAnswer(ring: PeerKeyring, route: PeerRoute, sealed: string): Promise<PeerLaunchAnswer> {
  const v = readAnswer(await openWith(ring, (e) => aadPeerAnswer(e, route), sealed));
  if (!v) throw new E2eOpenError();
  return v;
}

/** ターンが止まった結果を封じる（頼まれた PC が呼ぶ）。seq は頼みごとに 1 から数える。 */
export async function sealPeerResult(ring: PeerKeyring, route: PeerRoute, seq: number, res: PeerLaunchResult): Promise<string> {
  checkRoute(route);
  if (!isSeq(seq)) throw new TypeError('連番の形が違います');
  if (!isResult(res)) throw new TypeError('結果の形が違います');
  return sealWith(ring, (e) => aadPeerResult(e, route, seq), pickResult(res));
}

/** ターンが止まった結果を開く（頼んだ PC が呼ぶ）。seq は Worker の行が名乗る連番で、封じたときと違えば開けない。 */
export async function openPeerResult(ring: PeerKeyring, route: PeerRoute, seq: number, sealed: string): Promise<PeerLaunchResult> {
  if (!isSeq(seq)) throw new E2eOpenError();
  const v = await openWith(ring, (e) => aadPeerResult(e, route, seq), sealed);
  if (!isResult(v)) throw new E2eOpenError();
  return pickResult(v);
}
