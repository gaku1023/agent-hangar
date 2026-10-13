import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ProjectPlace } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import { clientPlatform } from '../keys.ts';
import { baseName, isRootPath, joinPath } from '../lib/paths.ts';
import type { NewProjectProps } from '../presenters/newProject.ts';
import { isComposing } from './ime.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { revealWithin } from './primitives/revealWithin.ts';
import { CheckCard } from './primitives/OptionCard.tsx';
import { Segmented } from './primitives/Segmented.tsx';
import { ParentField, parentReady } from './ParentField.tsx';
import { boldFirst, inspectOf } from './folderNote.tsx';

type Mode = 'newDir' | 'dir';
/** パスを打ち終えるのを待ってから事前の問い合わせを頼む間（ミリ秒）。打つたびに問い合わせないためである。 */
const INSPECT_DELAY_MS = 300;
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
  // 作成場所（設定）が空のときに選ぶ、新しいフォルダを作る場所。
  const [parent, setParent] = useState('');
  const rootless = props.workspaceRoot === '';
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
    // 作成場所が空で新しいフォルダを作っているときの Finder は、作る場所を選ぶもの（ParentField が受ける）。
    if (rootless && mode === 'newDir') return;
    setMode('dir');
    choosePath(p.path);
  }, [props.picked?.n]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 既存のフォルダの事前の問い合わせ（0.6.1）。登録済みのプロジェクトの下か、ほかの PC から届いた同じプロジェクトがあるかを読む。
  // 名前を自分で直したときだけ名前を添える（弱い一致をその名前で見る）。
  const target = mode === 'dir' ? path.trim() : '';
  const askName = nameTouched ? name.trim() : '';
  useEffect(() => {
    if (!target) return;
    const timer = setTimeout(() => emit({ type: 'folder.inspect', path: target, ...(askName ? { name: askName } : {}) }), INSPECT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [target, askName]);   // eslint-disable-line react-hooks/exhaustive-deps
  const { data: inspected, loading: inspecting } = inspectOf(props.inspect, target || null);
  // 登録済みのプロジェクトの下なら、既定は作らずにそのプロジェクトを開く（試作の 6 の A）。「別のプロジェクトにする」で分けて登録する。
  // ほかの PC から届いた同じプロジェクトがあれば、既定はそれに結び付ける。「新しく作る」で新しいプロジェクトにする。切り替えはパスごとである。
  const [splitAt, setSplitAt] = useState<string | null>(null);
  const [linkNewAt, setLinkNewAt] = useState<string | null>(null);
  const enclosing = inspected && !inspected.registered ? inspected.enclosing : null;
  const nested = enclosing !== null && splitAt !== target ? enclosing : null;
  const link = !enclosing && inspected && !inspected.registered ? inspected.link : null;
  const linking = link !== null && linkNewAt !== target ? link : null;
  const linkWho = link ? (link.deviceName ? t('newProject.dir.linkWho', { device: link.deviceName, name: link.name }) : link.name) : '';

  const submit = (startSession: boolean) => {
    if (props.submitting || inspecting) return;
    if (nested) { emit({ type: 'project.new.enclosing', projectId: nested.projectId, dir: target, startSession }); return; }
    const place: ProjectPlace = mode === 'newDir' ? { kind: 'newDir', name, gitInit, ...(rootless ? { parent: parent.trim() } : {}) }
      : linking ? { kind: 'dir', path, linkTo: linking.projectId }
        : { kind: 'dir', path, name: name.trim() || undefined, ...(enclosing ? { allowNested: true } : {}) };
    emit({ type: 'project.new.submit', place, startSession });
  };
  // Enter は「作成して始める」。変換中の Enter は確定のための打鍵なので、送信に使わない。
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    if (blocked) return;
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
  // 作る場所。作成場所が空なら選んだ場所で、設定が届く前は仮の場所にする。区切りは画面の OS に合わせる。
  const root = rootless ? parent.trim() : props.workspaceRoot ?? joinPath('~', 'workspace');
  // 作成場所が空で、作る場所をまだ選んでいなければ送れない。
  // 既存のフォルダの事前の問い合わせを待つ間も送れない（開くか、分けるか、結び付けるかが決まらないため）。
  const blocked = (mode === 'newDir' && !parentReady(props.workspaceRoot, parent)) || (mode === 'dir' && inspecting);
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
        <button type="button" className="btn" disabled={props.submitting || blocked} onClick={() => submit(false)}>{nested ? t('newProject.footer.openEnclosing', { name: nested.name }) : linking ? t('newProject.footer.link') : t('newProject.footer.create')}</button>
        <button type="button" className="btn btn-primary" disabled={props.submitting || blocked} onClick={() => submit(true)}>{nested ? t('newProject.footer.startEnclosing', { name: nested.name }) : linking ? t('newProject.footer.linkAndStart') : t('newProject.footer.createAndStart')}</button>
      </>}
    >
      <div><Segmented label={t('newProject.mode.aria')} value={mode} options={modes} onChange={(v) => setMode(v as Mode)} /></div>
      {mode === 'newDir' ? (
        <>
          <label className="field" htmlFor="new-project-name">{t('newProject.field.name')}
            <input id="new-project-name" className="input mono" data-autofocus value={name} placeholder={t('newProject.field.namePlaceholder')} onChange={(e) => { setNameTouched(true); setName(e.target.value); }} onKeyDown={onEnter} />
          </label>
          {rootless && <ParentField value={parent} onChange={setParent} desktop={props.desktop} picked={props.picked} />}
          {root !== '' && <div className="faint">{t('newProject.name.willCreate', { path: joinPath(root, name.trim()) })}</div>}
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
              <input className="input mono" style={{ flex: 1 }} aria-label={t('newProject.path.aria')} placeholder={t(clientPlatform() === 'win32' ? 'newProject.path.placeholderWindows' : 'newProject.path.placeholder')} value={path} onChange={(e) => choosePath(e.target.value)} onKeyDown={onEnter} />
            </div>
            {enclosing && (
              <div className="faint dir-note">
                {nested
                  ? <><span>{boldFirst(t('newProject.dir.nested', { name: enclosing.name }), enclosing.name)}</span><button type="button" className="linkish" onClick={() => setSplitAt(target)}>{t('newProject.dir.split')}</button></>
                  : <><span>{boldFirst(t('newProject.dir.splitNote', { name: enclosing.name }), enclosing.name)}</span><button type="button" className="linkish" onClick={() => setSplitAt(null)}>{t('newProject.dir.keep', { name: enclosing.name })}</button></>}
              </div>
            )}
            {link && (
              <div className="faint dir-note">
                {linking
                  ? <><span>{boldFirst(t(link.match === 'remote' ? 'newProject.dir.linkRemote' : 'newProject.dir.linkName', { who: linkWho }), linkWho)}</span><button type="button" className="linkish" onClick={() => setLinkNewAt(target)}>{t('newProject.dir.linkNew')}</button></>
                  : <><span>{boldFirst(t('newProject.dir.newNote', { who: linkWho }), linkWho)}</span><button type="button" className="linkish" onClick={() => setLinkNewAt(null)}>{t('newProject.dir.linkBack', { name: link.name })}</button></>}
              </div>
            )}
            {/* まとめて登録のダイアログの「フォルダの中から」へ送る（0.6.1）。このダイアログとは入れ替わる。 */}
            <div><button type="button" className="linkish" onClick={() => emit({ type: 'project.candidates.open', source: 'folder' })}>{t('newProject.folder.bulk')}</button></div>
          </div>
          {/* 包むプロジェクトを開くときと、結び付けるときは、名前を使わない（結び付けた先の名前は変えない）ので欄を出さない。 */}
          {!nested && !linking && (
            <label className="field" htmlFor="new-project-reg-name">{t('newProject.field.name')}
              <input id="new-project-reg-name" className="input" value={name} onChange={(e) => { setNameTouched(true); setName(e.target.value); }} onKeyDown={onEnter} />
            </label>
          )}
        </>
      )}
      {/* 入れ子の 409 で断られたときは、文言の代わりにその場の 1 行と「別のプロジェクトにする」が出ている。 */}
      {props.error && !nested && <div className="error" role="alert">{props.error}</div>}
    </Dialog>
  );
}
