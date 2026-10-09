import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { ProjectInfoProps } from '../presenters/project.ts';
import { isComposing } from './ime.ts';
import { useCopy } from './primitives/CommandLine.tsx';
import { useT } from './primitives/language.tsx';
import { InfoPopover, type PopoverRow } from './primitives/Popover.tsx';

/**
 * 1 つのプロジェクトの見出しの (i)。押すと、場所、セッションの数、最後の活動と、場所や名前を直す操作を並べた面が開く。
 * プロジェクトは作成日を持たないので、作成の行は置かない。
 * クイックセッションの置き場（スクラッチ）は、名前も場所も直せず、一覧からも消せないので、行とパスのコピーだけを出す。
 */
export function ProjectInfo(props: { id: string; name: string; path: string | null; isScratch: boolean; info: ProjectInfoProps }) {
  const t = useT();
  const rows: PopoverRow[] = [
    { name: t('projectScreen.info.place'), value: props.path ?? t('projectScreen.path.none'), mono: props.path !== null },
    { name: t('projectScreen.info.sessions'), value: props.info.sessionsText },
    { name: t('projectScreen.info.lastActivity'), value: props.info.lastActivity },
  ];
  return (
    <InfoPopover rows={rows} width={420}>
      {(api) => <ProjectActions id={props.id} name={props.name} path={props.path} isScratch={props.isScratch} close={api.close} />}
    </InfoPopover>
  );
}

/**
 * 面の下の操作。場所を再指定、パスをコピー、名前を変更、一覧から削除。
 * 場所を再指定と一覧から削除は、押すと別のダイアログが開く（削除は先に確認が出る）ので、面は閉じる。
 * 名前を変更は面の中で入力欄に替わり、Enter か保存で出す。
 */
function ProjectActions(props: { id: string; name: string; path: string | null; isScratch: boolean; close: () => void }) {
  const emit = useEmit();
  const t = useT();
  const copy = useCopy(props.path ?? '');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(props.name);
  const submit = () => {
    const next = name.trim();
    if (next !== '' && next !== props.name) emit({ type: 'project.rename', id: props.id, name: next });
    props.close();
  };
  if (renaming) {
    return (
      <div className="pop-rename">
        {/* 変換中の Enter で出すと、確定と同時に名前が変わる。 */}
        <input className="input" autoFocus aria-label={t('projectScreen.info.renameLabel')} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); submit(); } }} />
        <button type="button" className="btn btn-sm btn-primary" disabled={name.trim() === ''} onClick={submit}>{t('projectScreen.info.renameSave')}</button>
        <button type="button" className="btn btn-sm" onClick={() => { setName(props.name); setRenaming(false); }}>{t('common.button.cancel')}</button>
      </div>
    );
  }
  return (
    <div className="pop-acts">
      {!props.isScratch && <button type="button" className="btn btn-sm" onClick={() => { emit({ type: 'project.resolve.open', id: props.id }); props.close(); }}>{t('projectScreen.info.relocate')}</button>}
      {props.path !== null && <button type="button" className="btn btn-sm" data-copied={copy.copied ? 'true' : undefined} onClick={copy.press}>{copy.copied ? t('projectScreen.info.copied') : t('projectScreen.info.copyPath')}</button>}
      {!props.isScratch && <button type="button" className="btn btn-sm" onClick={() => setRenaming(true)}>{t('projectScreen.info.rename')}</button>}
      {/* 一覧から削除は同期で他の PC にも広がるので、押すと Mediator が先に確認を出す。フォルダとトランスクリプトは消えない。 */}
      {!props.isScratch && <button type="button" className="btn btn-sm btn-danger" onClick={() => { emit({ type: 'project.resolve', id: props.id, action: { kind: 'unlink' } }); props.close(); }}>{t('projectScreen.info.remove')}</button>}
    </div>
  );
}
