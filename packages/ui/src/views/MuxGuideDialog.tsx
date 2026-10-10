import { useEmit } from '../action/chain.tsx';
import type { MuxStatus } from '../presenters/readiness.ts';
import { CommandLine } from './primitives/CommandLine.tsx';
import { Dialog } from './primitives/Dialog.tsx';
import { useT } from './primitives/language.tsx';

/**
 * セッションを始めようとしたときに psmux（Windows）か tmux が無ければ出す案内（段 6 の B2）。
 * 無いあいだは、要ることと入れるコマンド、「インストールしたので再確認」と「キャンセル」を出す。
 * 再確認で見つかったら、版を添えて「開始」を出し、押すと止めていた操作（新しいセッション、再開）を進める。
 * 見つかった顔は作り直し（key）、開始にフォーカスを当てる。Enter 1 つで始められるようにするためである。
 */
export function MuxGuideDialog(props: { mux: MuxStatus }) {
  const emit = useEmit();
  const t = useT();
  const m = props.mux;
  const close = () => emit({ type: 'overlay.close' });
  if (m.installed) {
    return (
      <Dialog
        key="found"
        title={t('mux.guide.found.title', { name: m.name })}
        icon="check"
        onClose={close}
        footer={<><span className="spacer" /><button type="button" className="btn btn-primary" data-autofocus onClick={() => emit({ type: 'mux.guide.proceed' })}>{t('mux.guide.start')}</button></>}
      >
        <div className="muted">{m.version ? t('mux.guide.found.lead', { version: m.version }) : t('mux.guide.found.leadNoVersion')}</div>
      </Dialog>
    );
  }
  return (
    <Dialog
      key="missing"
      title={t('mux.guide.title', { name: m.name })}
      icon="alert"
      onClose={close}
      footer={<>
        <span className="spacer" />
        <button type="button" className="btn" onClick={close}>{t('common.button.cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={m.checking} onClick={() => emit({ type: 'mux.recheck' })}>{m.checking ? t('mux.action.checking') : t('mux.guide.recheck')}</button>
      </>}
    >
      <div className="muted">{t(m.windows ? 'mux.guide.lead.windows' : 'mux.guide.lead.other')}</div>
      <CommandLine command={m.command} />
      {m.stillMissing && <div className="faint" role="status" style={{ marginTop: 8 }}>{t('mux.status.stillMissing', { name: m.name })}</div>}
    </Dialog>
  );
}
