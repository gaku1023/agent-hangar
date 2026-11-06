import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  appendPaths,
  checkPeerChatRequest,
  openPeerChat,
  PEER_CHAT_CLOCK_SKEW_MS,
  sealPeerChatReply,
  type PeerChatBellAsk,
  type PeerChatBellReply,
  type PeerChatDevice,
  type PeerChatQueued,
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

/**
 * 同じ頼み（頼み主と askId）の再送を覚える数の、頼み主ごとの上限。
 * 覚えは頼みの期限（expiresAt）に時計のずれの幅を足した時刻まで残し、数では消さない。
 * 実行の覚えが上限に達したら、その頼み主の新しい頼みを rate で断る（生きている覚えを追い出して、再送を通さないため）。
 * 断りの覚え（答えが小さい）は、別の上限を持つ。
 */
const SEEN_PER_SENDER = 160;
const SEEN_REFUSALS_PER_SENDER = 512;

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
  /** 全部の会話の、いまの預かり（会話の id ごと）。画面を開き直したときの最初の状態に使う。 */
  queued(): Record<string, PeerChatQueued[]>;
  dispose(): void;
};

const refuse = (reason: Extract<PeerChatReply, { ok: false }>['reason']): PeerChatReply => ({ ok: false, reason });
/**
 * 設定 peerChatAcceptFromPeers が切れていると断る op。
 * cancel は入れない（送り主が自分の預かりを取り戻すだけで、この PC の入力には触れない。
 * 設定を切ったあとも、預けた文を取り戻せるようにする）。
 */
