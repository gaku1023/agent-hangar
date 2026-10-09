import { useEmit } from '../intent/chain.tsx';
import { DESKTOP_LOG_PATH, type ConnProps } from '../presenters/shell.ts';
import { CopyButton } from './primitives/CommandLine.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/**
 * 接続が切れているあいだだけ降りてくる帯。
 * 健全なときは何も出さない。常に出ている報せは読まれなくなり、本当に出したい切断の瞬間まで素通りされるからである。
 * 文言はすべて presenter が組み立てていて、この View は状態を持たない。
 * 再接続が続けて失敗したら（hard）、同じ帯のまま濃い赤にして再起動を促す（初回と障害の B1）。
 */
export function ConnectionBanner(props: ConnProps) {
  const emit = useEmit();
  const t = useT();
  if (!props.visible) return null;
  if (props.hard) {
    return (
      <div className="conn-banner" data-hard="true" role="status" aria-label={t('conn.banner.label')}>
        <Icon name="warning" />
        <b>{t('conn.hard.title')}</b>
        {props.desktop
          ? (
            <>
              <span>{t('conn.hard.restartPrompt')}</span>
              <button className="btn btn-sm" onClick={() => emit({ type: 'shell.openLog' })}><Icon name="log" />{t('conn.hard.openLog')}</button>
              <button className="btn btn-sm" onClick={() => emit({ type: 'shell.restart' })}><Icon name="restart" />{t('conn.hard.restart')}</button>
            </>
          )
          : (
            <>
              {/* 殻の無いブラウザからはアプリを起こし直せない。場所を写して、ログを自分で開けるようにする。 */}
              <span>{t('conn.hard.browserHint', { path: DESKTOP_LOG_PATH })}</span>
              <CopyButton text={DESKTOP_LOG_PATH} name={t('conn.hard.logName')} label={t('conn.hard.copyLocation')} />
            </>
          )}
      </div>
    );
  }
  return (
    <div className="conn-banner" role="status" aria-label={t('conn.banner.label')}>
      <Icon name="unlink" />
      <b>{t('conn.lost.title')}</b>
      {/* 伝えたいのは WebSocket の状態ではなく、その結果として画面が止まっていることである。 */}
      <span>{props.staleLabel}</span>
      <span className="conn-retry">{props.retryLabel}</span>
      <button className="btn btn-sm" onClick={() => emit({ type: 'conn.retry' })}>{t('conn.lost.retryNow')}</button>
    </div>
  );
}
