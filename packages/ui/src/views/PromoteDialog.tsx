import { useState, type KeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { PromoteProps, PromotedProps } from '../presenters/promote.ts';
import { isComposing } from './ime.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { useT } from './primitives/language.tsx';
import { CheckCard } from './primitives/OptionCard.tsx';

/**
 * クイックセッションをプロジェクトの親フォルダのプロジェクトへ昇格するダイアログ。
 * 入力は送信するまで外へ出ないので、Mediator ではなくここに持つ。
 * run が生きているあいだはファイルを動かせないので、その選択を無効にして理由を添える。
 */
export function PromoteDialog(props: PromoteProps) {
  const emit = useEmit();
  const t = useT();
  const [name, setName] = useState('');
  const [gitInit, setGitInit] = useState(true);
  const [moveFiles, setMoveFiles] = useState(true);
  // 実行中は移動しないので、選択の見た目と送る値の両方を偽に倒す。
  const willMove = moveFiles && !props.runAlive;

  const submit = () => {
    if (props.submitting) return;
    emit({ type: 'session.promote.submit', id: props.sessionId, name, gitInit, moveFiles: willMove });
  };

  // Enter で送る。Esc は殻が受けて閉じる。
  // 変換中の Enter は確定のための打鍵なので、送信に使わない。
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    submit();
  };

  const close = () => emit({ type: 'overlay.close' });
  // 名前を打ちかけたまま背景を押し違えても失わないよう、背景では閉じない。
  return (
    <Dialog
      title={t('promote.dialog.title')}
      icon="promote"
      className="dialog-promote"
      onClose={close}
      closeOnBackdrop={false}
      footer={<><button type="button" className="btn" onClick={close}>{t('common.button.cancel')}</button><span className="spacer" /><button type="button" className="btn btn-primary" disabled={props.submitting} onClick={submit}>{t('promote.dialog.action')}</button></>}
    >
      <div className="faint">{t('promote.dialog.lead', { name: props.sessionName })}</div>
      <label className="field" htmlFor="promote-name">{t('promote.field.name')}
        <input id="promote-name" className="input mono" aria-label={t('promote.field.name')} value={name} placeholder={t('promote.field.namePlaceholder')} onChange={(e) => setName(e.target.value)} onKeyDown={onKeyDown} />
      </label>
      <CheckCard label={t('promote.gitInit.label')} description={t('promote.gitInit.description')} icon="gitInit" checked={gitInit} onChange={setGitInit} />
      <CheckCard label={t('promote.move.label')} description={t('promote.move.description')} icon="moveFiles" checked={willMove} disabled={props.runAlive} onChange={setMoveFiles} />
      {props.runAlive && <div className="faint">{t('promote.move.blocked')}</div>}
      {props.error && <div className="error" role="alert">{props.error}</div>}
    </Dialog>
  );
}

/** 昇格の完了。次の一手として、その場所での新規セッションを勧める。 */
export function PromotedDialog(props: PromotedProps) {
  const emit = useEmit();
  const t = useT();
  const close = () => emit({ type: 'overlay.close' });
  // 読んで終わりのダイアログなので、背景を押しても閉じる。下端に「閉じる」があるので × は置かない。
  return (
    <Dialog
      title={t('promote.done.title', { name: props.projectName })}
      icon="promote"
      className="dialog-wide dialog-promote"
      onClose={close}
      closeButton={false}
      footer={<>
        <button type="button" className="btn" onClick={close}>{t('promote.done.close')}</button>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => emit({ type: 'project.open', id: props.projectId })}>{t('promote.done.openProject')}</button>
        <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', projectId: props.projectId })}>{t('promote.done.startSession')}</button>
      </>}
    >
      <div className="faint">{props.moved ? t('promote.done.moved') : (props.reason ?? t('promote.done.notMoved'))}</div>
    </Dialog>
  );
}
