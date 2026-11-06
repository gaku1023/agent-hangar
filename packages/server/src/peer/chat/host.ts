import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  appendPaths,
  checkPeerChatRequest,
  openPeerChat,
  sealPeerChatReply,
  type PeerBlobRef,
  type PeerChatBellAsk,
  type PeerChatBellReply,
  type PeerChatDevice,
  type PeerChatReply,
  type PeerChatRequest,
  type PeerKeyring,
} from '@agent-hangar/shared';
import { createPeerAnswerer, type AnswerPane } from './answer.ts';
import { inputEmptyFromCapture } from './inputBox.ts';
import { resumeSendOp, sendOp, type SendDeps } from './hostSend.ts';
import type { PeerChatHostDeps } from './hostTypes.ts';
import { ChatView, RECHECK_MS } from './hostView.ts';
import { PeerQueue, type TurnState } from './queue.ts';

/**
 * この PC で動く Claude Code の会話に、ほかの PC からの頼み（呼び鈴の chat の問い合わせ）を受けて答える。
 *
 * 流れ。
 * 頼みの封を開く（開けなければ答えない）、期限と大きさを見る、会話を見つける、op ごとに処理して、封じた答えを返す。
 * 開けた頼みには、断りも含めて必ず 1 つ答える。
 * 同じ askId の再送には、同じ答えを返し、効果は 1 回にする。
 *
 * 断る順番。
 * 期限切れ（expired）と本文の大きさ（too-large）→ 会話がこの PC に無い（session-unknown）→ Claude Code でない（not-claude）
 * → 送る系で設定が切れている（refused-by-setting）。
 * 読む系（tail、files）は設定が切れていても答える（見えるが送れない）。
 *
 * op の道。
 * - tail：hostView.ts の長いポーリング。
 * - send、resume-send：hostSend.ts。
 *   預かり（queue.ts）を通す。
 * - answer：画面の札が頼みの札と同じと確かめて打つ（answer.ts）。
 *   答えた PC を覚え、tail の札に「answered」を足す。
 * - interrupt：走っているターンに Escape を打つ（answer.ts）。
 * - cancel：預かりの送り主だけが取り消せる。
 * - files：スマホの files と同じ本体。
 *
 * 画面への知らせ（emit）。
 * 預かりが変わるたびに peerChat.queue、渡したときに peerChat.delivered を出す。
 * 預かりは会話の ID（sessionId）で持つ。
 * run が替わっても（再開）、同じ会話の預かりが続く。
 */

/** 同じ askId の答えを覚えておく長さ（頼みの期限 60 秒より長く）。 */
const REPLAY_KEEP_MS = 2 * 60_000;
const REPLAY_MAX = 128;

export type PeerChatHost = {
  /**
   * 呼び鈴の chat の枠に答える。
   * 開けない頼みは null（答えない）。
   * 投げない。
   */
  handle(frame: PeerChatBellAsk): Promise<PeerChatBellReply | null>;
  /**
   * 会話の状態が変わった。
   * 待っている tail を起こす。
   * sessionId を省けば全部。
   */
  poke(sessionId?: string): void;
  /**
   * 会話のターンが変わった（登録の状態の変化）。
   * 預かりが渡せるか確かめ、待っている tail を起こす。
   */
  turnChanged(): void;
  /**
   * 会話が消えた。
   * 預かりを捨て、送り主に session-unknown を知らせる。
   */
  dropSession(sessionId: string): void;
  dispose(): void;
};

const refuse = (reason: Extract<PeerChatReply, { ok: false }>['reason']): PeerChatReply => ({ ok: false, reason });
const SENDING: ReadonlySet<PeerChatRequest['op']['t']> = new Set(['send', 'answer', 'interrupt', 'resume-send', 'cancel']);

