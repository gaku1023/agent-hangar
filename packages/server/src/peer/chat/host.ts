import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  turnPhaseOf,
  appendPaths,
  checkPeerChatRequest,
  openPeerChat,
  sealPeerChatReply,
  type PeerChatBellAsk,
  type PeerChatAsk,
  type PeerChatBellReply,
  type PeerChatDevice,
  type PeerChatQueued,
  type PeerChatReply,
  type PeerChatRequest,
  type PeerKeyring,
} from '@agent-hangar/shared';
import type { HookChoice } from '../../sessions/hookDecisions.ts';
import { pendingAskFromHook } from './hookCard.ts';
import { createPeerAnswerer, type AnswerPane, type AnswerResult } from './answer.ts';
import { inputEmptyFromCapture } from './inputBox.ts';
import { resumeSendOp, sendOp, type SendDeps } from './hostSend.ts';
import type { PeerChatHostDeps, PeerChatSender } from './hostTypes.ts';
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
 * 頼みは、ほかの PC からは呼び鈴の chat の枠（handle）で、スマホからは phone-chat の枠を mobile/chatHost.ts が開いて（handleRequest）届く。
 * どちらも同じ op の処理を通る。入り切りの設定は送り主の種類（pc か phone）ごとに読む（deps.acceptFrom）。
 *
 * 断る順番。
 * 期限切れ（expired）と本文の大きさ（too-large）→ 会話がこの PC に無い（session-unknown）→ Claude Code でない（not-claude）
 * → 送る系で、送り主の種類の設定が切れている（refused-by-setting）→ スマホからの画像（too-large。最初は文だけを受ける）。
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
 * 覚えは頼みの期限（expiresAt）に少しの余裕（SEEN_MARGIN_MS）を足した時刻まで残し、数では消さない。
 * 期限を過ぎた再送は、覚えが無くても expired で断られるので、時計のずれの幅までは延ばさない。
 * 実行の覚えが上限に達したら、その頼み主の新しい頼みを rate で断る（生きている覚えを追い出して、再送を通さないため）。
 * 上限は、Worker が 1 分に通す回数（120）を、期限までの 65 秒ほどの寿命で保てる数にする（120 回 × 65 秒 ÷ 60 秒 = 130）。
 * 読むだけの頼み（tail、files）は、SEEN_READ_KEEP_MS だけ覚える。見張りは 2 秒おきに頼むので、忙しい会話が覚えを埋めない。
 * 断りの覚え（答えが小さい）は、別の上限を持つ。
 */
const SEEN_PER_SENDER = 160;
/** 覚えを期限より先まで残す余裕。 */
const SEEN_MARGIN_MS = 5_000;
/** 読むだけの頼みの覚えの寿命。 */
const SEEN_READ_KEEP_MS = 30_000;
const SEEN_REFUSALS_PER_SENDER = 512;

export type PeerChatHost = {
  /**
   * 呼び鈴の chat の枠に答える。
   * 開けない頼みは null（答えない）。
   * 投げない。
   */
  handle(frame: PeerChatBellAsk): Promise<PeerChatBellReply | null>;
  /**
   * 封を開く道と封じる道を呼び手が持つ頼み（スマホの入口、mobile/chatHost.ts）に答える。
   * open が null を返すか投げたら答えない（null）。seal が投げたら too-large の断りを封じ直し、それも投げたら null。
   * 戻りは封じた答え。投げない。
   */
  handleRequest(sender: PeerChatSender, id: string, open: () => Promise<PeerChatRequest | null>, seal: (reply: PeerChatReply) => Promise<string>): Promise<string | null>;
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
  /**
   * この PC の帯の「中断して渡す」。走っているターンに Escape を打ち、先頭の預かりをターンを待たずに渡す。
   * 預かりが無ければ queue-expired、札が出ていれば ask-mismatch で断る。
   */
  rush(sessionId: string): Promise<PeerChatReply>;
  /**
   * この PC の中から、この PC の会話の札に答える口（統括の answer_ask、docs/design.md「統括」）。
   * ほかの PC の答えと同じ答え手と記録を通すので、同じ札に 2 度は打たず、先に答えた方が勝つ。
   * ほかの PC からの頼みの入り切り（peerChatAcceptFromPeers）には縛られない。答えてよいかの判断は呼び手が持つ。
   */
  local: PeerChatLocal;
  dispose(): void;
};

export type PeerChatLocal = {
  /** いま出ている札（ほかの PC に見せるのと同じ askId）。この PC の Claude Code の会話でなければ、または札が無ければ null。 */
  currentAsk(sessionId: string): PeerChatAsk | null;
  /** 札が askId と同じと確かめてから keys と text で答える。答えた PC はこの PC として記録する。 */
  answer(sessionId: string, askId: string, keys: string[], text?: string): Promise<AnswerResult>;
};

