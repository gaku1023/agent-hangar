import type { PeerChatClientMsg, PeerChatOpIn, PeerChatOpResult, PeerChatReason, PeerChatViewDto } from '@agent-hangar/shared';
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
};

export type PeerChatRunner = {
  run(cmd: PeerChatCommand): void;
  /** WebSocket がつながり直した。見ている会話の見張りを最後の位置から張り直す（休止中は張らない）。 */
  rewatch(): void;
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
    let r: PeerChatViewDto;
    try { r = await deps.open(sessionId, viewer, ''); } catch { r = { ok: false, reason: 'unreachable' }; }
    // 待つ間に、全員が閉じた（状態が消えた）か、別の答えで済んだ。
    const now = slice(sessionId);
    if (!now || now.phase !== 'loading') return;
    if (!r.ok) { write(sessionId, (s) => ({ ...s, phase: 'fallback', fallback: r.reason, device: r.device ?? s.device })); return; }
    write(sessionId, (s) => applyUpdate({ ...s, device: r.device }, r.update));
    if (r.update.reason) return;
    const after = slice(sessionId);
    for (const v of after?.viewers ?? []) watch(sessionId, v, r.update.cursor);
  }

  function close(sessionId: string, viewer: string): void {
    const s = slice(sessionId);
    if (!s || !s.viewers.includes(viewer)) return;
    // 見張りを張っていなかった（休止中、読み込み中、fallback）ときの unwatch は、サーバにとって何もしない頼みである。
    deps.send({ type: 'peerChat.unwatch', sessionId, viewer });
    const viewers = s.viewers.filter((v) => v !== viewer);
    const rest = { ...deps.get() };
    if (viewers.length === 0) delete rest[sessionId];
    else rest[sessionId] = { ...s, viewers };
    deps.set(rest);
  }

  async function send(sessionId: string, body: PeerChatOpIn): Promise<void> {
    const sends = body.t === 'send' || body.t === 'resume-send';
    const text = sends ? body.text : '';
    const images = sends ? body.images ?? [] : [];
    const queuedText = body.t === 'cancel' ? slice(sessionId)?.queued.find((q) => q.queueId === body.queueId)?.text ?? null : null;
    write(sessionId, (s) => {
      const base = clearNotice(s);
      if (sends) return { ...base, sending: true };
      if (body.t === 'answer') return { ...base, answering: base.answering.includes(body.askId) ? base.answering : [...base.answering, body.askId] };
      return base;
    });
    let r: PeerChatOpResult;
    try { r = await deps.op(sessionId, body); } catch { r = { ok: false, reason: failure() }; }
    if (!slice(sessionId)) return;
    if (!r.ok) {
      write(sessionId, (s) => {
        // 設定で受け付けない PC には、このあとも送れない。入力欄と札を閉じ、会話は読めるままにする。
        const locked = r.reason === 'refused-by-setting' || s.locked;
        let done: PeerChatSlice = { ...s, sending: false, locked };
        // 断られた答えの札は、また押せるようにする。
        if (body.t === 'answer') done = { ...done, answering: done.answering.filter((a) => a !== body.askId) };
        if (!(r.reason === 'refused-by-setting')) done = showNotice(done, r.reason);
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
