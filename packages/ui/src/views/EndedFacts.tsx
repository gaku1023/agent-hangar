import { useId, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { LeadCardProps, SessionGitView } from '../presenters/session.ts';
import { GitChip } from './GitChip.tsx';
import { CountChip } from './primitives/Chip.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { useEditorLabels } from './primitives/editorName.tsx';

type Open = 'files' | 'artifacts' | null;

/**
 * 終わったセッションの、見出しの下の小さい 1 行（2026-10-16 の試作の H1）。
 * ステータスの札（見出しに状態の札があるときは出さない）と設定した日、終了（止めた知らせ、中断）、「要約のみ」などの印、ターン、トークンとコスト、
 * git の札、変更したファイルとアーティファクトの札、PR を並べる。
 * 変更したファイルとアーティファクトの札は、押すとこの 1 行の下へ一覧が開く（同時には 1 つ）。
 * 変更したファイルの一覧の下に、差分のダイアログの入口を置く。
 * 要約は右の欄の要約の札（SummaryCard）にあり、ここには置かない。
 */
export function EndedFacts(props: LeadCardProps & { sessionId: string; /** git の札（読むだけ）。 */ git?: SessionGitView | null; /** 状態を見出しの札（4A）が出しているか。出していれば、ここには状態の札を置かず、設定した日だけを残す。 */ statusInHeading?: boolean }) {
  const t = useT();
  const editorLabels = useEditorLabels();
  const emit = useEmit();
  const uid = useId();
  const [open, setOpen] = useState<Open>(null);
  const toggle = (which: Exclude<Open, null>) => setOpen((o) => (o === which ? null : which));
  const panelId = (which: string) => `${uid}-${which}`;
  const { files, artifacts } = props;
  return (
    <div className="ended-facts" role="group" aria-label={props.label}>
      <div className="ef-line">
        {!props.statusInHeading && <span className="lead-status" data-s={props.status.value} data-auto={props.status.auto ? 'true' : undefined} title={props.status.title}>{props.status.auto && <Icon name="autoMark" />}{props.status.label}</span>}
        {props.status.since && <span>{props.status.since}</span>}
        {props.stopped ? <span>{props.stopped}</span> : props.interrupted ? <span className="lead-interrupted"><span className="int-ring" aria-hidden="true" />{props.interrupted}</span> : props.ended && <span>{props.ended}</span>}
        {props.flags.map((f) => <span key={f}>{f}</span>)}
        <span>{props.turns}</span>
        <span>{props.tokens}</span>
        {props.cost && <span>{props.cost}</span>}
        {props.git?.chip && <span className="chip lead-git"><GitChip id={`lead:${props.sessionId}`} chip={props.git.chip} /></span>}
        {files.count > 0 && <CountChip size="sm" label={files.label} count={files.count} icon="fileEdited" expanded={open === 'files'} aria-controls={open === 'files' ? panelId('files') : undefined} onClick={() => toggle('files')} />}
        {artifacts.count > 0 && <CountChip size="sm" label={artifacts.label} count={artifacts.count} icon="artifacts" expanded={open === 'artifacts'} aria-controls={open === 'artifacts' ? panelId('artifacts') : undefined} onClick={() => toggle('artifacts')} />}
        {props.pr && <a className="chip lead-pr" href={props.pr.url} target="_blank" rel="noreferrer"><Icon name="externalLink" />{props.pr.label}</a>}
      </div>
      {open === 'files' && (
        <div id={panelId('files')} className="lead-panel" role="region" aria-label={files.label}>
          <ul className="lead-files">
            {files.rows.map((f) => (
              <li key={f.path}>
                <button type="button" className="lead-file" title={f.openLabel} aria-label={f.openLabel} onClick={() => emit({ type: 'session.openFile', sessionId: props.sessionId, path: f.path })}>
                  <Icon name={f.created ? 'fileNew' : 'fileEdited'} />
                  <span className="lead-file-path mono"><span className="faint">{f.dir}</span>{f.base}</span>
                  {f.created && <span className="lead-file-new">{t('session.files.new')}</span>}
                  {f.byAgent && <span className="faint lead-file-agent">{f.byAgent}</span>}
                  {f.added === null
                    ? f.edits && <span className="faint mono lead-file-edits">{f.edits}</span>
                    : <><span className="lead-file-add mono">+{f.added}</span>{f.removed ? <span className="lead-file-del mono">−{f.removed}</span> : null}</>}
                </button>
              </li>
            ))}
          </ul>
          {files.note && <div className="lead-panel-note faint">{files.note}</div>}
          {/* 差分のダイアログの入口（git の表示、試作の 2-3 の共通の 1 枚）。git でないフォルダでも、このセッションの編集を読める。 */}
          <div className="lead-panel-foot"><button type="button" className="btn btn-sm" onClick={() => emit({ type: 'diff.open', sessionId: props.sessionId })}><Icon name="diff" />{t('gitUi.files.showDiff')}</button></div>
        </div>
      )}
      {open === 'artifacts' && (
        <div id={panelId('artifacts')} className="lead-panel" role="region" aria-label={artifacts.label}>
          <ul className="ns-arts">
            {artifacts.items.map((a) => (
              <li key={a.id} className="ns-art">
                <button type="button" className="ns-art-open" title={a.description ?? t('session.artifact.openHint')} onClick={() => emit({ type: 'artifact.open', id: a.id })}>
                  <span className="ns-art-icon" aria-hidden="true">{a.favicon}</span>
                  <span className="ns-art-title">{a.title}</span>
                  <span className="ns-art-when faint">{t('session.artifact.lastPublished', { when: a.lastPublished })}</span>
                </button>
                {a.canOpenEditor && (
                  <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={editorLabels.openFor(a.title)} title={editorLabels.openFor(a.title)} onClick={() => emit({ type: 'artifact.openEditor', id: a.id })}>
                    <Icon name="openEditor" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