const refuse = (reason: Extract<PeerChatReply, { ok: false }>['reason']): PeerChatReply => ({ ok: false, reason });
/**
 * 送り主の種類の設定（peerChatAcceptFromPeers か phoneChatAccept）が切れていると断る op。
 * cancel は入れない（送り主が自分の預かりを取り戻すだけで、この PC の入力には触れない。
 * 設定を切ったあとも、預けた文を取り戻せるようにする）。
 */
const SENDING: ReadonlySet<PeerChatRequest['op']['t']> = new Set(['send', 'answer', 'interrupt', 'resume-send', 'rush']);
/** 中断（Escape）を打ってから、急がせを始めるまでの間。Claude が中断を受けて入力欄を空けるのを待つ。 */
const RUSH_AFTER_ESCAPE_MS = 300;

export function createPeerChatHost(deps: PeerChatHostDeps): PeerChatHost {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const paneOf = (sessionId: string) => {
    const run = deps.run(sessionId);
    return run ? deps.pane(run.tmuxName) : null;
  };
  const turnState = (sessionId: string): TurnState => {
    const s = deps.session(sessionId);
    if (!s || s.live === null || !deps.run(sessionId)) return 'stopped';
    // 裏の作業だけが動いている間は、本体は入力を受け付けているので、止まっているのと同じに扱う。
    return turnPhaseOf({ status: s.live, aside: s.aside }) === 'aside' ? 'idle' : s.live;
  };
  const pathsByQueue = new Map<string, string[]>();
  /**
   * 次に預かる文の画像のパス。
   * newId が預かりの ID と結び付ける（add の中で同期に呼ばれる）。
   */
  const staged: { paths: string[] | null } = { paths: null };
  const newId = deps.newId ?? randomUUID;
  const active = new Set<string>();
  /**
   * スマホの送り主の ID。スマホの入口から頼みが届いたときに覚える。
   * 送り主の ID は Worker が端末トークンで決めるので、PC の ID とスマホの ID は重ならず、頼みの中身では名乗れない。
   * 預かりを渡す直前の確かめ（deliver）と預かりの見直し（accepting）が、送り主の種類を引くのに使う。
   */
  const phones = new Set<string>();
  const acceptsSender = (fromId: string): boolean => deps.acceptFrom(phones.has(fromId) ? 'phone' : 'pc');

  const queue: PeerQueue = new PeerQueue({
    now: deps.now,
    turnState,
    accepting: acceptsSender,
    inputEmpty: async (sessionId) => {
      const cap = await paneOf(sessionId)?.captureStyled();
      return cap != null && inputEmptyFromCapture(cap);
    },
    // 貼る直前にもう一度、入力欄が空であることを確かめる（人が打ち始めたら渡さず、預かりに戻す）。
    deliver: async (sessionId, text, _images, queueId, fromId) => {
      // 預けたあとに送り主の種類の設定が切れたら、渡さない（次の確認で捨てて、送り主に文を返す）。
      if (!acceptsSender(fromId)) return false;
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
    ...(deps.hookDecisions ? { hookAsk: (sessionId: string) => { const d = deps.hookDecisions!.peek(sessionId); return d ? pendingAskFromHook(d, deps.session(sessionId)?.permission?.description ?? null) : null; } } : {}),
  });

  const answerer = createPeerAnswerer({
    pane: (sessionId): AnswerPane | null => paneOf(sessionId),
    // ファイルの道具の札は cwd からの相対のパスを出すので、cwd で絶対にして突き合わせる。
    cwd: (sessionId) => deps.session(sessionId)?.cwd || null,
    now: deps.now,
    ...(deps.hookDecisions ? { hook: { decide: (runId: string, ask: PeerChatAsk, choice: HookChoice) => deps.hookDecisions!.decide(runId, ask, choice), delivered: (id: string) => deps.hookDecisions!.isDelivered(id), withdraw: (id: string) => { deps.hookDecisions!.withdraw(id); } } } : {}),
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

  /**
   * 中断して渡す。by を渡せばその預かり（送った PC だけ）、省けば先頭（この PC の帯）。
   * 預かりを確かめてから Escape を打ち、少し待ってから急がせる。先に急がせると、Escape の前に文を貼ってしまう。
   * 札が出ているとき（Escape が断りになる）は ask-mismatch で断り、何も打たない。
   */
  async function rush(sessionId: string, by?: { queueId: string; byDeviceId: string }): Promise<PeerChatReply> {
    const list = queue.list(sessionId);
    const item = by ? list.find((q) => q.queueId === by.queueId) : list[0];
    if (!item || item.state !== 'waiting' || (by && item.from.deviceId !== by.byDeviceId)) return refuse('queue-expired');
    const r = await answerer.interruptRun(sessionId);
    if (!r.ok) return refuse(r.reason);
    if (r.sent) await sleep(RUSH_AFTER_ESCAPE_MS);
    const q = queue.rush(sessionId, by);
    view.poke(sessionId);
    return q.ok ? { ok: true } : refuse('queue-expired');
  }

  /** ほかの PC からの答えと、この PC の中からの答え（local.answer）が通る道。 */
  async function answerCurrent(sessionId: string, from: PeerChatDevice, askId: string, keys: string[], text: string | undefined): Promise<AnswerResult> {
    // 手元で答えた札が、まだ tail に見られていなくても、記録にしてから見る。
    view.observe(sessionId);
    // 同じ札に先に答えた PC があれば、画面を見るまでもなく断る（札が閉じた後に遅れて来た答えも）。
    if (view.answeredAsk(askId)) return { ok: false, reason: 'already-answered' };
    const current = view.currentAsk(sessionId);
    if (!current) return { ok: false, reason: 'ask-mismatch' };
    // 拠り所が決まって askId が言い換わった札には、言い換え前の askId で来た答えを、今の札のものとして受ける。
    if (view.resolveAskId(askId, current.askId) !== current.askId) return { ok: false, reason: 'ask-mismatch' };
    if (current.askId !== askId && view.answeredAsk(current.askId)) return { ok: false, reason: 'already-answered' };
    const asked = view.askItem(sessionId, current.askId);
    const r = await answerer.answerAsk(sessionId, current, keys, text);
    if (!r.ok) return r;
    if (asked) view.recordAnswer(sessionId, asked, from, r.label);
    view.poke(sessionId);
    return r;
  }

  async function answerOp(sessionId: string, from: PeerChatDevice, op: Extract<PeerChatRequest['op'], { t: 'answer' }>): Promise<PeerChatReply> {
    const r = await answerCurrent(sessionId, from, op.askId, op.keys, op.text);
    return r.ok ? { ok: true } : refuse(r.reason);
  }

  /** この PC が持ち主の Claude Code の会話か（dispatch の断りと同じ条件。入り切りの設定は見ない）。 */
  const ownedHere = (sessionId: string): boolean => {
    const session = deps.session(sessionId);
    return !!session && session.provider === 'claude-code' && !session.lock && !session.newerElsewhere && !session.remoteOnly && !session.takenOver;
  };

  const local: PeerChatLocal = {
    currentAsk(sessionId) {
      if (!ownedHere(sessionId)) return null;
      view.observe(sessionId);
      return view.currentAsk(sessionId);
    },
    answer(sessionId, askId, keys, text) {
      if (!ownedHere(sessionId)) return Promise.resolve({ ok: false, reason: 'session-unknown' });
      return answerCurrent(sessionId, { deviceId: deps.deviceId, deviceName: deps.deviceName(deps.deviceId) }, askId, keys, text);
    },
  };

  async function dispatch(ring: PeerKeyring | null, req: PeerChatRequest, sender: PeerChatSender): Promise<PeerChatReply> {
    const fromId = sender.id;
    const { sessionId, op } = req;
    const session = deps.session(sessionId);
    if (!session) return refuse('session-unknown');
    if (session.provider !== 'claude-code') return refuse('not-claude');
    // この PC が会話の持ち主でなければ（ほかの PC で動いている、続きが新しい、本文が無い、引き継がれた）、手元の古い写しを見せも動かしもしない。
    if (session.lock || session.newerElsewhere || session.remoteOnly || session.takenOver) return refuse(op.t === 'resume-send' ? 'resume-failed' : 'session-unknown');
    if (SENDING.has(op.t) && !deps.acceptFrom(sender.kind)) return refuse('refused-by-setting');
    // スマホからは、まず文だけを受ける（画像は、受信箱の素の caps に印を載せてから足す）。
    if (sender.kind === 'phone' && (op.t === 'send' || op.t === 'resume-send') && op.images.length > 0) return refuse('too-large');
    const from: PeerChatDevice = { deviceId: fromId, deviceName: sender.name ?? deps.deviceName(fromId) };
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
      case 'rush':
        return rush(sessionId, { queueId: op.queueId, byDeviceId: fromId });
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
   * 覚えは expiresAt に少しの余裕を足した時刻まで残す（読むだけの頼みは短く）。その後の再送は期限切れで断られるので、隙間は無い。
   * 数は頼み主ごとに数える。refusal は、答えが小さい断りの覚えで、実行の覚えとは別の上限を持つ。
   */
  const seen = new Map<string, { from: string; until: number; refusal: boolean; reply: Promise<string | null> }>();
  const countOf = (from: string, refusal: boolean): number => {
    let n = 0;
    for (const v of seen.values()) if (v.from === from && v.refusal === refusal) n++;
    return n;
  };

  const kind = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

  /** 答えを封じる道。封じられなければ too-large の断りを封じ直し、それも駄目なら null（答えない）。 */
  type Sealer = (reply: PeerChatReply) => Promise<string>;
  async function sealOrRefuse(sealer: Sealer, reply: PeerChatReply): Promise<string | null> {
    try {
      return await sealer(reply);
    } catch {
      try { return await sealer(refuse('too-large')); } catch { return null; }
    }
  }

  /**
   * 開けた頼みに答える（ほかの PC とスマホが分け合う本体）。
   * ring は PC どうしの鍵の束で、画像を開くのに使う。スマホの頼みでは null（画像を受けない）。
   */
  function respondTo(sender: PeerChatSender, id: string, req: PeerChatRequest, ring: PeerKeyring | null, sealer: Sealer): Promise<string | null> {
    if (sender.kind === 'phone') phones.add(sender.id);
    // ここから先は同期で、覚えの確かめと登録の間に別の頼みが割り込まない。
    const from = sender.id;
    const key = `${from}|${id}`;
    const t = deps.now();
    for (const [k, v] of seen) if (t > v.until) seen.delete(k);
    const hit = seen.get(key);
    if (hit) return hit.reply;
    // 覚えは期限の少し先まで残す（期限を過ぎた再送は expired で断られる）。時計のずれの幅までは延ばさない（延ばすと、忙しい見張りの覚えが上限を埋める）。
    // 読むだけの頼み（tail、files）は、再送されても害が無いので、短い間だけ覚える。
    const keep = req.expiresAt + SEEN_MARGIN_MS;
    const until = req.op.t === 'tail' || req.op.t === 'files' ? Math.min(keep, t + SEEN_READ_KEEP_MS) : keep;
    /** 断りを覚えて返す。覚えの上限に達していれば、覚えずに返す（頼み主 1 台が覚えを埋め尽くせないように）。 */
    const refused = (r: PeerChatReply): Promise<string | null> => {
      const reply = sealOrRefuse(sealer, r);
      if (countOf(from, true) < SEEN_REFUSALS_PER_SENDER) seen.set(key, { from, until: keep, refusal: true, reply });
      return reply;
    };
    const check = checkPeerChatRequest(req, t);
    if (!check.ok) {
      // 期限が遠い未来の頼みは、時がたてば通るようになる。覚えて、再送を断り続ける。
      return check.reason === 'expired' && req.expiresAt > t ? refused(refuse('expired')) : sealOrRefuse(sealer, refuse(check.reason));
    }
    if (countOf(from, false) >= SEEN_PER_SENDER) return refused(refuse('rate'));
    const reply = (async (): Promise<string | null> => {
      let r: PeerChatReply;
      try {
        r = await dispatch(ring, req, sender);
      } catch (e) {
        // 想定外の失敗。画面が「PC がつながらない」と取り違えないよう、専用の断り host-error で返す。
        console.error('[peer-chat] request failed inside the host', req.op.t, kind(e));
        r = refuse('host-error');
      }
      return sealOrRefuse(sealer, r);
    })();
    seen.set(key, { from, until, refusal: false, reply });
    return reply;
  }

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
    const sealed = await respondTo({ id: frame.from, kind: 'pc' }, frame.id, req, ring, (r) => sealPeerChatReply(ring, route, r));
    return sealed === null ? null : { t: 'chat-reply', id: frame.id, from: frame.from, sealed };
  }

  async function respondPhone(sender: PeerChatSender, id: string, open: () => Promise<PeerChatRequest | null>, sealer: Sealer): Promise<string | null> {
    let req: PeerChatRequest | null;
    try {
      req = await open();
    } catch {
      return null;
    }
    if (!req) return null;
    return respondTo(sender, id, req, null, sealer);
  }

  return {
    handle(frame) {
      return respond(frame).catch((e: unknown) => {
        console.error('[peer-chat] could not answer', kind(e));
        return null;
      });
    },
    handleRequest(sender, id, open, sealer) {
      return respondPhone(sender, id, open, sealer).catch((e: unknown) => {
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
    rush: (sessionId) => (ownedHere(sessionId) ? rush(sessionId) : Promise.resolve(refuse('session-unknown'))),
    local,
    dispose() {
      offQueue();
      queue.dispose();
      view.dispose();
    },
  };
}
