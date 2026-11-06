import fs from 'node:fs';
import { MOBILE_IMAGE_MAX_BYTES, openPeerChatBlob, PEER_CHAT_BLOB_MAX_BYTES, PEER_CHAT_SEND_WAIT_DEFAULT_MS, type PeerBlobRef, type PeerChatDevice, type PeerChatReply, type PeerKeyring } from '@agent-hangar/shared';
import { pruneDrops, saveDrop } from '../../prompt/drops.ts';
import { inputEmptyFromCapture } from './inputBox.ts';
import type { ChatView } from './hostView.ts';
import type { PeerChatHostDeps } from './hostTypes.ts';
import type { PeerQueue } from './queue.ts';

/**
 * send と resume-send（ほかの PC の文を、この PC の入力欄へ届ける道）。
 *
 * どちらも預かり（PeerQueue）を通す。
 * 止まっていて入力欄が空なら、預かりがすぐ渡す。
 * 作業中や打ちかけなら、渡せるまで預かる。
 * 画像は、預かる前に Worker から封のまま取り、開いて drops に置く（PC の指示欄の添付と同じ置き場）。
 * 渡すときに、置いたパスを文の末尾に足す。
 * 取れない画像が 1 枚でもあれば、何も預からずに断る。
 *
 * 頼み主は waitMs しか待たない（Worker が 504 を返す）。
 * 画像の取り込みも再開も含めた全体を waitMs に収め、過ぎたら expired で断って何も預からない。
 * 頼み主が諦めたあとで預かると、画面が文を戻したうえで、元の PC でも渡ってしまう（二重になる）。
 */

/**
 * resume-send で、再開した画面が使えるのを待つ長さ。
 * Worker は waitMs + 5 秒まで待つので、PEER_CHAT_WAIT_MAX_MS に収める。
 */
export const RESUME_READY_MS = 15_000;
const READY_STEP_MS = 100;
const IMAGE_EXT: Readonly<Record<PeerBlobRef['mime'], string>> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

type Refuse = Extract<PeerChatReply, { ok: false }>;
const refuse = (reason: Refuse['reason']): Refuse => ({ ok: false, reason });

export type SendDeps = {
  deps: PeerChatHostDeps;
  queue: PeerQueue;
  view: ChatView;
  /**
   * 次に預かる文の画像のパス。
   * add の直前に入れ、預かりの ID を作る newId が pathsByQueue に結び付けて空にする。
   */
  staged: { paths: string[] | null };
  /** 預かりの ID から、置いた画像のパス（渡すときに文へ足し、消えたときに片付ける）。 */
  pathsByQueue: Map<string, string[]>;
};

function removeFiles(paths: string[]): void {
  for (const f of paths) { try { fs.unlinkSync(f); } catch { /* 無ければよい */ } }
}

/**
 * 画像を取って、開いて、drops に置く。
 * 1 枚でも欠ければ、置いた分を消して null（理由は too-large か expired）。
 */
async function placeImages(s: SendDeps, ring: PeerKeyring, askId: string, from: string, refs: PeerBlobRef[]): Promise<{ paths: string[] } | { reason: 'too-large' | 'expired' }> {
  const { deps } = s;
  const saved: string[] = [];
  const discard = (): void => removeFiles(saved.splice(0));
  try {
    pruneDrops(deps.dropsDir, deps.now());
    for (const r of refs) {
      const sealed = await deps.fetchBlob(askId, from, r.n);
      if (sealed.byteLength > PEER_CHAT_BLOB_MAX_BYTES) { discard(); return { reason: 'too-large' }; }
      const bytes = await openPeerChatBlob(ring, { requestId: askId, from, to: deps.deviceId }, r.n, sealed);
      if (bytes.byteLength > MOBILE_IMAGE_MAX_BYTES) { discard(); return { reason: 'too-large' }; }
      saved.push(saveDrop(deps.dropsDir, `peer-${r.n + 1}.${IMAGE_EXT[r.mime]}`, bytes, deps.now()).path);
    }
    return { paths: saved };
  } catch (e) {
    discard();
    console.error('[peer-chat] could not fetch the images', e instanceof Error ? e.constructor.name : typeof e);
    return { reason: 'expired' };
  }
}

/**
 * 画像を取る（無ければ何もしない）。
 * 取れなければ断りを返す。
 */
async function stageImages(s: SendDeps, ring: PeerKeyring, askId: string, from: string, images: PeerBlobRef[]): Promise<{ paths: string[] } | Refuse> {
  if (images.length === 0) return { paths: [] };
  const placed = await placeImages(s, ring, askId, from, images);
  return 'reason' in placed ? refuse(placed.reason) : { paths: placed.paths };
}

/**
 * 文を預かりに入れる（同期）。
 * 預かれなければ画像を消して rate。
 */
