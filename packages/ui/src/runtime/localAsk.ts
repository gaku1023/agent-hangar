import type { Translate } from '@agent-hangar/shared';
import { localAnsweredLine } from '../presenters/localAsk.ts';
import { askAnswered, askAnswerFailed, askAnswerStarted, askSettled } from '../store/localAsk.ts';
import type { Store } from '../store/store.ts';

/** POST /api/sessions/:id/ask/answer の 200 の本文。 */
export type LocalAskAnswerResult = { ok: true; label: string } | { ok: false; reason: string; sent?: boolean };

/** 画面からの操作。Mediator が localAsk の効果にして渡す（mediator/peerChat.ts）。 */
export type LocalAskCommand =
  | { op: 'answer'; sessionId: string; askId: string; keys: string[]; text?: string }
  | { op: 'settle'; sessionId: string };

export type LocalAskRunnerDeps = {
  answer: (sessionId: string, body: { askId: string; keys: string[]; text?: string }) => Promise<LocalAskAnswerResult>;
  get: () => Store;
  set: (next: Store) => void;
  /** 答えが断られた、または通らなかった。ほかの PC の札への答えと同じ、画面の下の知らせにする。 */
  failed: (sessionId: string) => void;
  /** 答えが通った。前の断りの知らせを外す。 */
  delivered: (sessionId: string) => void;
  t: () => Translate;
};

/**
 * この PC の会話の札に、この画面から答える。
 * 送っている間は pending（押せない）。通れば答えの記録を持ち（札が閉じても片付けるまで見せる）、断られれば押せる形に戻して知らせる。
 * 札の最新の状態は session.ask の知らせで届く（store/localAsk.ts）。
 */
export function createLocalAskRunner(deps: LocalAskRunnerDeps): { run(cmd: LocalAskCommand): Promise<void> } {
  async function answer(cmd: Extract<LocalAskCommand, { op: 'answer' }>): Promise<void> {
    const cur = deps.get().localAsks[cmd.sessionId];
    if (!cur || cur.ask.askId !== cmd.askId || cur.pending) return;
    deps.set(askAnswerStarted(deps.get(), cmd.sessionId, cmd.askId));
    const body = { askId: cmd.askId, keys: cmd.keys, ...(cmd.text ? { text: cmd.text } : {}) };
    let r: LocalAskAnswerResult;
    try { r = await deps.answer(cmd.sessionId, body); } catch { r = { ok: false, reason: 'host-error' }; }
    if (r.ok) {
      const store = deps.get();
      deps.set(askAnswered(store, cmd.sessionId, cmd.askId, localAnsweredLine(deps.t(), cur.ask, r.label, store.device?.name ?? '')));
      deps.delivered(cmd.sessionId);
      return;
    }
    deps.set(askAnswerFailed(deps.get(), cmd.sessionId, cmd.askId));
    deps.failed(cmd.sessionId);
  }
  return {
    run: async (cmd) => {
      if (cmd.op === 'answer') return answer(cmd);
      deps.set(askSettled(deps.get(), cmd.sessionId));
    },
  };
}
