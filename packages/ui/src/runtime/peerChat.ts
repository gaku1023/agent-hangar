import type { PeerChatClientMsg, PeerChatItem, PeerChatOpIn, PeerChatOpResult, PeerChatReason, PeerChatViewDto } from '@agent-hangar/shared';
import { applyState, applyUpdate, clearNotice, emptySlice, rememberMine, restoreText, showNotice, type PeerChatSlice } from '../store/peerChat.ts';

/** 画面からの操作。Mediator が peerChat の効果にして渡す（mediator/peerChat.ts）。 */
export type PeerChatCommand =
  | { op: 'open'; sessionId: string; viewer: string }
  | { op: 'close'; sessionId: string; viewer: string }
  | { op: 'send'; sessionId: string; body: PeerChatOpIn };

export type PeerChatRunnerDeps = {
  /** GET /api/sessions/:id/peer-chat。after は空文字で頭から取る。 */
  open: (sessionId: string, viewer: string, after: string) => Promise<PeerChatViewDto>;
  /** POST /api/sessions/:id/peer-chat/ops。 */
  op: (sessionId: string, body: PeerChatOpIn) => Promise<PeerChatOpResult>;
  /** UI の WebSocket へ送る（つながっていなければ捨てる。つながり直したら rewatch が見張りを張り直す）。 */
  send: (msg: PeerChatClientMsg) => void;
  get: () => Record<string, PeerChatSlice>;
  set: (next: Record<string, PeerChatSlice>) => void;
  /** ms 後に fn を呼ぶ。戻りは取り消し（省けば setTimeout）。worker-outdated の開き直しに使う。 */
  after?: (ms: number, fn: () => void) => () => void;
  /**
   * 札に答えを送った。相手の返事を待たずに、手元で待ちを外す（store/peerAnswer.ts）。live は許可なら busy、拒否なら waiting。
   * 省けば何もしない（試験）。
   */
  hold?: (sessionId: string, askId: string, live: 'busy' | 'waiting') => void;
  /** 手元の見え方を解いて、相手の最新の状態に戻す。答えが届いた確かめが無いまま持っていたら true（届いた、または相手の更新で捨てられていたら false）。 */
  release?: (sessionId: string, askId: string) => boolean;
  /** 答えが届かなかった（断られた、時間切れ）。画面の下の知らせを出す。kind は札の種類。 */
  failed?: (sessionId: string, reason: PeerChatReason | 'answer-timeout', kind: 'permission' | 'question') => void;
};

/** 選んだ答えの文。書いた文があればそれ、無ければ選んだ行の文（複数はつなぐ）。 */
function pickedLabel(s: PeerChatSlice, body: Extract<PeerChatOpIn, { t: 'answer' }>): string {
  const text = (body.text ?? '').trim();
  if (text !== '') return text;
  const ask = s.items.find((i) => i.ask?.askId === body.askId)?.ask;
  return (ask?.options ?? []).filter((o) => body.keys.includes(o.key)).map((o) => o.label).join('、');
}

/** 答えが届かなかった札を、また押せる形に戻す。 */
const unpick = (s: PeerChatSlice, askId: string): PeerChatSlice => {
  const { [askId]: _, ...picked } = s.picked;
  return { ...s, answering: s.answering.filter((a) => a !== askId), picked };
};

/** 答えを送ったあと、相手の状態が動くのを待つ長さ。過ぎても動かなければ、答えが届かなかったとみなす。 */
export const PEER_ANSWER_TIMEOUT_MS = 30_000;

/**
 * 答えたあとの会話の見え方。許可の札で No を選び、文を添えなかったときだけ入力待ち（Claude Code は止まって入力を待つ）。
 * 許可、質問への答え、文を添えた No は、Claude が続けるので実行中にする。
 */
function liveAfterAnswer(item: PeerChatItem | undefined, body: Extract<PeerChatOpIn, { t: 'answer' }>): 'busy' | 'waiting' {
  const ask = item?.ask;
  if (!ask || ask.kind !== 'permission' || (body.text ?? '').trim() !== '') return 'busy';
  const labels = ask.options.filter((o) => body.keys.includes(o.key)).map((o) => o.label.trim());
  return labels.length > 0 && labels.every((l) => /^no\b/i.test(l)) ? 'waiting' : 'busy';
}

