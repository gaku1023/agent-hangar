import { useId, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { LeadCardProps } from '../presenters/session.ts';
import { EditableNote } from './EditableNote.tsx';
import { sessionNoteTexts } from './NoteEditor.tsx';
import { CountChip } from './primitives/Chip.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

type Open = 'files' | 'artifacts' | null;

/**
 * 終わったセッションの、トランスクリプトの冒頭の 1 枚（設計書 2.3 の C、試作 C の `.lead-card`）。
 * 1 行目にステータスの札と、設定した日、終了、ターンとトークンとコスト、右端に要約の進捗と「要約を再生成」。
 * 続けて要約の本文、次のステップ、変更したファイルとアーティファクトと PR の札、ノート。
 * 変更したファイルとアーティファクトの札は、押すとこの 1 枚の中へ一覧が開く（同時には 1 つ）。
 * ノートはここで読み書きする（実行中は帯の札のポップオーバー）。
 */
export function LeadCard(props: LeadCardProps & { sessionId: string }) {
  const t = useT();
  const emit = useEmit();
  const uid = useId();
  const [open, setOpen] = useState<Open>(null);
  const toggle = (which: Exclude<Open, null>) => setOpen((o) => (o === which ? null : which));
  const panelId = (which: string) => `${uid}-${which}`;
  const { files, artifacts } = props;
  return (
    <section className="lead-card" aria-label={props.label}>
      <div className="lead-h">
        <span className="lead-status" data-s={props.status.value}>{props.status.label}</span>
        {props.status.since && <span className="faint">{props.status.since}</span>}
        <span className="lead-facts">
          {props.stopped ? <span>{props.stopped}</span> : props.ended && <span>{props.ended}</span>}
          {props.flags.map((f) => <span key={f}>{f}</span>)}
          <span>{props.turns}</span>
          <span>{props.tokens}</span>
          {props.cost && <span><b>{props.cost}</b></span>}
        </span>
        <span className="lead-end">
          {props.summary && <span className="faint">{props.summary.progress}</span>}
          {props.canRegenerate && <button type="button" className="btn btn-sm btn-ghost" onClick={() => emit({ type: 'summary.regenerate', sessionId: props.sessionId })}><Icon name="rebuild" />{props.regenerate}</button>}
        </span>
      </div>
      {props.notice && <div className="lead-notice" data-kind={props.notice.kind} title={props.notice.title ?? undefined}>{props.notice.text}</div>}
      {props.summary
        ? (
          <>
            <p className="sum-body">{props.summary.body}</p>
            {props.summary.nextSteps.length > 0 && (
              <>
                <div className="lead-sub">{props.summary.nextStepsLabel}</div>
                <ul className="sum-next">{props.summary.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </>
            )}
            <div className="sum-src">{props.summary.sourceLine}</div>
          </>
        )
        : props.empty && <div className="faint">{props.empty}</div>}
      <div className="lead-chips">
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
                  <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={t('session.artifact.openEditor', { title: a.title })} title={t('session.artifact.openEditor', { title: a.title })} onClick={() => emit({ type: 'artifact.openEditor', id: a.id })}>
                    <Icon name="openEditor" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="lead-note">
        <EditableNote text={props.note.text} onSave={(text) => emit({ type: 'session.setMemo', id: props.sessionId, text })} texts={sessionNoteTexts(t)}
          head={(button) => <div className="lead-note-h"><span className="lead-sub">{t('session.note.label')}</span>{button}</div>} />
      </div>
    </section>
  );
}
