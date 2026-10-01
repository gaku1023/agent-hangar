import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ProjectPlace } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { NewProjectProps } from '../presenters/newProject.ts';
import { isComposing } from './ime.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { CheckCard } from './primitives/OptionCard.tsx';
import { Segmented } from './primitives/Segmented.tsx';

type Mode = 'newDir' | 'dir';
const MODES = [{ value: 'newDir', label: '新しいフォルダを作る' }, { value: 'dir', label: '既存のフォルダを登録' }];
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? '';

/**
 * プロジェクト画面の作成のダイアログ。新しいフォルダを作るか、既存のフォルダを登録する。
 * 入力は送信するまで外へ出ないので、Mediator ではなくここに持つ。名前の検証はサーバが行う。
 * 「作成」はそのプロジェクトの画面へ移り、「作成して始める」は新しいセッションのダイアログを開く（Mediator）。
 */
export function NewProjectDialog(props: NewProjectProps) {
  const emit = useEmit();
  const [mode, setMode] = useState<Mode>('newDir');
  const [name, setName] = useState('');
  const [gitInit, setGitInit] = useState(true);
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  // 利用者が名前を自分で直したか。直す前は、選んだフォルダの basename を名前に入れる。
  const [nameTouched, setNameTouched] = useState(false);
  // 開いた時点の Finder の回数。これより新しい結果だけを使う（別のダイアログで選んだ結果を当てない）。
  const pickedAtOpen = useRef(props.picked?.n ?? 0);

  const choosePath = (p: string) => {
    setPath(p);
    if (!nameTouched) setName(baseName(p));
  };
  useEffect(() => {
    const p = props.picked;
    if (!p || p.n <= pickedAtOpen.current) return;
    pickedAtOpen.current = p.n;
    setMode('dir');
    choosePath(p.path);
  }, [props.picked?.n]);   // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (startSession: boolean) => {
    if (props.submitting) return;
    const place: ProjectPlace = mode === 'newDir' ? { kind: 'newDir', name, gitInit } : { kind: 'dir', path, name };
    emit({ type: 'project.new.submit', place, startSession });
  };
  // Enter は「作成して始める」。変換中の Enter は確定のための打鍵なので、送信に使わない。
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    submit(true);
  };

  const needle = query.trim().toLowerCase();
  const shown = props.dirs.filter((d) => !needle || d.name.toLowerCase().includes(needle));
  const root = props.workspaceRoot ?? '~/workspace';
  const close = () => emit({ type: 'overlay.close' });
  // 名前を打ちかけたまま背景を押し違えても失わないよう、背景では閉じない。
  return (
    <Dialog
      title="新しいプロジェクト"
      icon="folderPlus"
      className="dialog-wide"
      onClose={close}
      closeOnBackdrop={false}
      footer={<>
        <button type="button" className="btn" onClick={close}>やめる</button>
        <span className="spacer" />
        <button type="button" className="btn" disabled={props.submitting} onClick={() => submit(false)}>作成</button>
        <button type="button" className="btn btn-primary" disabled={props.submitting} onClick={() => submit(true)}>作成して始める</button>
      </>}
    >
      <div><Segmented label="作り方" value={mode} options={MODES} onChange={(v) => setMode(v as Mode)} /></div>
      {mode === 'newDir' ? (
        <>
          <label className="field" htmlFor="new-project-name">プロジェクト名
            <input id="new-project-name" className="input mono" data-autofocus value={name} placeholder="ワークスペースに作るディレクトリの名前" onChange={(e) => { setNameTouched(true); setName(e.target.value); }} onKeyDown={onEnter} />
          </label>
          <div className="faint">{root}/{name.trim()} を作ります</div>
          <CheckCard label="git init する" description="空のリポジトリを作ります" icon="gitInit" checked={gitInit} onChange={setGitInit} />
        </>
      ) : (
        <>
          <div className="field">フォルダ
            <div className="new-project-dirs">
              <div className="listbox-search"><Icon name="search" /><input aria-label="未登録のフォルダを探す" placeholder="ワークスペースの未登録のフォルダを探す" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
              <div role="listbox" aria-label="ワークスペースの未登録のフォルダ" className="listbox-rows">
                {shown.map((d) => (
                  <div key={d.path} role="option" aria-selected={d.path === path} aria-label={d.name} className="listbox-opt" onClick={() => choosePath(d.path)}>
                    <Icon name="folder" />
                    <span className="listbox-opt-main"><b>{d.name}</b><small>{d.path}</small></span>
                    <span className="listbox-check" aria-hidden="true"><Icon name="check" /></span>
                  </div>
                ))}
                {shown.length === 0 && <div className="listbox-empty">{props.dirs.length ? '一致するものはありません' : '未登録のフォルダはありません'}</div>}
              </div>
            </div>
            <div className="field-row">
              {props.desktop && <><button type="button" className="btn" onClick={() => emit({ type: 'folder.pick' })}><Icon name="folderOpen" />ほかの場所を選ぶ…</button><span className="faint">または</span></>}
              <input className="input mono" style={{ flex: 1 }} aria-label="フォルダのパス" placeholder="/Users/you/…（パスを打つ）" value={path} onChange={(e) => choosePath(e.target.value)} onKeyDown={onEnter} />
            </div>
          </div>
          <label className="field" htmlFor="new-project-reg-name">プロジェクト名
            <input id="new-project-reg-name" className="input" value={name} onChange={(e) => { setNameTouched(true); setName(e.target.value); }} onKeyDown={onEnter} />
          </label>
        </>
      )}
      {props.error && <div className="error" role="alert">{props.error}</div>}
    </Dialog>
  );
}
