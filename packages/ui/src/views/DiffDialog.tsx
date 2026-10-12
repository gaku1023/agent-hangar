import { useEffect, type KeyboardEvent } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { DiffLine, DiffHunk } from '../presenters/diff.ts';
import type { DiffDialogProps } from '../presenters/git.ts';
import { isComposing } from './ime.ts';
import { GitChip } from './GitChip.tsx';
import { GitFileList } from './GitFiles.tsx';
import { Dialog } from './primitives/Dialog.tsx';
import { Hl } from './primitives/Hl.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Segmented } from './primitives/Segmented.tsx';

/** ハンクの並びを、トランスクリプトの差分と同じ部品（.tdiff の行）で描く。畳まない。 */
export function DiffRows(props: { hunks: DiffHunk[] }) {
  const t = useT();
  return (
    <div className="tdiff">
      {props.hunks.map((h, hi) => (
        <div key={hi}>
          {h.header && <div className="hunk">{h.header}</div>}
          {h.lines.map((l: DiffLine, i) => (l.t === 'gap'
            ? <div key={i} className="dgap">{t('transcript.diff.gap', { n: l.count })}</div>
            : (
              <div key={i} className="dl" data-t={l.t}>
                <span className="n">{l.old ?? ''}</span><span className="n">{l.new ?? ''}</span>
                <span className="s">{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}</span>
                <span className="x"><Hl text={l.text} /></span>
              </div>
            )))}
        </div>
      ))}
    </div>
  );
}

/**
 * 差分のダイアログ（試作の 2-5 の A）。読むだけ。
 * 左に「変更したファイル」（このセッションが Edit、Write などで変えたもの）、右に選んだファイルの差分。
 * 上の切り替えは「作業ツリーとの差（git）」と「このセッションの編集」で、git でなければ後者だけ。
 * 下端の主ボタンは、選んだエディタで差分の最初に変わった行を開く。↑↓ でファイルを替え、e で開く。
 * 開いたら一覧を、ファイルか出どころが替わったら右の中身を読み直す（ファイルは外で変わる）。
 */
export function DiffDialog(props: DiffDialogProps) {
  const t = useT();
  const emit = useEmit();
  const sid = props.sessionId;
  useEffect(() => { emit({ type: 'git.changes.load', sessionId: sid }); }, [emit, sid]);
  const loadKey = props.load ? JSON.stringify(props.load) : '';
  useEffect(() => { if (props.load) emit(props.load); }, [emit, loadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (path: string) => emit({ type: 'diff.select', file: path });
  const open = () => { if (props.selected) emit({ type: 'session.openFile', sessionId: sid, path: props.selected, line: props.line }); };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey || isComposing(e)) return;
    const el = e.target as HTMLElement;
    if (el.closest('input, textarea, [role="radiogroup"]')) return;
    const list = props.files.files;
    const i = list.findIndex((f) => f.path === props.selected);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { e.preventDefault(); pick(next.path); }
    } else if (e.key === 'e') { e.preventDefault(); open(); }
  };

  const b = props.body;
  return (
    <Dialog title={t('gitUi.files.title')} icon="diff" className="dialog-diff" onClose={() => emit({ type: 'overlay.close' })} onKeyDown={onKeyDown}
      titleAside={<span className="diff-aside"><span className="faint diff-name">{props.name}</span>{props.chip && <GitChip id={`diff:${sid}`} chip={props.chip} />}</span>}
      footer={(
        <>
          <span className="faint diff-keys"><kbd className="mono">↑</kbd><kbd className="mono">↓</kbd> {t('gitUi.diff.keyFiles')}　<kbd className="mono">e</kbd> {props.openLabel}</span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => emit({ type: 'overlay.close' })}>{t('common.button.close')}</button>
          <button type="button" className="btn btn-primary" disabled={!props.selected} onClick={open}><Icon name="openEditor" />{props.openLabel}</button>
        </>
      )}>
      <div className="diff-bar">
        {props.canGit
          ? <Segmented size="sm" label={t('gitUi.diff.sourceLabel')} value={props.source} options={[{ value: 'git', label: t('gitUi.diff.sourceGit') }, { value: 'session', label: t('gitUi.diff.sourceSession') }]} onChange={(v) => emit({ type: 'diff.source', source: v as 'git' | 'session' })} />
          : <span className="faint">{t('gitUi.diff.sourceSession')}</span>}
        <span className="spacer" />
        <span className="faint">{t('gitUi.diff.readOnly')}</span>
      </div>
      <div className="diff-grid">
        <div className="diff-files">
          <GitFileList files={props.files} selected={props.selected} onPick={pick} onReload={() => emit({ type: 'git.changes.load', sessionId: sid })} />
        </div>
        <div className="diff-main">
          {props.selectedRow && (
            <div className="diff-file-head">
              {props.selectedRow.mark !== '' && <span className="gitf-mark" data-s={props.selectedRow.status}>{props.selectedRow.mark}</span>}
              <span className="mono diff-file-path">{props.selectedRow.rel}</span>
              {props.selectedRow.statusLabel !== '' && <span className="faint">{props.selectedRow.statusLabel}</span>}
            </div>
          )}
          {b.kind === 'loading' && <div className="faint">{t('gitUi.files.loading')}</div>}
          {b.kind === 'note' && <div className="diff-note faint"><Icon name="info" />{b.text}</div>}
          {b.kind === 'hunks' && (
            <>
              <DiffRows hunks={b.hunks} />
              {b.truncated && <div className="diff-note faint">{t('gitUi.diff.truncated')}</div>}
            </>
          )}
          {b.kind === 'edits' && (
            <>
              {b.items.map((it) => (
                <div key={it.key} className="diff-edit">
                  <div className="diff-edit-head faint">{it.head}</div>
                  <DiffRows hunks={it.hunks} />
                </div>
              ))}
              <div className="diff-note faint"><Icon name="info" />{t('gitUi.diff.editsNote')}</div>
            </>
          )}
          {!props.canGit && props.files.state !== 'loading' && <div className="diff-note faint">{t('gitUi.diff.noGit')}</div>}
        </div>
      </div>
    </Dialog>
  );
}
