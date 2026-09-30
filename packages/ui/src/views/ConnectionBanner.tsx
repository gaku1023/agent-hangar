import { useEmit } from '../intent/chain.tsx';
import type { ConnProps } from '../presenters/shell.ts';
import { Icon } from './primitives/Icon.tsx';

/**
 * 接続が切れているあいだだけ降りてくる帯。
 * 健全なときは何も出さない。常に出ている報せは読まれなくなり、本当に出したい切断の瞬間まで素通りされるからである。
 * 文言はすべて presenter が組み立てていて、この View は状態を持たない。
 */
export function ConnectionBanner(props: ConnProps) {
  const emit = useEmit();
  if (!props.visible) return null;
  return (
    <div className="conn-banner" role="status">
      <Icon name="unlink" />
      <b>接続が切れています</b>
      {/* 伝えたいのは WebSocket の状態ではなく、その結果として画面が止まっていることである。 */}
      <span>{props.staleLabel}</span>
      <span className="conn-retry">{props.retryLabel}</span>
      <button className="btn btn-sm" onClick={() => emit({ type: 'conn.retry' })}>今すぐ再接続</button>
    </div>
  );
}