/**
 * 最初の同期の前は、Worker の版がまだ分からず、見張りの入口が worker-outdated で断る。
 * 読み取り専用に固定せず、この間隔で開き直す（最後の値を繰り返す）。
 * 入口の確かめは手元の判断だけで、Worker へは頼まない。
 */
const WORKER_RETRY_MS = [5_000, 15_000, 30_000] as const;
/** 開き直す回数の上限（本当に古い Worker なら、いつまでも繰り返さない）。 */
const WORKER_RETRY_MAX = 20;

export type PeerChatRunner = {
  run(cmd: PeerChatCommand): void;
  /** WebSocket がつながり直した。見ている会話の見張りを最後の位置から張り直す（休止中は張らない）。 */
  rewatch(): void;
  /**
   * WebSocket の peerChat.update を Store に入れたあとに呼ぶ。
   * 見張りの途中で worker-outdated の reason が来て読み取り専用になった会話も、最初の問い合わせと同じく、間を空けて開き直す。
   */
  noteUpdate(sessionId: string): void;
  /** 窓が隠れた。見張りを外す（見えない間は元の PC へ頼み続けない）。状態は残す。 */
  pause(): void;
  /** 窓が見えた。外していた見張りを、最後の位置から張り直す。 */
  resume(): void;
};

/**
 * ほかの PC の会話の見張りと操作（設計は trials/peer-chat/DESIGN.md）。
 * 画面を開いたら GET で見張りを始め、動き出したら WebSocket で peerChat.watch を送る。
 * 同じ会話を複数の画面で開いたときは、状態を 1 つ共有し、見ている人を画面ごとに持つ。閉じた画面の分だけ外し、最後の人が閉じたら捨てる。
 * 更新は WebSocket の peerChat.update が運ぶので、Store の反映は store.ts の applyEvent が行う。
 * ここは、最初の答えと、操作の答え（文を入力欄へ戻す、断りの一言、札の再び押せる状態）だけを書く。
 */