export function createPeerChatHost(deps: PeerChatHostDeps): PeerChatHost {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const paneOf = (sessionId: string) => {
    const run = deps.run(sessionId);
    return run ? deps.pane(run.tmuxName) : null;
  };
  const turnState = (sessionId: string): TurnState => {
    const s = deps.session(sessionId);
    if (!s || s.live === null || !deps.run(sessionId)) return 'stopped';
    return s.live;
  };
  const imagePaths = new WeakMap<PeerBlobRef[], string[]>();
  const pathsByQueue = new Map<string, string[]>();
  const active = new Set<string>();

  const queue: PeerQueue = new PeerQueue({
    now: deps.now,
    turnState,
    inputEmpty: async (sessionId) => {
      const cap = await paneOf(sessionId)?.captureStyled();
      return cap != null && inputEmptyFromCapture(cap);
    },
    // 貼る直前にもう一度、入力欄が空であることを確かめる（人が打ち始めたら渡さず、預かりに戻す）。
    deliver: async (sessionId, text, images) => {
      const run = deps.run(sessionId);
      const pane = paneOf(sessionId);
      if (!run || !pane) return false;
      const cap = await pane.captureStyled();
      if (cap === null || !inputEmptyFromCapture(cap)) return false;
      await deps.sendInput(sessionId, run.tmuxName, appendPaths(text, imagePaths.get(images) ?? []));
      return true;
    },
    newId: deps.newId ?? randomUUID,
    ...deps.queue,
  });

  const view = new ChatView({
    now: deps.now,
    sleep,
    recheckMs: deps.recheckMs ?? RECHECK_MS,
    session: deps.session,
    run: deps.run,
    pane: deps.pane,
    tail: { readTranscript: deps.readTranscript, ...(deps.cache ? { cache: deps.cache } : {}) },
    queued: (sessionId) => queue.list(sessionId),
  });

  const answerer = createPeerAnswerer({
    pane: (sessionId): AnswerPane | null => paneOf(sessionId),
    now: deps.now,
  });

  const forget = (queueId: string, remove: boolean): void => {
    const paths = pathsByQueue.get(queueId);
    pathsByQueue.delete(queueId);
    // 渡した画像は、Claude が読むので残す。
    // 渡さずに消えた預かりの画像だけ片付ける。
    if (remove) for (const f of paths ?? []) { try { fs.unlinkSync(f); } catch { /* 無ければよい */ } }
  };

  const offQueue = queue.subscribe((e) => {
    active.add(e.runId);
    const list = queue.list(e.runId);
    if (list.length === 0) active.delete(e.runId);
    deps.emit?.({ type: 'peerChat.queue', sessionId: e.runId, queued: list });
    if (e.type === 'delivered') {
      view.recordDelivered(e.runId, e.from, e.item.text);
      forget(e.item.queueId, false);
      deps.emit?.({ type: 'peerChat.delivered', sessionId: e.runId, from: e.from, at: deps.now() });
    } else if (e.type === 'expired') {
      view.recordGone(e.runId, e.item.from.deviceId, { queueId: e.item.queueId, reason: 'queue-expired' });
      forget(e.item.queueId, true);
    } else if (e.type === 'dropped') {
      view.recordGone(e.runId, e.item.from.deviceId, { queueId: e.item.queueId, reason: 'session-unknown' });
      forget(e.item.queueId, true);
    } else if (e.type === 'cancelled') {
      forget(e.item.queueId, true);
    }
    view.poke(e.runId);
  });

  const sendDeps: SendDeps = { deps, queue, view, imagePaths, pathsByQueue };

  async function answerOp(sessionId: string, from: PeerChatDevice, op: Extract<PeerChatRequest['op'], { t: 'answer' }>): Promise<PeerChatReply> {
    // 同じ札に先に答えた PC があれば、画面を見るまでもなく断る（札が閉じた後に遅れて来た答えも）。
    if (view.answeredAsk(op.askId)) return refuse('already-answered');
    const current = view.currentAsk(sessionId);
    if (!current || current.askId !== op.askId) return refuse('ask-mismatch');
    const asked = view.askItem(sessionId, current.askId);
    const r = await answerer.answerAsk(sessionId, current, op.keys, op.text);
    if (!r.ok) return refuse(r.reason);
    if (asked) view.recordAnswer(sessionId, asked, from, r.label);
    view.poke(sessionId);
    return { ok: true };
  }

  async function dispatch(ring: PeerKeyring, req: PeerChatRequest, fromId: string): Promise<PeerChatReply> {
    const check = checkPeerChatRequest(req, deps.now());
    if (!check.ok) return refuse(check.reason);
    const { sessionId, op } = req;
    const session = deps.session(sessionId);
    if (!session) return refuse('session-unknown');
    if (session.provider !== 'claude-code') return refuse('not-claude');
    if (SENDING.has(op.t) && !deps.acceptFromPeers()) return refuse('refused-by-setting');
    const from: PeerChatDevice = { deviceId: fromId, deviceName: deps.deviceName(fromId) };
    switch (op.t) {
      case 'tail':
        return { ok: true, state: await view.tail(sessionId, fromId, op.after, op.waitMs) };
      case 'send':
        return sendOp(sendDeps, ring, sessionId, req.askId, from, op.text, op.images);
      case 'resume-send':
        return resumeSendOp(sendDeps, ring, sessionId, req.askId, from, op.text, op.images);
      case 'answer':
        return answerOp(sessionId, from, op);
      case 'interrupt': {
        const r = await answerer.interruptRun(sessionId);
        view.poke(sessionId);
        return r.ok ? { ok: true } : refuse(r.reason);
      }
      case 'cancel': {
        const r = queue.cancel(op.queueId, fromId);
        // 無い（渡した、捨てた）、ほかの PC の預かり、渡している最中は、どれも取り消せない。
        // ほかの PC の預かりの有無は教えない。
        if (r.ok) return { ok: true };
        return refuse(r.reason === 'delivering' ? 'already-answered' : 'queue-expired');
      }
      case 'files': {
        if (!session.cwd) return refuse('session-unknown');
        return { ok: true, files: await deps.files(session.cwd, op.query) };
      }
    }
  }

  /** 同じ askId の再送には、同じ答えを返す（効果を 2 回起こさない）。 */
  const replays = new Map<string, { at: number; reply: Promise<PeerChatBellReply | null> }>();

  async function respond(frame: PeerChatBellAsk): Promise<PeerChatBellReply | null> {
    const ring = await deps.ring();
    if (!ring) return null;
    const route = { requestId: frame.id, from: frame.from, to: deps.deviceId };
    let req: PeerChatRequest;
    try {
      req = await openPeerChat(ring, route, frame.sealed);
    } catch {
      return null;
    }
    let reply: PeerChatReply;
    try {
      reply = await dispatch(ring, req, frame.from);
    } catch (e) {
      console.error('[peer-chat] could not handle the request', e instanceof Error ? e.constructor.name : typeof e);
      reply = refuse('session-unknown');
    }
    let sealed: string;
    try {
      sealed = await sealPeerChatReply(ring, route, reply);
    } catch {
      try { sealed = await sealPeerChatReply(ring, route, refuse('too-large')); } catch { return null; }
    }
    return { t: 'chat-reply', id: frame.id, from: frame.from, sealed };
  }

  return {
    handle(frame) {
      const now = deps.now();
      for (const [k, v] of replays) if (now - v.at > REPLAY_KEEP_MS) replays.delete(k);
      const key = `${frame.from}|${frame.id}`;
      const hit = replays.get(key);
      if (hit) return hit.reply;
      const reply = respond(frame).catch((e: unknown) => {
        console.error('[peer-chat] could not answer', e instanceof Error ? e.constructor.name : typeof e);
        return null;
      });
      replays.set(key, { at: now, reply });
      while (replays.size > REPLAY_MAX) replays.delete(replays.keys().next().value!);
      return reply;
    },
    poke: (sessionId) => view.poke(sessionId),
    turnChanged() {
      for (const sessionId of [...active]) queue.notifyTurnChanged(sessionId);
      view.poke();
    },
    dropSession(sessionId) {
      queue.dropRun(sessionId);
      view.poke(sessionId);
    },
    dispose() {
      offQueue();
      queue.dispose();
      view.dispose();
    },
  };
}
