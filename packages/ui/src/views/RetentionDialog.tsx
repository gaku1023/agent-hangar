import { useEmit } from '../intent/chain.tsx';
import type { RetentionDialogProps } from '../presenters/retentionDialog.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { useT } from './primitives/language.tsx';
import { UsageBar } from './UsageBar.tsx';

const MARK = { ctx: ' ', add: '+', del: '-' } as const;

/**
 * Claude Code の設定ファイルに書く前の確認。
 * 書く 1 行をそのまま差分で見せ、バックアップの置き場と、もう削除されたトランスクリプトは戻らないことを並べる。
 */
export function RetentionDialog(props: RetentionDialogProps) {
  const emit = useEmit();
  const t = useT();
  // 書き込んでいる間は閉じさせない。閉じても書き込みは止まらず、結果だけが見えなくなる。
  const close = () => { if (!props.writing) emit({ type: 'overlay.close' }); };
  return (
    <Dialog
      title={props.title}
      icon="retention"
      onClose={close}
      footer={<>
        <button type="button" className="btn" disabled={props.writing} onClick={close}>{t('common.button.cancel')}</button>
        <span className="spacer" />
        {props.showOther && <button type="button" className="btn" onClick={() => emit({ type: 'retention.settings' })}>{t('retentionDialog.footer.other')}</button>}
        <button type="button" className="btn btn-primary" disabled={props.writing || props.lines === null || props.previewError !== null} onClick={() => emit({ type: 'retention.write' })}>{t('retentionDialog.footer.write')}</button>
      </>}
    >
      {props.reloaded && <div className="error" role="alert">{t('retentionDialog.notice.reloaded')}</div>}
      <div className="muted">{props.lead}</div>
      {props.previewError
        ? <div className="error" role="alert">{props.previewError}</div>
        : props.lines === null
        ? <div className="faint">{t('retentionDialog.diff.loading')}</div>
        : (
          <div className="diff mono">
            <div className="diff-path">{props.path}</div>
            {props.lines.map((l, i) => <div key={i} className={`diff-${l.kind}`}>{MARK[l.kind]} {l.text}</div>)}
          </div>
        )}
      {props.bar && <UsageBar {...props.bar} />}
      {props.shrinkNote && <div className="error">{props.shrinkNote}</div>}
      <dl className="kv">
        <dt>{t('retentionDialog.info.backup')}</dt><dd className="mono">{props.backupDir}</dd>
        {props.otherPcs && <><dt>{t('retentionDialog.info.otherPcs')}</dt><dd>{t('retentionDialog.info.otherPcsNote')}</dd></>}
        <dt>{t('retentionDialog.info.deleted')}</dt><dd>{t('retentionDialog.info.deletedNote')}</dd>
      </dl>
    </Dialog>
  );
}