export function createPeerChatRunner(deps: PeerChatRunnerDeps): PeerChatRunner {
  let paused = false;
  const slice = (id: string): PeerChatSlice | undefined => deps.get()[id];
  const write = (id: string, f: (s: PeerChatSlice) => PeerChatSlice): void => {
    const cur = slice(id);
    if (!cur) return;
    const next = f(cur);
    if (next !== cur) deps.set({ ...deps.get(), [id]: next });
  };
  const watch = (sessionId: string, viewer: string, after: string | null): void => { if (!paused) deps.send({ type: 'peerChat.watch', sessionId, viewer, after }); };
  const failure = (): PeerChatReason => 'host-error';
  const after = deps.after ?? ((ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  const retryTimers = new Map<string, () => void>();
  const retryCount = new Map<string, number>();
  const stopRetry = (sessionId: string): void => {
    retryTimers.get(sessionId)?.();
    retryTimers.delete(sessionId);
  };

  /** worker-outdated で読み取り専用になった会話を、間を空けて開き直す（Worker の版が分かれば入れる）。 */
  function retryLater(sessionId: string): void {
    stopRetry(sessionId);
    const n = retryCount.get(sessionId) ?? 0;
    if (n >= WORKER_RETRY_MAX) return;
    retryCount.set(sessionId, n + 1);
    retryTimers.set(sessionId, after(WORKER_RETRY_MS[Math.min(n, WORKER_RETRY_MS.length - 1)]!, () => {
      retryTimers.delete(sessionId);
      const cur = slice(sessionId);
      if (!cur || cur.phase !== 'fallback' || cur.fallback !== 'worker-outdated' || cur.viewers.length === 0) return;
      // 休止中は張らない。戻ったときの開き直しは、次の周に任せる。
      if (paused) { retryLater(sessionId); return; }
      void load(sessionId, cur.viewers[0]!, true);
    }));
  }

  /** 最初の問い合わせ（GET）と、その答えの取り込み。retry のときは fallback から入り直す。 */
  async function load(sessionId: string, viewer: string, retry: boolean): Promise<void> {
    let r: PeerChatViewDto;
    try { r = await deps.open(sessionId, viewer, ''); } catch { r = { ok: false, reason: 'unreachable' }; }
    // 待つ間に、全員が閉じた（状態が消えた）か、別の答えで済んだ。
    const now = slice(sessionId);
    if (!now || now.phase !== (retry ? 'fallback' : 'loading')) return;
    if (!r.ok) {
      write(sessionId, (s) => ({ ...s, phase: 'fallback', fallback: r.reason, device: r.device ?? s.device }));
      if (r.reason === 'worker-outdated') retryLater(sessionId);
      return;
    }
    retryCount.delete(sessionId);
    write(sessionId, (s) => applyUpdate({ ...s, device: r.device }, r.update));
    if (r.update.reason) return;
    const next = slice(sessionId);
    for (const v of next?.viewers ?? []) watch(sessionId, v, r.update.cursor);
  }

  async function open(sessionId: string, viewer: string): Promise<void> {
    const cur = slice(sessionId);
    if (cur) {
      // 2 つ目以降の画面。同じ画面が開き直しても、見ている人は 1 人ずつ。
      if (cur.viewers.includes(viewer)) return;
      write(sessionId, (s) => ({ ...s, viewers: [...s.viewers, viewer] }));
      // 見張りが動いていれば、WebSocket の watch だけで加われる。読み込み中は、最初の答えが来たときに全員ぶん張る。
      if (cur.phase === 'live') watch(sessionId, viewer, cur.cursor);
      return;
    }
    deps.set({ ...deps.get(), [sessionId]: emptySlice(viewer) });
    retryCount.delete(sessionId);
    await load(sessionId, viewer, false);
  }

  function close(sessionId: string, viewer: string): void {
    const s = slice(sessionId);
    if (!s || !s.viewers.includes(viewer)) return;
    // 見張りを張っていなかった（休止中、読み込み中、fallback）ときの unwatch は、サーバにとって何もしない頼みである。
    deps.send({ type: 'peerChat.unwatch', sessionId, viewer });
    const viewers = s.viewers.filter((v) => v !== viewer);
    const rest = { ...deps.get() };
    if (viewers.length === 0) { delete rest[sessionId]; stopRetry(sessionId); retryCount.delete(sessionId); }
    else rest[sessionId] = { ...s, viewers };
    deps.set(rest);
  }

  /** 答えの見え方の時間切れ（会話と札ごと）。同じ札へ送り直したら前の分は取り消す。 */
  const answerTimers = new Map<string, () => void>();

  /** 答えを送る前に、手元で待ちを外し、時間切れを数え始める。札の種類を返す。 */
  function holdAnswer(sessionId: string, body: Extract<PeerChatOpIn, { t: 'answer' }>): 'permission' | 'question' {
    const item = slice(sessionId)?.items.find((i) => i.ask?.askId === body.askId);
    const kind = item?.ask?.kind ?? 'permission';
    deps.hold?.(sessionId, body.askId, liveAfterAnswer(item, body));
    const key = `${sessionId}\n${body.askId}`;
    answerTimers.get(key)?.();
    answerTimers.set(key, after(PEER_ANSWER_TIMEOUT_MS, () => {
      answerTimers.delete(key);
      // 相手の状態が動いて見え方が捨てられていれば、答えは届いている。
      if (!deps.release?.(sessionId, body.askId)) return;
      write(sessionId, (s) => showNotice(unpick(s, body.askId), 'answer-timeout'));
      deps.failed?.(sessionId, 'answer-timeout', kind);
    }));
    return kind;
  }

  /** 答えが断られた。見え方を解いて、画面の下に知らせる（札の近くの理由と、また押せる状態は下の書き込みが戻す）。 */
  function answerFailed(sessionId: string, askId: string, reason: PeerChatReason, kind: 'permission' | 'question'): void {
    const key = `${sessionId}\n${askId}`;
    answerTimers.get(key)?.();
    answerTimers.delete(key);
    deps.release?.(sessionId, askId);
    if (reason !== 'refused-by-setting') deps.failed?.(sessionId, reason, kind);
  }

  async function send(sessionId: string, body: PeerChatOpIn): Promise<void> {
    const sends = body.t === 'send' || body.t === 'resume-send';
    const text = sends ? body.text : '';
    const images = sends ? body.images ?? [] : [];
    const queuedText = body.t === 'cancel' ? slice(sessionId)?.queued.find((q) => q.queueId === body.queueId)?.text ?? null : null;
    write(sessionId, (s) => {
      const base = clearNotice(s);
      if (sends) return { ...base, sending: true };
      if (body.t === 'answer') return { ...base, answering: base.answering.includes(body.askId) ? base.answering : [...base.answering, body.askId], picked: { ...base.picked, [body.askId]: pickedLabel(base, body) } };
      if (body.t === 'rush') return { ...base, rushing: base.rushing.includes(body.queueId) ? base.rushing : [...base.rushing, body.queueId] };
      return base;
    });
    const askKind = body.t === 'answer' ? holdAnswer(sessionId, body) : 'permission';
    let r: PeerChatOpResult;
    try { r = await deps.op(sessionId, body); } catch { r = { ok: false, reason: failure() }; }
    if (body.t === 'answer' && !r.ok) answerFailed(sessionId, body.askId, r.reason, askKind);
    if (!slice(sessionId)) return;
    if (!r.ok) {
      write(sessionId, (s) => {
        // 設定で受け付けない PC には、このあとも送れない。入力欄と札を閉じ、会話は読めるままにする。
        const locked = r.reason === 'refused-by-setting' || s.locked;
        let done: PeerChatSlice = { ...s, sending: false, locked };
        // 断られた答えの札は、また押せるようにする。
        if (body.t === 'answer') done = unpick(done, body.askId);
        if (body.t === 'rush') done = { ...done, rushing: done.rushing.filter((q) => q !== body.queueId) };
        // 取り消しが間に合わなかった（もう渡した、または預かりに無い）ときは、渡せなかったとは言わない。
        if (!(r.reason === 'refused-by-setting')) done = showNotice(done, body.t === 'cancel' && r.reason === 'queue-expired' ? 'cancel-late' : r.reason);
        // 送れなかった文は、入力欄へ戻す（画像も、置き場の名前のまま戻す）。
        return sends ? restoreText(done, text, images) : done;
      });
      return;
    }
    write(sessionId, (s) => {
      let n: PeerChatSlice = { ...s, sending: false };
      if (r.state) n = applyState(n, r.state);
      if (sends && r.queueId) n = rememberMine(n, r.queueId, text);
      if (body.t === 'cancel') {
        // 預かりを取り消せたので、文を入力欄へ戻す。画面の預かりの表示も、更新を待たずに外す。
        n = { ...n, queued: n.queued.filter((q) => q.queueId !== body.queueId) };
        if (queuedText !== null) n = restoreText(n, queuedText);
      }
      return n;
    });
  }

  const rewatch = (): void => {
    for (const [id, s] of Object.entries(deps.get())) if (s.phase === 'live') for (const v of s.viewers) watch(id, v, s.cursor);
  };

  return {
    run(cmd) {
      switch (cmd.op) {
        case 'open': void open(cmd.sessionId, cmd.viewer); return;
        case 'close': close(cmd.sessionId, cmd.viewer); return;
        case 'send': void send(cmd.sessionId, cmd.body); return;
      }
    },
    rewatch,
    noteUpdate(sessionId) {
      const s = slice(sessionId);
      if (s && s.phase === 'fallback' && s.fallback === 'worker-outdated' && !retryTimers.has(sessionId)) retryLater(sessionId);
    },
    pause() {
      if (paused) return;
      paused = true;
      for (const [id, s] of Object.entries(deps.get())) if (s.phase === 'live') for (const v of s.viewers) deps.send({ type: 'peerChat.unwatch', sessionId: id, viewer: v });
    },
    resume() {
      if (!paused) return;
      paused = false;
      rewatch();
    },
  };
}
