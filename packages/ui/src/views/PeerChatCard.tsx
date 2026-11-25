import type { PeerChatRow } from '../presenters/peerChat.ts';
import { AskCard } from './AskCard.tsx';

type AskRow = Extract<PeerChatRow, { kind: 'ask' }>;

/**
 * 会話の中の許可と質問の札（試作の 3A）。描くのは共用の札の部品（AskCard）である。
 * ほかの PC の会話では元の PC の端末を開けないので、答えられない札は案内の一行のままにする（onOpenTerminal を渡さない）。
 */
export function PeerChatCard(props: { row: AskRow; onAnswer: (askId: string, keys: string[], text?: string) => void }) {
  return <AskCard row={props.row} onAnswer={props.onAnswer} />;
}
