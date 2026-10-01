import { useEmit } from '../intent/chain.tsx';
import { DESKTOP_LOG_PATH, type ConnProps } from '../presenters/shell.ts';
import { CopyButton } from './primitives/CommandLine.tsx';
import { Icon } from './primitives/Icon.tsx';

/**
 * 接続が切れているあいだだけ降りてくる帯。
 * 健全なときは何も出さない。常に出ている報せは読まれなくなり、本当に出したい切断の瞬間まで素通りされるからである。
 * 文言はすべて presenter が組み立てていて、この View は状態を持たない。
 * 再接続が続けて失敗したら（hard）、同じ帯のまま濃い赤にして再起動を促す（初回と障害の B1）。
 */
export function ConnectionBanner(props: ConnProps) {
  const emit = useEmit();
  if (!props.visible) return null;
  if (props.hard) {
    return (
      <div className="conn-banner" data-hard="true" role="status" aria-label="接続の状態">
        <Icon name="warning" />
        <b>サーバに戻れません</b>
        {props.desktop
          ? (
            <>
              <span>アプリを再起動してください</span>
              <button className="btn btn-sm" onClick={() => emit({ type: 'shell.openLog' })}><Icon name="log" />ログを開く</button>
              <button className="btn btn-sm" onClick={() => emit({ type: 'shell.restart' })}><Icon name="restart" />再起動</button>
            </>
          )
          : (
            <>
              {/* 殻の無いブラウザからはアプリを起こし直せない。場所を写して、ログを自分で開けるようにする。 */}
              <span>{`アプリを再起動してください。ログ: ${DESKTOP_LOG_PATH}`}</span>
              <CopyButton text={DESKTOP_LOG_PATH} name="ログの場所" label="場所をコピー" />
            </>
          )}
      </div>
    );
  }
  return (
    <div className="conn-banner" role="status" aria-label="接続の状態">
      <Icon name="unlink" />
      <b>接続が切れています</b>
      {/* 伝えたいのは WebSocket の状態ではなく、その結果として画面が止まっていることである。 */}
      <span>{props.staleLabel}</span>
      <span className="conn-retry">{props.retryLabel}</span>
      <button className="btn btn-sm" onClick={() => emit({ type: 'conn.retry' })}>今すぐ再接続</button>
    </div>
  );
}
