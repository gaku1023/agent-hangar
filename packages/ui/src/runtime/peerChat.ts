import type { PeerChatClientMsg, PeerChatOpIn, PeerChatOpResult, PeerChatReason, PeerChatViewDto } from '@agent-hangar/shared';
import { applyState, applyUpdate, clearNotice, emptySlice, rememberMine, restoreText, showNotice, type PeerChatSlice } from '../store/peerChat.ts';

/** 画面からの操作。Mediator が peerChat の効果にして渡す（mediator/peerChat.ts）。 */
export type PeerChatCommand =
  | { op: 'open'; sessionId: string; viewer: string }
  | { op: 'close'; sessionId: string }
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

export type PeerChatRunner = { run(cmd: PeerChatCommand): void; rewatch(): void };

/**
 * ほかの PC の会話の見張りと操作（設計は trials/peer-chat/DESIGN.md）。
 * 画面を開いたら GET で見張りを始め、動き出したら WebSocket で peerChat.watch を送る。
 * 閉じたら peerChat.unwatch を送って捨てる。
 * 更新は WebSocket の peerChat.update が運ぶので、Store の反映は store.ts の applyEvent が行う。
 * ここは、最初の答えと、操作の答え（文を入力欄へ戻す、断りの一言）だけを書く。
 */
export function createPeerChatRunner(deps: PeerChatRunnerDeps): PeerChatRunner {
  const slice = (id: string): PeerChatSlice | undefined => deps.get()[id];
  const write = (id: string, f: (s: PeerChatSlice) => PeerChatSlice): void => {
    const cur = slice(id);
    if (!cur) return;
    const next = f(cur);
    if (next !== cur) deps.set({ ...deps.get(), [id]: next });
  };
  const watch = (sessionId: string, viewer: string, after: string | null): void => deps.send({ type: 'peerChat.watch', sessionId, viewer, after });
  const failure = (): PeerChatReason => 'host-error';

  async function open(sessionId: string, viewer: string): Promise<void> {
    // 同じ画面が開き直しても、見張りは 1 本にする。
    if (slice(sessionId)?.viewer === viewer) return;
    deps.set({ ...deps.get(), [sessionId]: emptySlice(viewer) });
    let r: PeerChatViewDto;
    try { r = await deps.open(sessionId, viewer, ''); } catch { r = { ok: false, reason: 'unreachable' }; }
    // 待つ間に閉じた、または別の画面が開いた。
    if (slice(sessionId)?.viewer !== viewer) return;
    if (!r.ok) { write(sessionId, (s) => ({ ...s, phase: 'fallback', fallback: r.reason, device: r.device ?? s.device })); return; }
    write(sessionId, (s) => applyUpdate({ ...s, device: r.device }, r.update));
    if (!r.update.reason) watch(sessionId, viewer, r.update.cursor);
  }

  function close(sessionId: string): void {
    const s = slice(sessionId);
    if (!s) return;
    deps.send({ type: 'peerChat.unwatch', sessionId, viewer: s.viewer });
    const rest = { ...deps.get() };
    delete rest[sessionId];
    deps.set(rest);
  }

  async function send(sessionId: string, body: PeerChatOpIn): Promise<void> {
    const text = body.t === 'send' || body.t === 'resume-send' ? body.text : '';
    const images = body.t === 'send' || body.t === 'resume-send' ? body.images ?? [] : [];
    const queuedText = body.t === 'cancel' ? slice(sessionId)?.queued.find((q) => q.queueId === body.queueId)?.text ?? null : null;
    const sends = body.t === 'send' || body.t === 'resume-send';
    write(sessionId, (s) => (sends ? { ...clearNotice(s), sending: true } : clearNotice(s)));
    let r: PeerChatOpResult;
    try { r = await deps.op(sessionId, body); } catch { r = { ok: false, reason: failure() }; }
    if (!slice(sessionId)) return;
    if (!r.ok) {
      write(sessionId, (s) => {
        const done = showNotice({ ...s, sending: false }, r.reason);
        // 送れなかった文は、入力欄へ戻す（画像も、置き場の名前のまま戻す）。
        return sends ? restoreText(done, text, images) : done;
      });
      return;
    }
    write(sessionId, (s) => {
      let n: PeerChatSlice = { ...s, sending: false };
      if (r.state) n = applyState(n, r.state);
      if (body.t === 'send' || body.t === 'resume-send') { if (r.queueId) n = rememberMine(n, r.queueId, text); }
      if (body.t === 'cancel') {
        // 預かりを取り消せたので、文を入力欄へ戻す。画面の預かりの表示も、更新を待たずに外す。
        n = { ...n, queued: n.queued.filter((q) => q.queueId !== body.queueId) };
        if (queuedText !== null) n = restoreText(n, queuedText);
      }
      return n;
    });
  }

  return {
    run(cmd) {
      switch (cmd.op) {
        case 'open': void open(cmd.sessionId, cmd.viewer); return;
        case 'close': close(cmd.sessionId); return;
        case 'send': void send(cmd.sessionId, cmd.body); return;
      }
    },
    // WebSocket がつながり直した。サーバは切れた接続の見ている人を外しているので、見ている会話ぶんを張り直す。
    rewatch() {
      for (const [id, s] of Object.entries(deps.get())) if (s.phase === 'live') watch(id, s.viewer, s.cursor);
    },
  };
}
