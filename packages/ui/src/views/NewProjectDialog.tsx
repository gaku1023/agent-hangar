import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ProjectPlace } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import { baseName, isRootPath, joinPath } from '../lib/paths.ts';
import type { NewProjectProps } from '../presenters/newProject.ts';
import { isComposing } from './ime.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { revealWithin } from './primitives/revealWithin.ts';
import { CheckCard } from './primitives/OptionCard.tsx';
import { Segmented } from './primitives/Segmented.tsx';

type Mode = 'newDir' | 'dir';
/** 選んだフォルダの名前。根だけのパス（`/`、`C:\`）は名前を持たないので空にする。 */
const folderName = (p: string) => (isRootPath(p) ? '' : baseName(p));

/**
 * プロジェクト画面の作成のダイアログ。新しいフォルダを作るか、既存のフォルダを登録する。
 * 入力は送信するまで外へ出ないので、Mediator ではなくここに持つ。名前の検証はサーバが行う。
 * 「作成」はそのプロジェクトの画面へ移り、「作成して始める」は新しいセッションのダイアログを開く（Mediator）。
 */
export function NewProjectDialog(props: NewProjectProps) {
  const emit = useEmit();
  const t = useT();
  const modes = [{ value: 'newDir', label: t('newProject.mode.newDir') }, { value: 'dir', label: t('newProject.mode.dir') }];
  const [mode, setMode] = useState<Mode>('newDir');
  const [name, setName] = useState('');
  const [gitInit, setGitInit] = useState(true);
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  // 一覧の中でキーが指している行。Listbox と同じく、フォーカスは検索欄に置いたまま aria-activedescendant で示す。
  const [active, setActive] = useState(0);
  const uid = useId();
  // 利用者が名前を自分で直したか。直す前は、選んだフォルダの basename を名前に入れる。
  const [nameTouched, setNameTouched] = useState(false);
  // 開いた時点の Finder の回数。これより新しい結果だけを使う（別のダイアログで選んだ結果を当てない）。
  const pickedAtOpen = useRef(props.picked?.n ?? 0);

  const choosePath = (p: string) => {
    setPath(p);
    if (!nameTouched) setName(folderName(p));
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
    const place: ProjectPlace = mode === 'newDir' ? { kind: 'newDir', name, gitInit } : { kind: 'dir', path, name: name.trim() || undefined };
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
  const current = shown.length ? Math.min(active, shown.length - 1) : -1;
  const rowId = (i: number) => `${uid}-dir-${i}`;
  // キーで動かした行を、一覧の箱の中だけで見える位置へ寄せる。
  // scrollIntoView は WebKit で外側の箱（アプリ全体）までずらすので使わない。
  const rowsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rows = rowsRef.current;
    const item = current >= 0 ? document.getElementById(rowId(current)) : null;
    if (rows && item) revealWithin(rows, item);
  }, [current, mode]);   // eslint-disable-line react-hooks/exhaustive-deps
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e)) return;
    const n = shown.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) setActive((current + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) setActive((current - 1 + n) % n); }
    // Enter は行を選ぶだけで、送信はしない。
    else if (e.key === 'Enter') { e.preventDefault(); if (current >= 0) choosePath(shown[current]!.path); }
  };
  // 親フォルダが届く前の仮の場所。区切りは画面の OS に合わせる。
  const root = props.workspaceRoot ?? joinPath('~', 'workspace');
  const close = () => emit({ type: 'overlay.close' });
  // 名前を打ちかけたまま背景を押し違えても失わないよう、背景では閉じない。
  return (
    <Dialog
      title={t('newProject.dialog.title')}
      icon="folderPlus"
      className="dialog-wide"
      onClose={close}
      closeOnBackdrop={false}
      footer={<>
        <button type="button" className="btn" onClick={close}>{t('common.button.cancel')}</button>
        <span className="spacer" />
        <button type="button" className="btn" disabled={props.submitting} onClick={() => submit(false)}>{t('newProject.footer.create')}</button>
        <button type="button" className="btn btn-primary" disabled={props.submitting} onClick={() => submit(true)}>{t('newProject.footer.createAndStart')}</button>
      </>}
    >
      <div><Segmented label={t('newProject.mode.aria')} value={mode} options={modes} onChange={(v) => setMode(v as Mode)} /></div>
      {mode === 'newDir' ? (
        <>
          <label className="field" htmlFor="new-project-name">{t('newProject.field.name')}
            <input id="new-project-name" className="input mono" data-autofocus value={name} placeholder={t('newProject.field.namePlaceholder')} onChange={(e) => { setNameTouched(true); setName(e.target.value); }} onKeyDown={onEnter} />
          </label>
          <div className="faint">{t('newProject.name.willCreate', { path: joinPath(root, name.trim()) })}</div>
          <CheckCard label={t('newProject.gitInit.label')} description={t('newProject.gitInit.description')} icon="gitInit" checked={gitInit} onChange={setGitInit} />
        </>
      ) : (
        <>
          <div className="field">{t('newProject.field.folder')}
            <div className="new-project-dirs">
              <div className="listbox-search"><Icon name="search" /><input role="combobox" aria-label={t('newProject.search.placeholder')} placeholder={t('newProject.search.placeholder')} aria-expanded="true" aria-controls={`${uid}-dirs`} aria-autocomplete="list" aria-activedescendant={current >= 0 ? rowId(current) : undefined} value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onSearchKey} /></div>
              <div ref={rowsRef} id={`${uid}-dirs`} role="listbox" aria-label={t('newProject.list.aria')} className="listbox-rows">
                {shown.map((d, i) => (
                  <div key={d.path} id={rowId(i)} role="option" aria-selected={d.path === path} aria-label={d.name} className="listbox-opt" data-active={i === current ? 'true' : undefined} onMouseMove={() => { if (i !== current) setActive(i); }} onClick={() => choosePath(d.path)}>
                    <Icon name="folder" />
                    <span className="listbox-opt-main"><b>{d.name}</b><small>{d.path}</small></span>
                    <span className="listbox-check" aria-hidden="true"><Icon name="check" /></span>
                  </div>
                ))}
                {shown.length === 0 && <div className="listbox-empty">{props.dirs.length ? t('newProject.list.noMatch') : t('newProject.list.empty')}</div>}
              </div>
            </div>
            <div className="field-row">
              {props.desktop && <><button type="button" className="btn" onClick={() => emit({ type: 'folder.pick' })}><Icon name="folderOpen" />{t('newProject.folder.pick')}</button><span className="faint">{t('newProject.folder.or')}</span></>}
              <input className="input mono" style={{ flex: 1 }} aria-label={t('newProject.path.aria')} placeholder={t('newProject.path.placeholder')} value={path} onChange={(e) => choosePath(e.target.value)} onKeyDown={onEnter} />
            </div>
          </div>
          <label className="field" htmlFor="new-project-reg-name">{t('newProject.field.name')}
            <input id="new-project-reg-name" className="input" value={name} onChange={(e) => { setNameTouched(true); setName(e.target.value); }} onKeyDown={onEnter} />
          </label>
        </>
      )}
      {props.error && <div className="error" role="alert">{props.error}</div>}
    </Dialog>
  );
}
