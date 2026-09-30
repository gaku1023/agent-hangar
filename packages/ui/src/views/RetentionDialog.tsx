import { useEmit } from '../intent/chain.tsx';
import type { RetentionDialogProps } from '../presenters/retentionDialog.ts';
import { Icon } from './primitives/Icon.tsx';
import { UsageBar } from './UsageBar.tsx';

const MARK = { ctx: ' ', add: '+', del: '-' } as const;

/**
 * Claude Code の設定ファイルに書く前の確認。
 * 書く 1 行をそのまま差分で見せ、控えの置き場と、もう消えた会話は戻らないことを並べる。
 */
export function RetentionDialog(props: RetentionDialogProps) {
  const emit = useEmit();
  const close = () => emit({ type: 'overlay.close' });
  return (
    <div className="overlay" onClick={close}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="保持期間の確認" onClick={(e) => e.stopPropagation()}>
        <b className="dialog-title"><Icon name="retention" />{props.title}</b>
        {props.reloaded && <div className="error" role="alert">設定ファイルがほかで変わったので、読み直しました。</div>}
        <div className="muted">{props.lead}</div>
        {props.lines === null
          ? <div className="faint">差分を読み込んでいます</div>
          : (
            <div className="diff mono">
              <div className="diff-path">{props.path}</div>
              {props.lines.map((l, i) => <div key={i} className={`diff-${l.kind}`}>{MARK[l.kind]} {l.text}</div>)}
            </div>
          )}
        {props.bar && <UsageBar {...props.bar} />}
        {props.shrinkNote && <div className="error">{props.shrinkNote}</div>}
        <dl className="kv">
          <dt>控え</dt><dd className="mono">{props.backupDir}</dd>
          {props.otherPcs && <><dt>ほかの PC</dt><dd>設定の同期で、次の取り込み時に届きます</dd></>}
          <dt>もう消えた会話</dt><dd>取り戻せません。これから先の会話が残ります</dd>
        </dl>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={close}>やめる</button>
          <span className="spacer" />
          {props.showOther && <button type="button" className="btn" onClick={() => emit({ type: 'retention.settings' })}>ほかの期間…</button>}
          <button type="button" className="btn btn-primary" disabled={props.writing || props.lines === null} onClick={() => emit({ type: 'retention.write' })}>書き込む</button>
        </div>
      </div>
    </div>
  );
}