const SENDING: ReadonlySet<PeerChatRequest['op']['t']> = new Set(['send', 'answer', 'interrupt', 'resume-send']);

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
  const pathsByQueue = new Map<string, string[]>();
  /**
   * 次に預かる文の画像のパス。
   * newId が預かりの ID と結び付ける（add の中で同期に呼ばれる）。
   */
  const staged: { paths: string[] | null } = { paths: null };
  const newId = deps.newId ?? randomUUID;
  const active = new Set<string>();

  const queue: PeerQueue = new PeerQueue({
    now: deps.now,
    turnState,
    accepting: deps.acceptFromPeers,
    inputEmpty: async (sessionId) => {
      const cap = await paneOf(sessionId)?.captureStyled();
      return cap != null && inputEmptyFromCapture(cap);
    },
    // 貼る直前にもう一度、入力欄が空であることを確かめる（人が打ち始めたら渡さず、預かりに戻す）。
    deliver: async (sessionId, text, _images, queueId) => {
      // 預けたあとに設定が切れたら、渡さない（次の確認で捨てて、送り主に文を返す）。
      if (!deps.acceptFromPeers()) return false;
      const run = deps.run(sessionId);
      const pane = paneOf(sessionId);
      if (!run || !pane) return false;
      const cap = await pane.captureStyled();
      if (cap === null || !inputEmptyFromCapture(cap)) return false;
      await deps.sendInput(sessionId, run.tmuxName, appendPaths(text, pathsByQueue.get(queueId) ?? []));
      return true;
    },
    newId: () => {
      const id = newId();
      if (staged.paths) pathsByQueue.set(id, staged.paths);
      staged.paths = null;
      return id;
    },
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
    self: () => ({ deviceId: deps.deviceId, deviceName: deps.deviceName(deps.deviceId) }),
    // 起動ごとに替わる印。預かりはメモリだけなので、再起動を見る側に知らせる。
    hostId: randomUUID(),
  });

  const answerer = createPeerAnswerer({
    pane: (sessionId): AnswerPane | null => paneOf(sessionId),
    // ファイルの道具の札は cwd からの相対のパスを出すので、cwd で絶対にして突き合わせる。
    cwd: (sessionId) => deps.session(sessionId)?.cwd || null,
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

  const sendDeps: SendDeps = { deps, queue, view, staged, pathsByQueue };

  async function answerOp(sessionId: string, from: PeerChatDevice, op: Extract<PeerChatRequest['op'], { t: 'answer' }>): Promise<PeerChatReply> {
    // 手元で答えた札が、まだ tail に見られていなくても、記録にしてから見る。
    view.observe(sessionId);
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
    const { sessionId, op } = req;
    const session = deps.session(sessionId);
    if (!session) return refuse('session-unknown');
    if (session.provider !== 'claude-code') return refuse('not-claude');
    // この PC が会話の持ち主でなければ（ほかの PC で動いている、続きが新しい、本文が無い、引き継がれた）、手元の古い写しを見せも動かしもしない。
    if (session.lock || session.newerElsewhere || session.remoteOnly || session.takenOver) return refuse(op.t === 'resume-send' ? 'resume-failed' : 'session-unknown');
    if (SENDING.has(op.t) && !deps.acceptFromPeers()) return refuse('refused-by-setting');
    const from: PeerChatDevice = { deviceId: fromId, deviceName: deps.deviceName(fromId) };
    switch (op.t) {
      case 'tail':
        return { ok: true, state: await view.tail(sessionId, fromId, op.after, op.waitMs) };
      case 'send':
        return sendOp(sendDeps, ring, sessionId, req.askId, from, op.text, op.images, op.waitMs);
      case 'resume-send':
        return resumeSendOp(sendDeps, ring, sessionId, req.askId, from, op.text, op.images, op.waitMs);
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
        // どれも queue-expired で返す（もう渡した、または預かりに無い）。already-answered は札の答えの断りで、取り消しには合わない。
        return r.ok ? { ok: true } : refuse('queue-expired');
      }
      case 'files': {
        if (!session.cwd) return refuse('session-unknown');
        return { ok: true, files: await deps.files(session.cwd, op.query) };
      }
    }
  }

  /**
   * 開けた頼みの覚え（頼み主と askId が鍵）。
   * 同じ頼みの再送（捕まえた封の使い回し）には、同じ答えを返し、効果は 1 回にする。
   * 覚えるのは、実行した頼みと、将来のいつか通るようになる頼みの断り（期限が遠い未来の expired、上限での rate）である。
   * 開けない頼みと、期限が過ぎた頼み、大きすぎる頼みは覚えない（どれも何もしないので、再送されても害が無い）。
   * 覚えは expiresAt に時計のずれの幅を足した時刻まで残す。その後の再送は期限切れで断られるので、隙間は無い。
   * 数は頼み主ごとに数える。refusal は、答えが小さい断りの覚えで、実行の覚えとは別の上限を持つ。
   */
  const seen = new Map<string, { from: string; until: number; refusal: boolean; reply: Promise<PeerChatBellReply | null> }>();
  const countOf = (from: string, refusal: boolean): number => {
    let n = 0;
    for (const v of seen.values()) if (v.from === from && v.refusal === refusal) n++;
    return n;
  };

  const kind = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

  async function seal(ring: PeerKeyring, frame: PeerChatBellAsk, reply: PeerChatReply): Promise<PeerChatBellReply | null> {
    const route = { requestId: frame.id, from: frame.from, to: deps.deviceId };
    let sealed: string;
    try {
      sealed = await sealPeerChatReply(ring, route, reply);
    } catch {
      try { sealed = await sealPeerChatReply(ring, route, refuse('too-large')); } catch { return null; }
    }
    return { t: 'chat-reply', id: frame.id, from: frame.from, sealed };
  }

  async function respond(frame: PeerChatBellAsk): Promise<PeerChatBellReply | null> {
    const ring = await deps.ring();
    if (!ring) return null;
    let req: PeerChatRequest;
    try {
      req = await openPeerChat(ring, { requestId: frame.id, from: frame.from, to: deps.deviceId }, frame.sealed);
    } catch {
      return null;
    }
    // ここから先は同期で、覚えの確かめと登録の間に別の頼みが割り込まない。
    const key = `${frame.from}|${frame.id}`;
    const t = deps.now();
    for (const [k, v] of seen) if (t > v.until) seen.delete(k);
    const hit = seen.get(key);
    if (hit) return hit.reply;
    const until = req.expiresAt + PEER_CHAT_CLOCK_SKEW_MS;
    /** 断りを覚えて返す。覚えの上限に達していれば、覚えずに返す（頼み主 1 台が覚えを埋め尽くせないように）。 */
    const refused = (r: PeerChatReply): Promise<PeerChatBellReply | null> => {
      const reply = seal(ring, frame, r);
      if (countOf(frame.from, true) < SEEN_REFUSALS_PER_SENDER) seen.set(key, { from: frame.from, until, refusal: true, reply });
      return reply;
    };
    const check = checkPeerChatRequest(req, t);
    if (!check.ok) {
      // 期限が遠い未来の頼みは、時がたてば通るようになる。覚えて、再送を断り続ける。
      return check.reason === 'expired' && req.expiresAt > t ? refused(refuse('expired')) : seal(ring, frame, refuse(check.reason));
    }
    if (countOf(frame.from, false) >= SEEN_PER_SENDER) return refused(refuse('rate'));
    const reply = (async (): Promise<PeerChatBellReply | null> => {
      let r: PeerChatReply;
      try {
        r = await dispatch(ring, req, frame.from);
      } catch (e) {
        // 想定外の失敗。画面が「PC がつながらない」と取り違えないよう、専用の断り host-error で返す。
        console.error('[peer-chat] request failed inside the host', req.op.t, kind(e));
        r = refuse('host-error');
      }
      return seal(ring, frame, r);
    })();
    seen.set(key, { from: frame.from, until, refusal: false, reply });
    return reply;
  }

  return {
    handle(frame) {
      return respond(frame).catch((e: unknown) => {
        console.error('[peer-chat] could not answer', kind(e));
        return null;
      });
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
    queued: () => queue.listAll(),
    dispose() {
      offQueue();
      queue.dispose();
      view.dispose();
    },
  };
}
