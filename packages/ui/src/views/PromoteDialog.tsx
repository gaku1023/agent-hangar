import { useState, type KeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { PromoteProps, PromotedProps } from '../presenters/promote.ts';
import { isComposing } from './ime.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { CheckCard } from './primitives/OptionCard.tsx';

/**
 * スクラッチのセッションをワークスペースのプロジェクトへ昇格するダイアログ。
 * 入力は送信するまで外へ出ないので、Mediator ではなくここに持つ。
 * run が生きているあいだはファイルを動かせないので、その選択を無効にして理由を添える。
 */
export function PromoteDialog(props: PromoteProps) {
  const emit = useEmit();
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
      title="プロジェクトに昇格"
      icon="promote"
      className="dialog-promote"
      onClose={close}
      closeOnBackdrop={false}
      footer={<><button type="button" className="btn" onClick={close}>やめる</button><span className="spacer" /><button type="button" className="btn btn-primary" disabled={props.submitting} onClick={submit}>昇格</button></>}
    >
      <div className="faint">{props.sessionName} の作業をワークスペースの下に移します。</div>
      <label className="field" htmlFor="promote-name">プロジェクト名
        <input id="promote-name" className="input mono" aria-label="プロジェクト名" value={name} placeholder="ワークスペースに作るディレクトリの名前" onChange={(e) => setName(e.target.value)} onKeyDown={onKeyDown} />
      </label>
      <CheckCard label="git init する" description="空のリポジトリを作ってから移します" icon="gitInit" checked={gitInit} onChange={setGitInit} />
      <CheckCard label="ファイルを移動する" description="スクラッチのファイルをワークスペースへ移します" icon="moveFiles" checked={willMove} disabled={props.runAlive} onChange={setMoveFiles} />
      {props.runAlive && <div className="faint">実行中のセッションがあるので、ファイルは移動しません</div>}
      {props.error && <div className="error" role="alert">{props.error}</div>}
    </Dialog>
  );
}

/** 昇格の完了。次の一手として、その場所での新規セッションを勧める。 */
export function PromotedDialog(props: PromotedProps) {
  const emit = useEmit();
  const close = () => emit({ type: 'overlay.close' });
  // 読んで終わりのダイアログなので、背景を押しても閉じる。下端に「閉じる」があるので × は置かない。
  return (
    <Dialog
      title={`${props.projectName} に昇格しました`}
      icon="promote"
      className="dialog-wide dialog-promote"
      onClose={close}
      closeButton={false}
      footer={<>
        <button type="button" className="btn" onClick={close}>閉じる</button>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => emit({ type: 'project.open', id: props.projectId })}>プロジェクトを開く</button>
        <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', projectId: props.projectId })}>ここで新しいセッションを始める</button>
      </>}
    >
      <div className="faint">{props.moved ? 'ファイルを移しました' : (props.reason ?? 'ファイルは移していません')}</div>
    </Dialog>
  );
}
