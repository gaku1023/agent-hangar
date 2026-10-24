import { useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { GitChipProps, GitFileRow, GitFilesView } from '../presenters/git.ts';
import { GitChip } from './GitChip.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Popover } from './primitives/Popover.tsx';

/** 1 行。状態の印、パス（長ければ頭を切る）、行の増減。onPick があれば押せる。 */
function FileRow(props: { row: GitFileRow; selected?: boolean; onPick?: (path: string) => void; label?: string }) {
  const f = props.row;
  const body = (
    <>
      {f.mark !== '' ? <span className="gitf-mark" data-s={f.status} title={f.statusLabel}>{f.mark}</span> : <Icon name="fileEdited" />}
      <span className="gitf-path mono" title={f.rel}><bdi>{f.rel}</bdi></span>
      {f.counts !== '' && <span className="gitf-counts mono" data-s={f.status}>{f.counts}</span>}
    </>
  );
  if (!props.onPick) return <li className="gitf-row" data-static="true">{body}</li>;
  return (
    <li>
      <button type="button" className="gitf-row" aria-current={props.selected ? 'true' : undefined} aria-label={props.label} onClick={() => props.onPick!(f.path)}>{body}</button>
    </li>
  );
}

/**
 * 「変更したファイル」の一覧（試作の 2-3 と 2-5）。このセッションが変えたファイルの下に、
 * 作業ツリーでほかに変わったファイルを畳んだ行で置く（2-6 の N3）。開くと「このセッションとは限りません」を添える。
 * git でないとき、他の PC、時間切れは、一覧の下の 1 行（note）で言う。
 */
export function GitFileList(props: { files: GitFilesView; selected?: string | null; onPick?: (path: string) => void; onReload?: () => void }) {
  const t = useT();
  const [others, setOthers] = useState(false);
  const v = props.files;
  if (v.state === 'loading') return <div className="gitf-note faint">{t('gitUi.files.loading')}</div>;
  return (
    <div className="gitf">
      {v.files.length > 0 && <ul className="gitf-list">{v.files.map((f) => <FileRow key={f.path} row={f} selected={f.path === props.selected} onPick={props.onPick} label={props.onPick ? t('gitUi.files.showDiffFor', { path: f.rel }) : undefined} />)}</ul>}
      {v.othersLabel !== null && (
        <div className="gitf-others">
          <button type="button" className="gitf-others-head" aria-expanded={others} onClick={() => setOthers((o) => !o)}>
            <Icon name={others ? 'chevronDown' : 'chevron'} /><span>{v.othersLabel}</span>
          </button>
          {others && (
            <>
              <ul className="gitf-list">{v.others.map((f) => <FileRow key={f.path} row={f} />)}</ul>
              <div className="gitf-note faint" title={t('gitUi.files.othersNoteTitle')}><Icon name="info" />{t('gitUi.files.othersNote')}</div>
            </>
          )}
        </div>
      )}
      {v.note && (
        <div className="gitf-note faint">
          <Icon name="info" />{v.note}
          {v.state === 'slow' && props.onReload && <> <button type="button" className="btn-link" onClick={props.onReload}>{t('gitUi.files.reload')}</button></>}
        </div>
      )}
    </div>
  );
}

/**
 * 現在の札の git の札（試作の 2-3 の A）。押すと「変更したファイル」の一覧がポップオーバーで開き、行から差分のダイアログへ進む。
 * 開くたびに一覧を読み直す（ファイルは外で変わる）。
 */
export function GitFilesPop(props: { sessionId: string; chip: GitChipProps; files: GitFilesView }) {
  const t = useT();
  const emit = useEmit();
  const title = t('gitUi.files.title');
  return (
    <Popover label={title} width={380} align="end"
      onOpenChange={(open) => { if (open) emit({ type: 'git.changes.load', sessionId: props.sessionId }); }}
      face={(p) => <button type="button" className="count-chip gitchip-btn" data-size="sm" {...p}><GitChip id={`now:${props.sessionId}`} chip={props.chip} /><Icon name="chevronDown" /></button>}>
      {({ close }) => (
        <>
          <h4 className="pop-title">{title}</h4>
          <GitFileList files={props.files} onPick={(path) => { emit({ type: 'diff.open', sessionId: props.sessionId, file: path }); close(); }} onReload={() => emit({ type: 'git.changes.load', sessionId: props.sessionId })} />
          <div className="gitf-foot">
            <button type="button" className="btn btn-sm" onClick={() => { emit({ type: 'diff.open', sessionId: props.sessionId }); close(); }}><Icon name="diff" />{t('gitUi.files.showDiff')}</button>
          </div>
        </>
      )}
    </Popover>
  );
}
