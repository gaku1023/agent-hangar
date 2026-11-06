import type { Input, State, Step } from './types.ts';

/**
 * ほかの PC の会話を、チャットの形で見て続ける領域。
 * 見張りの段と会話の項目は WebSocket と HTTP の結果で、Runtime しか知らない事実なので、Store が持つ（store/peerChat.ts）。
 * ここは画面の操作を効果にするだけで、State は変えない（cloudMember.ts と同じ作り）。
 * 効果は Runtime が runtime/peerChat.ts の run に渡す。
 */
export function peerChatStep(state: State, input: Input): Step | null {
  if (input.kind !== 'action') return null;
  const a = input.action;
  switch (a.type) {
    case 'peerChat.open': return { state, effects: [{ kind: 'peerChat', command: { op: 'open', sessionId: a.sessionId, viewer: a.viewer } }] };
    case 'peerChat.close': return { state, effects: [{ kind: 'peerChat', command: { op: 'close', sessionId: a.sessionId, viewer: a.viewer } }] };
    case 'peerChat.send': return { state, effects: [{ kind: 'peerChat', command: { op: 'send', sessionId: a.sessionId, body: a.body } }] };
    default: return null;
  }
}
