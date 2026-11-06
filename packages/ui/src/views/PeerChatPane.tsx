import { useEffect, useRef } from 'react';
import { useBackgroundEmit, useEmit } from '../action/chain.tsx';
import type { PeerChatView } from '../presenters/peerChat.ts';
import { PeerChatComposer } from './PeerChatComposer.tsx';
import { PeerChatLog } from './PeerChatLog.tsx';

/** 画面が振る見ている人の ID（サーバの VIEWER_RE に合う文字だけ）。画面ごとに 1 つ。 */
const newViewer = (): string => `ui-${Math.random().toString(36).slice(2, 12)}`;

/**
 * ほかの PC の会話の見張りを張る。会話の画面が開いている間だけ生き、閉じる、別の会話へ移るで外す。
 * 見張りは裏の読み込みなので、利用者の操作の道（useEmit）とは分ける。
 */
export function usePeerChatWatch(sessionId: string, enabled: boolean): void {
  const bg = useBackgroundEmit();
  const viewer = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    viewer.current ??= newViewer();
    bg({ type: 'peerChat.open', sessionId, viewer: viewer.current });
    return () => bg({ type: 'peerChat.close', sessionId });
  }, [bg, sessionId, enabled]);
}

/**
 * ほかの PC の Claude Code の会話を、チャットの形で見て続ける本体（試作の 1A、2A、3A、4A）。
 * 上に PC の名前と状態の 1 行、真ん中に会話の列、下に入力欄を置く。
 * 描き分けは presenters/peerChat.ts が決める。ここは決まった値を並べ、操作を UiAction にして出すだけである。
 */
export function PeerChatPane(props: { view: PeerChatView }) {
  const emit = useEmit();
  const { view } = props;
  const id = view.sessionId;
  return (
    <div className="pchat-pane" data-state={view.status ?? 'loading'}>
      <div className="pchat-bar">
        <span className="pchat-pill">{view.device}</span>
        <span className="pchat-state"><span className="pchat-dot" data-tone={view.tone} aria-hidden="true" />{view.statusLabel}</span>
      </div>
      <PeerChatLog rows={view.rows} loading={view.loading}
        onCancel={(queueId) => emit({ type: 'peerChat.send', sessionId: id, body: { t: 'cancel', queueId } })}
        onAnswer={(askId, keys, text) => emit({ type: 'peerChat.send', sessionId: id, body: { t: 'answer', askId, keys, ...(text ? { text } : {}) } })} />
      <PeerChatComposer view={view} onSend={(body) => emit({ type: 'peerChat.send', sessionId: id, body })} onTakeOver={() => emit({ type: 'session.resumeHere.open', id })} />
    </div>
  );
}
