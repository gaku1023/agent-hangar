import { translatorOf } from '../presenters/i18n.ts';
import type { Store } from '../store/store.ts';
import type { Input, State, Step } from './types.ts';

/**
 * ほかの PC の会話を、チャットの形で見て続ける領域。
 * 見張りの段と会話の項目は WebSocket と HTTP の結果で、Runtime しか知らない事実なので、Store が持つ（store/peerChat.ts）。
 * ここは画面の操作を効果にするだけで、State は変えない（cloudMember.ts と同じ作り）。
 * 効果は Runtime が runtime/peerChat.ts の run に渡す。
 * 例外は、この PC から札に答えたのに届かなかった知らせ（peerAnswer.failed）で、どの会話を見ていても気づけるよう、画面の下に知らせを積む。
 * 同じ会話への答えがあとで通ったら（peerAnswer.delivered）、その知らせを外す。
 */
export function peerChatStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind === 'runtime' && input.event.type === 'peerAnswer.failed') {
    const ev = input.event;
    const t = translatorOf(store);
    const name = store.sessions[ev.sessionId]?.name ?? t('common.label.noName');
    // 許可の札で拒否を送ったときもあるので、許可とは書かず「答え」と言う。
    const message = t('peerChat.toast.answerFailed', { name });
    const toast = { id: String(state.nextToastId), level: 'error' as const, message, peerAnswer: ev.sessionId, action: { label: t('peerChat.toast.open'), send: { type: 'session.open' as const, id: ev.sessionId } } };
    return { state: { ...state, toasts: [...state.toasts, toast], nextToastId: state.nextToastId + 1 }, effects: [] };
  }
  if (input.kind === 'runtime' && input.event.type === 'peerAnswer.delivered') {
    // 同じ会話への答えがあとで通ったら、前の断りの知らせは古い。残すと、通ったのに届かなかったと読める。
    const id = input.event.sessionId;
    if (!state.toasts.some((x) => x.peerAnswer === id)) return { state, effects: [] };
    return { state: { ...state, toasts: state.toasts.filter((x) => x.peerAnswer !== id) }, effects: [] };
  }
  if (input.kind !== 'action') return null;
  const a = input.action;
  switch (a.type) {
    case 'peerChat.open': return { state, effects: [{ kind: 'peerChat', command: { op: 'open', sessionId: a.sessionId, viewer: a.viewer } }] };
    case 'peerChat.close': return { state, effects: [{ kind: 'peerChat', command: { op: 'close', sessionId: a.sessionId, viewer: a.viewer } }] };
    case 'peerChat.send': return { state, effects: [{ kind: 'peerChat', command: { op: 'send', sessionId: a.sessionId, body: a.body } }] };
    default: return null;
  }
}