function commit(s: SendDeps, sessionId: string, from: PeerChatDevice, text: string, images: PeerBlobRef[], paths: string[]): PeerChatReply {
  s.staged.paths = paths.length > 0 ? paths : null;
  const queueId = s.queue.add(sessionId, from, text, [...images]);
  s.staged.paths = null;
  if (queueId === null) {
    removeFiles(paths);
    return refuse('rate');
  }
  s.view.poke(sessionId);
  return { ok: true, queueId };
}

/**
 * 頼み主の待ち（waitMs）に収まる処理にする。
 * 待ちを過ぎたら、すぐ expired を返す（Worker が 504 を返す前に、画面が文を戻せるように）。
 * 過ぎたあとに work が続いていても、late() が真になるので、work は預かりに入れず、置いた画像も消す。
 */
async function bounded(s: SendDeps, waitMs: number | undefined, work: (late: () => boolean) => Promise<PeerChatReply>): Promise<PeerChatReply> {
  const limit = waitMs ?? PEER_CHAT_SEND_WAIT_DEFAULT_MS;
  const deadline = s.deps.now() + limit;
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PeerChatReply>((resolve) => { timer = setTimeout(() => { over = true; resolve(refuse('expired')); }, limit); });
  const late = (): boolean => over || s.deps.now() >= deadline;
  try {
    return await Promise.race([work(late), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 画像を置き、文を預かりに入れる。
 * 待ちを過ぎていたら、預からず画像を消して expired。
 */
async function enqueue(s: SendDeps, ring: PeerKeyring, sessionId: string, askId: string, from: PeerChatDevice, text: string, images: PeerBlobRef[], late: () => boolean): Promise<PeerChatReply> {
  const staged = await stageImages(s, ring, askId, from.deviceId, images);
  if ('ok' in staged) return staged;
  if (late()) { removeFiles(staged.paths); return refuse('expired'); }
  return commit(s, sessionId, from, text, images, staged.paths);
}

export async function sendOp(s: SendDeps, ring: PeerKeyring, sessionId: string, askId: string, from: PeerChatDevice, text: string, images: PeerBlobRef[], waitMs?: number): Promise<PeerChatReply> {
  // 止まった会話に預けても、いつ動き出すか分からない。
  // 再開して送るは resume-send で頼む。
  if (!s.deps.run(sessionId)) return refuse('session-unknown');
  return bounded(s, waitMs, (late) => enqueue(s, ring, sessionId, askId, from, text, images, late));
}

/** 画面が使える（動いていて、入力欄が空）か。 */
async function ready(s: SendDeps, sessionId: string): Promise<boolean> {
  const run = s.deps.run(sessionId);
  const pane = run ? s.deps.pane(run.tmuxName) : null;
  if (!pane) return false;
  try {
    const cap = await pane.captureStyled();
    return cap !== null && inputEmptyFromCapture(cap);
  } catch { return false; }
}

/**
 * 動いている会話は send と同じ。
 * 止まっていれば、まず画像を取り（再開のあとに取ると、頼み主の待ちを使い果たす。取れなければ再開もしない）、
 * 画面の再開と同じ道（deps.resume）で起こし、画面が使えるのを待ってから預かりへ入れる。
 * 再開が投げる、または待つ間に画面が現れなければ resume-failed で、何も預からない。
 * 頼み主の待ち（waitMs）を過ぎたら expired で、何も預からない。
 * 画面は現れたが、まだ入力欄が空でない（起動の確認の札など）ときは、預かりに入れる（空いたら渡す。
 * 10 分で捨てる）。
 */
export async function resumeSendOp(s: SendDeps, ring: PeerKeyring, sessionId: string, askId: string, from: PeerChatDevice, text: string, images: PeerBlobRef[], waitMs?: number): Promise<PeerChatReply> {
  const { deps } = s;
  if (deps.run(sessionId)) return bounded(s, waitMs, (late) => enqueue(s, ring, sessionId, askId, from, text, images, late));
  return bounded(s, waitMs, async (late) => {
    const staged = await stageImages(s, ring, askId, from.deviceId, images);
    if ('ok' in staged) return staged;
    const { paths } = staged;
    const giveUp = (reason: 'expired' | 'resume-failed'): PeerChatReply => { removeFiles(paths); return refuse(reason); };
    if (late()) return giveUp('expired');
    try {
      await deps.resume(sessionId);
    } catch (e) {
      console.error('[peer-chat] could not resume the session', e instanceof Error ? e.constructor.name : typeof e);
      return giveUp('resume-failed');
    }
    const limit = deps.resumeWaitMs ?? RESUME_READY_MS;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const t0 = deps.now();
    while (!deps.run(sessionId)) {
      if (late()) return giveUp('expired');
      if (deps.now() - t0 >= limit) return giveUp('resume-failed');
      await sleep(READY_STEP_MS);
    }
    // 起動の直後は、入力欄が現れるまで少しかかる。
    // 待つ時間は残りの分だけで、尽きたら預かりに任せる。
    while (!late() && !(await ready(s, sessionId)) && deps.now() - t0 < limit) await sleep(READY_STEP_MS);
    if (late()) return giveUp('expired');
    return commit(s, sessionId, from, text, images, paths);
  });
}
