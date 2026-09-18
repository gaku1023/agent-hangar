import { useState, type KeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { PromoteProps, PromotedProps } from '../presenters/promote.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';

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

  // Esc で閉じ、Enter で送る。
  // 変換中の Enter は確定のための打鍵なので、送信に使わない。
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { emit({ type: 'overlay.close' }); return; }
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    submit();
  };

  return (
    <div className="overlay" onClick={() => emit({ type: 'overlay.close' })}>
      <div className="dialog dialog-promote" role="dialog" aria-modal="true" aria-label="プロジェクトに昇格" onClick={(e) => e.stopPropagation()}>
        <b className="dialog-title"><Icon name="promote" />プロジェクトに昇格</b>
        <div className="faint">{props.sessionName} の作業をワークスペースの下に移します。</div>
        <label className="field" htmlFor="promote-name">プロジェクト名
          <input id="promote-name" className="input mono" aria-label="プロジェクト名" value={name} placeholder="ワークスペースに作るディレクトリの名前" onChange={(e) => setName(e.target.value)} onKeyDown={onKeyDown} />
        </label>
        <label className="field-row">
          <input type="checkbox" aria-label="git init する" checked={gitInit} onChange={(e) => setGitInit(e.target.checked)} />
          <span>git init する</span>
        </label>
        <label className="field-row">
          <input type="checkbox" aria-label="ファイルを移動する" disabled={props.runAlive} checked={willMove} onChange={(e) => setMoveFiles(e.target.checked)} />
          <span>ファイルを移動する</span>
        </label>
        {props.runAlive && <div className="faint">実行中のセッションがあるので、ファイルは移動しません</div>}
        {props.error && <div className="error" role="alert">{props.error}</div>}
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={() => emit({ type: 'overlay.close' })}>やめる</button>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" disabled={props.submitting} onClick={submit}>昇格</button>
        </div>
      </div>
    </div>
  );
}

/** 昇格の完了。次の一手として、その場所での新規セッションを勧める。 */
export function PromotedDialog(props: PromotedProps) {
  const emit = useEmit();
  return (
    <div className="overlay" onClick={() => emit({ type: 'overlay.close' })}>
      <div className="dialog dialog-wide dialog-promote" role="dialog" aria-modal="true" aria-label="昇格しました" onClick={(e) => e.stopPropagation()}>
        <b className="dialog-title"><Icon name="promote" />{props.projectName} に昇格しました</b>
        <div className="faint">{props.moved ? 'ファイルを移しました' : (props.reason ?? 'ファイルは移していません')}</div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={() => emit({ type: 'overlay.close' })}>閉じる</button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => emit({ type: 'project.open', id: props.projectId })}>プロジェクトを開く</button>
          <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', projectId: props.projectId })}>この場所で新しいセッションを開始</button>
        </div>
      </div>
    </div>
  );
}
