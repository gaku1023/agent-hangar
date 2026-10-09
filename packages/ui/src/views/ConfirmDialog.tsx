import { useEmit } from '../intent/chain.tsx';
import type { ConfirmRequest } from '../mediator/types.ts';
import type { ConfirmProjectProps } from '../presenters/confirm.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { SLOT, slot } from './primitives/slot.tsx';

/** 本文の大きさ。KB で足りなくなる長さの本文があるので MB まで見る。 */
const sizeLabel = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
/** 置き換えの前にバックアップを置く場所。 */
const BACKUP_DIR = '~/.agent-hangar/backups/transcripts/';

/**
 * 取り消せない操作の確認。
 * 「この PC で再開」で手元のトランスクリプトを他の PC のトランスクリプトに置き換える場面、外部ターミナルの claude を hangar に移動する場面、ランを止める場面、
 * 見つからないプロジェクトを一覧から削除する場面、アカウントを切り替える場面とアカウントを一覧から外す場面を扱う。
 * どうするかを決めるのは利用者なので、View は起きることを並べるだけで判断をしない。
 * 開いた時点のフォーカスは、殻がやめる側に置く。Enter の押し違いで押し切らせないためである。
 */
export function ConfirmDialog(props: { confirm: ConfirmRequest; project?: ConfirmProjectProps | null; accountName?: string | null }) {
  const emit = useEmit();
  const t = useT();
  const c = props.confirm;
  const close = () => emit({ type: 'overlay.close' });
  const cancel = <button type="button" className="btn" onClick={close}>{t('common.button.cancel')}</button>;
  if (c.kind === 'unlinkProject') {
    const name = props.project?.name ?? c.projectId;
    const sessions = props.project?.sessions ?? 0;
    // 取り消せず、同期で他の PC にも広がるので、赤い丸と赤く塗ったボタンで示す（E1）。
    return (
      <Dialog
        title={t('confirm.unlinkProject.title')}
        danger
        icon="unlink"
        lead={slot(t('confirm.unlinkProject.lead', { name: SLOT, sessions }), <b>{name}</b>)}
        onClose={close}
        footer={<><span className="spacer" />{cancel}<button type="button" className="btn btn-danger btn-danger-fill" onClick={() => emit({ type: 'project.resolve', id: c.projectId, action: { kind: 'unlink' }, confirmed: true })}><Icon name="unlink" />{t('confirm.unlinkProject.action')}</button></>}
      >
        <div className="muted">{t('confirm.unlinkProject.otherPcs')}</div>
        <div className="faint">{t('confirm.unlinkProject.keeps')}</div>
      </Dialog>
    );
  }
  if (c.kind === 'killRun') {
    return (
      <Dialog
        title={t('confirm.killRun.title')}
        danger
        icon="stop"
        lead={c.aside ? t('confirm.killRun.aside') : c.working ? t('confirm.killRun.working') : undefined}
        onClose={close}
        footer={<><span className="spacer" />{cancel}<button type="button" className="btn btn-danger btn-danger-fill" onClick={() => emit({ type: 'session.kill', runId: c.runId, working: c.working, aside: c.aside, shellTabs: c.shellTabs, confirmed: true })}>{t('confirm.killRun.action')}</button></>}
      >
        {c.shellTabs > 0 && <div className="muted">{t('confirm.killRun.shellTabs', { n: c.shellTabs })}</div>}
        <div className="faint">{t('confirm.killRun.transcriptKept')}</div>
      </Dialog>
    );
  }
  if (c.kind === 'adoptSession') {
    return (
      <Dialog
        title={t('confirm.adopt.title')}
        icon="warning"
        onClose={close}
        footer={<>{cancel}<span className="spacer" /><button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.adopt', id: c.sessionId, confirmed: true })}>{t('confirm.adopt.action')}</button></>}
      >
        <div className="muted">{t('confirm.adopt.lead')}</div>
        <div className="faint">{t('confirm.adopt.pendingQuestion')}</div>
        <div className="faint">{slot(t('confirm.adopt.backToHangar', { command: SLOT }), <span className="mono">claude -r</span>)}</div>
      </Dialog>
    );
  }
  if (c.kind === 'switchAccount') {
    const name = props.accountName ?? c.accountId;
    // 止めて再開するだけで、あとから戻せる。危険の赤にはせず、hangar への移動の確認と同じ強さにする。
    return (
      <Dialog
        title={t('confirm.switchAccount.title', { name })}
        icon="warning"
        onClose={close}
        footer={<>{cancel}<span className="spacer" /><button type="button" className="btn btn-primary" onClick={() => emit({ type: 'account.switchSession', sessionId: c.sessionId, accountId: c.accountId, working: c.working, confirmed: true })}>{t('confirm.switchAccount.action')}</button></>}
      >
        <div className="muted">{slot(t('confirm.switchAccount.lead', { name: SLOT }), <b>{name}</b>)}</div>
        {c.working && <div>{t('confirm.switchAccount.working')}</div>}
        <div className="faint">{slot(t('confirm.switchAccount.default', { name: SLOT }), <b>{name}</b>)}</div>
      </Dialog>
    );
  }
  if (c.kind === 'removeAccount') {
    const name = props.accountName ?? c.accountId;
    return (
      <Dialog
        title={t('confirm.removeAccount.title', { name })}
        danger
        icon="unlink"
        onClose={close}
        footer={<><span className="spacer" />{cancel}<button type="button" className="btn btn-danger btn-danger-fill" onClick={() => emit({ type: 'account.remove', accountId: c.accountId, confirmed: true })}><Icon name="unlink" />{t('confirm.removeAccount.action')}</button></>}
      >
        <div className="muted">{t('confirm.removeAccount.lead')}</div>
        <div className="faint">{t('confirm.removeAccount.note')}</div>
      </Dialog>
    );
  }
  return (
    <Dialog
      title={t('confirm.replaceTranscript.title')}
      icon="warning"
      onClose={close}
      footer={<>{cancel}<span className="spacer" /><button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.resumeHere', id: c.sessionId, overwrite: true })}>{t('confirm.replaceTranscript.action')}</button></>}
    >
      <div className="muted">{t('confirm.replaceTranscript.lead')}</div>
      <div>
        <div className="mono faint">{t('confirm.replaceTranscript.local', { size: sizeLabel(c.localSize) })}</div>
        <div className="mono faint">{t('confirm.replaceTranscript.remote', { size: sizeLabel(c.remoteSize) })}</div>
      </div>
      <div className="faint">{t('confirm.replaceTranscript.backup', { dir: BACKUP_DIR })}</div>
    </Dialog>
  );
}
