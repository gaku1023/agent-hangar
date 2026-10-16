import { useEffect, useState, type ReactNode } from 'react';
import type { UiAction } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { ConfirmRequest } from '../mediator/types.ts';
import type { ConfirmDeleteSessionProps, ConfirmProjectProps } from '../presenters/confirm.ts';
import type { ResumeHereCard, ResumeHereProps, TakeoverProps } from '../presenters/resumeHere.ts';
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
 * 見つからないプロジェクトを一覧から削除する場面、アカウントを切り替える場面とアカウントを一覧から外す場面、
 * 終わった扱いの claude が動き続けている会話を再開する場面を扱う。
 * どうするかを決めるのは利用者なので、View は起きることを並べるだけで判断をしない。
 * 開いた時点のフォーカスは、殻がやめる側に置く。Enter の押し違いで押し切らせないためである。
 */
export function ConfirmDialog(props: { confirm: ConfirmRequest; project?: ConfirmProjectProps | null; accountName?: string | null; resumeHere?: ResumeHereProps | null; takeover?: TakeoverProps | null; deleteSession?: ConfirmDeleteSessionProps | null }) {
  const emit = useEmit();
  const t = useT();
  const c = props.confirm;
  const close = () => emit({ type: 'overlay.close' });
  const cancel = <button type="button" className="btn" onClick={close}>{t('common.button.cancel')}</button>;
  if (c.kind === 'resumeHere') return props.resumeHere ? <ResumeHereConfirm p={props.resumeHere} cancel={cancel} close={close} /> : null;
  if (c.kind === 'takeover') return props.takeover ? <TakeoverProgress p={props.takeover} /> : null;
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
  if (c.kind === 'deleteSession') {
    const d = props.deleteSession;
    // 消えた直後（ほかの PC で消えた）などで中身が無ければ描かない。Mediator が session.removed で閉じる。
    if (!d) return null;
    // 本文はゴミ箱へ移り、同期でほかの PC からも消えるので、赤い丸と赤く塗ったボタンで示す（試作の 3A）。
    // 確定は先に閉じてから送る。断られた理由（実行中の 409、ゴミ箱へ移せない 500）はトーストに出る。
    return (
      <Dialog
        title={t('confirm.deleteSession.title', { name: d.name })}
        danger
        icon="trash"
        lead={t('confirm.deleteSession.facts', { project: d.project, n: d.turns })}
        onClose={close}
        footer={<><span className="spacer" />{cancel}<button type="button" className="btn btn-danger btn-danger-fill" onClick={() => { close(); emit({ type: 'session.delete', id: c.sessionId }); }}><Icon name="trash" />{t('confirm.deleteSession.action')}</button></>}
      >
        <div className="muted">{t('confirm.deleteSession.lead')}</div>
      </Dialog>
    );
  }
  if (c.kind === 'mergeProject') {
    const name = c.into.name;
    const after = t('confirm.mergeProject.after', { name });
    // まとめた後の姿を見せる（試作の B）。見出しを問いにし、1 つのプロジェクトが PC ごとの場所を持つことを枠の中に並べる。
    // 中身は消えずに移るだけなので、危険の赤にはせず、hangar への移動の確認と同じ青いボタンにする。
    return (
      <Dialog
        title={t('confirm.mergeProject.title', { name })}
        onClose={close}
        footer={<>{cancel}<span className="spacer" /><button type="button" className="btn btn-primary" onClick={() => emit({ type: 'project.resolve', id: c.projectId, action: { kind: 'repoint', path: c.path, merge: true }, confirmed: true })}>{t('confirm.mergeProject.action')}</button></>}
      >
        <div className="muted">{slot(t('confirm.mergeProject.lead', { name: SLOT }), <b>{name}</b>)}</div>
        <div className="merge-preview" role="group" aria-label={after}>
          <div className="muted">{after}</div>
          <ul className="merge-roots">
            {c.roots.map((r, i) => (
              <li key={i}><span className="faint">{r.here ? t('confirm.mergeProject.thisPc') : r.deviceName ?? t('confirm.mergeProject.otherPc')}</span><span className="mono">{r.path}</span></li>
            ))}
          </ul>
          <div className="faint">{t('confirm.mergeProject.sessions', { n: c.sessions, m: c.fromSessions })}</div>
        </div>
        <div className="faint">{t('confirm.mergeProject.otherPcs')}</div>
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
  if (c.kind === 'strayProcess') {
    // hangar では終わった扱いなのに、その会話の claude が動き続けている（試作の案 A）。
    // 推すのは止めて再開する方で、青く塗る。止めずに再開する方は、2 つの claude が同じ会話を進めるので、左端の控えめな危険のボタンにする。
    // まとめて再開の 1 本なら、選び方を添えて順番待ちに入れ直す。
    const choose = (stray: 'stop' | 'ignore') => emit(c.queued ? { type: 'interrupted.resume', ids: [c.sessionId], stray } : { type: 'session.resume', id: c.sessionId, stray });
    return (
      <Dialog
        title={t('confirm.strayProcess.title')}
        icon="warning"
        onClose={close}
        footer={<><button type="button" className="btn btn-danger" onClick={() => choose('ignore')}>{t('confirm.strayProcess.ignore')}</button><span className="spacer" />{cancel}<button type="button" className="btn btn-primary" onClick={() => choose('stop')}>{t('confirm.strayProcess.stop')}</button></>}
      >
        <div>{slot(t('confirm.strayProcess.lead', { pid: SLOT }), <span className="mono">{c.pid}</span>)}</div>
        <div className="muted">{t('confirm.strayProcess.risk')}</div>
        <div className="faint">{t('confirm.strayProcess.note')}</div>
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

/** 確認の 1 枚の、PC 1 台分のカード。この PC の側は塗り分ける（data-here）。パスは長ければ折り返す。 */
function Card(props: { card: ResumeHereCard; here: boolean }) {
  const c = props.card;
  return (
    <div className="rh-card" data-here={props.here ? 'true' : undefined}>
      <div className="rh-card-k">{c.label}</div>
      <div className="rh-card-n">{c.name}</div>
      {c.os && <div className="rh-card-o">{c.os}</div>}
      {c.path && <div className="rh-card-p mono">{c.path}</div>}
      {c.note && <div className="rh-card-note">{c.note}</div>}
      {c.at && <div className="rh-card-at">{c.at}</div>}
    </div>
  );
}

/**
 * 停止を頼んだあとの 1 枚（試作の B1 と C2）。確認の 1 枚がそのまま進み具合に変わる。
 * progress は 4 つの段と 90 秒の目安の細い線を出し、ボタンは「取り消す」だけにする。経過秒と線は 1 秒ごとに描き直す。
 * timeout は返事がない警告で、「取り消す」「もう少し待つ」「このまま引き継ぐ」を選ばせる。
 * Esc と外側のクリックと × は、閉じずに取り下げを送る。overlay.close で閉じるとサーバに待ちが残る。
 */
function TakeoverProgress(props: { p: TakeoverProps }) {
  const emit = useEmit();
  const t = useT();
  const p = props.p;
  const timed = p.kind === 'progress' && p.deadline > p.startedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timed) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timed]);
  const cancel = () => emit({ type: 'session.takeover.cancel', id: p.sessionId });
  const seconds = Math.max(0, Math.floor((now - p.startedAt) / 1000));
  const ratio = timed ? Math.min(1, Math.max(0, (now - p.startedAt) / (p.deadline - p.startedAt))) : 0;
  const cancelButton = <button type="button" className="btn" onClick={cancel}>{t('confirm.takeover.cancel')}</button>;
  return (
    <Dialog
      title={p.title}
      icon={p.kind === 'timeout' ? 'warning' : 'resumeHere'}
      onClose={cancel}
      className="rh-dialog"
      footer={p.kind === 'timeout'
        ? <>{cancelButton}<span className="spacer" /><button type="button" className="btn" onClick={() => emit({ type: 'session.takeover.extend', id: p.sessionId })}>{t('confirm.takeover.wait')}</button><button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.takeover.start', id: p.sessionId, force: true })}>{t('confirm.takeover.forceAction')}</button></>
        : <><span className="spacer" />{cancelButton}</>}
    >
      {p.lead && <div className="muted">{p.lead}</div>}
      {p.steps.length > 0 && (
        <ol className="rh-steps">
          {p.steps.map((s, i) => (
            <li key={i} data-state={s.state}>
              <span className="rh-mark" aria-hidden="true">{s.state === 'done' ? <Icon name="check" /> : i + 1}</span>
              <span>{s.label}</span>
              {timed && i === 1 && s.state === 'active' && <small>{t('confirm.takeover.elapsed', { seconds })}</small>}
            </li>
          ))}
        </ol>
      )}
      {p.kind === 'progress' && (
        <div className="rh-meter" role="progressbar" aria-label={p.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}><i style={{ width: `${ratio * 100}%` }} /></div>
      )}
      {p.hint && <div className="faint">{p.hint}</div>}
      {p.band && (
        <div className="rh-band" role="note" aria-label={p.band.strong}>
          <Icon name="warning" />
          <div><b>{p.band.strong}</b><span>{p.band.text}</span></div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * 「この PC で再開」の確認（試作の 2a の A、2b の Y、2c の P）。
 * 前の PC とこの PC の 2 枚のカードを矢印でつなぎ、下に同期されないものの黄の帯を置く。毎回出す。
 * この PC で場所が決まらないときは、再開のボタンを押せなくして理由を添える。
 * この PC のトランスクリプトを置き換えるとき（A → B → A）は、バックアップに残すことを 1 行で言い、承諾を上書きつきで送る。
 */
function ResumeHereConfirm(props: { p: ResumeHereProps; cancel: ReactNode; close: () => void }) {
  const emit = useEmit();
  const p = props.p;
  // 相手が生きていれば停止を頼む（takeover）、応答がなければ頼まずに引き継ぐ（stale、force）。相手がいなければ今までの再開。
  const accept: UiAction = p.mode === 'resume'
    ? { type: 'session.resumeHere', id: p.sessionId, ...(p.overwrite ? { overwrite: true } : {}) }
    : { type: 'session.takeover.start', id: p.sessionId, force: p.mode === 'stale' };
  return (
    <Dialog
      title={p.title}
      icon="warning"
      onClose={props.close}
      className="rh-dialog"
      footer={<>{props.cancel}<span className="spacer" /><button type="button" className="btn btn-primary" aria-disabled={p.blocked ? 'true' : undefined} title={p.blocked ?? undefined} onClick={() => { if (!p.blocked) emit(accept); }}><Icon name="resumeHere" />{p.action}</button></>}
    >
      <div className="muted">{p.lead}</div>
      <div className="rh-cards">
        <Card card={p.from} here={false} />
        <span className="rh-arrow" aria-hidden="true">→</span>
        <Card card={p.to} here />
      </div>
      {p.takeover && (
        <div className="rh-band rh-takeover" role="note" aria-label={p.takeover.strong}>
          <Icon name="warning" />
          <div><b>{p.takeover.strong}</b><span>{p.takeover.text}</span></div>
        </div>
      )}
      <div className="rh-band" role="note">
        <Icon name="warning" />
        <div><b>{p.band.strong}</b><span>{p.band.text}</span></div>
      </div>
      {p.replace && <div className="rh-blocked">{p.replace}</div>}
      {p.blocked && <div className="rh-blocked">{p.blocked}</div>}
    </Dialog>
  );
}
