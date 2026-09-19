import { useEmit } from '../intent/chain.tsx';
import type { ConfirmRequest } from '../mediator/types.ts';
import { Icon } from './primitives/Icon.tsx';

/** 本文の大きさ。KB で足りなくなる長さの本文があるので MB まで見る。 */
const sizeLabel = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);

/**
 * 取り消せない上書きの確認。
 * いまは「この PC で再開」で手元の本文を他端末の本文に置き換える場面だけを扱う。
 * どちらを残すかを決めるのは利用者なので、View は大きさを並べるだけで判断をしない。
 */
export function ConfirmDialog(props: { confirm: ConfirmRequest }) {
  const emit = useEmit();
  const c = props.confirm;
  return (
    <div className="overlay" onClick={() => emit({ type: 'overlay.close' })}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="上書きの確認" onClick={(e) => e.stopPropagation()}>
        <b className="dialog-title"><Icon name="warning" />本文を置き換えますか</b>
        <div className="muted">この PC の本文の方が小さいままです。他の端末の本文で置き換えますか。</div>
        <div>
          <div className="mono faint">この PC の本文 {sizeLabel(c.localSize)}</div>
          <div className="mono faint">他の端末の本文 {sizeLabel(c.remoteSize)}</div>
        </div>
        <div className="faint">置き換える前に ~/.agent-hangar/backups/transcripts/ に控えを取ります。</div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={() => emit({ type: 'overlay.close' })}>やめる</button>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.resumeHere', id: c.sessionId, overwrite: true })}>上書きして再開</button>
        </div>
      </div>
    </div>
  );
}
