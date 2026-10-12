import { useEffect, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { CandidateRow, ProjectCandidatesProps } from '../presenters/projectCandidates.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/** 小さなチェック。行の頭と、作成場所の行に置く。 */
function Check(props: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="checkbox" aria-label={props.label} aria-checked={props.checked} disabled={props.disabled} className="cand-check" onClick={() => props.onChange(!props.checked)}>
      <Icon name="check" />
    </button>
  );
}

/**
 * Claude Code と会話したフォルダの候補のダイアログ（初日のプロジェクト。2026-10-13、試作の 4 節 3b の案 B）。
 * 会話の多いフォルダ（よく使うフォルダ）は開いてチェックしておき、そのほかは畳んで件数だけを見せる。
 * 過半が同じ親にあるときは、その親を新しいフォルダの作成場所にするチェックを出す（既定で入れる）。
 * 作成場所にすると、その直下にある会話したフォルダはサーバが自動で登録するので、該当する行は外せないチェックにする。
 * 選んだものは、送るまで外へ出ないので、Mediator ではなくここに持つ。
 */
export function ProjectCandidatesDialog(props: ProjectCandidatesProps) {
  const emit = useEmit();
  const t = useT();
  const ready = props.status === 'ready';
  const [checked, setChecked] = useState<Set<string>>(() => new Set(props.frequent.map((r) => r.path)));
  const [useRoot, setUseRoot] = useState(props.suggestedRoot !== null);
  const [othersOpen, setOthersOpen] = useState(false);
  // 候補は開いた後に届くので、届いたときに一度だけ、よく使うフォルダと作成場所のチェックを入れておく。
  const [seeded, setSeeded] = useState(ready);
  useEffect(() => {
    if (!ready || seeded) return;
    setSeeded(true);
    setChecked(new Set(props.frequent.map((r) => r.path)));
    setUseRoot(props.suggestedRoot !== null);
  }, [ready]);   // eslint-disable-line react-hooks/exhaustive-deps

  const root = useRoot ? props.suggestedRoot : null;
  const locked = (r: CandidateRow) => root !== null && r.parent === root.path;
  const all = [...props.frequent, ...props.others];
  const paths = all.filter((r) => checked.has(r.path) || locked(r)).map((r) => r.path);
  // よく使うものが無ければ、畳まずに並べる（畳むと何も見えないため）。
  const showOthers = othersOpen || props.frequent.length === 0;
  const toggle = (path: string, on: boolean) => setChecked((cur) => {
    const next = new Set(cur);
    if (on) next.add(path); else next.delete(path);
    return next;
  });
  const close = () => emit({ type: 'overlay.close' });
  const submit = () => {
    if (props.submitting || !ready || (paths.length === 0 && root === null)) return;
    emit({ type: 'project.candidates.submit', paths, workspaceRoot: root?.path ?? null });
  };

  const line = (r: CandidateRow) => (
    <div key={r.path} className="cand-row" data-locked={locked(r) ? 'true' : undefined}>
      <Check label={r.label} checked={checked.has(r.path) || locked(r)} disabled={locked(r)} onChange={(v) => toggle(r.path, v)} />
      <span className="cand-path">
        <span className="mono" title={r.path}>{r.label}</span>
        {(r.worktrees || locked(r)) && <small>{[r.worktrees, locked(r) ? t('newProject.candidates.auto') : null].filter(Boolean).join(t('common.list.separator'))}</small>}
      </span>
      <span className="cand-count" aria-label={r.countLabel}>{r.count}</span>
      <span className="cand-when">{r.when}</span>
    </div>
  );

  let body;
  if (props.status === 'loading') body = <div className="faint">{t('newProject.candidates.loading')}</div>;
  else if (props.status === 'failed') body = <div className="error" role="alert">{t('newProject.candidates.loadFailed')}</div>;
  else if (all.length === 0) body = <div className="faint">{t('newProject.candidates.empty')}</div>;
  else body = (
    <>
      <div className="cand-list" role="group" aria-label={t('newProject.candidates.listAria')}>
        {props.frequent.length > 0 && <div className="cand-sec">{t('newProject.candidates.frequent')}<span className="cand-sec-note">{t('newProject.candidates.frequentNote', { n: props.frequentMin })}</span></div>}
        {props.frequent.map(line)}
        {props.others.length > 0 && props.frequent.length > 0 && (
          <button type="button" className="cand-fold" aria-expanded={showOthers} onClick={() => setOthersOpen((o) => !o)}>
            <Icon name={showOthers ? 'chevronDown' : 'chevron'} />{t('newProject.candidates.others', { n: props.others.length })}<span className="faint">{t('newProject.candidates.othersNote', { n: props.othersMax })}</span>
          </button>
        )}
        {showOthers && props.others.map(line)}
      </div>
      {props.suggestedRoot && (
        <div className="cand-root">
          <Check label={t('newProject.candidates.suggest', { path: props.suggestedRoot.label })} checked={useRoot} onChange={setUseRoot} />
          <span>{t('newProject.candidates.suggest', { path: props.suggestedRoot.label })}<small>{t('newProject.candidates.suggestNote')}</small></span>
        </div>
      )}
    </>
  );

  // 選んだものを押し違いで失わないよう、背景では閉じない。
  return (
    <Dialog
      title={t('newProject.candidates.title')}
      icon="folderPlus"
      className="dialog-wide dialog-candidates"
      onClose={close}
      closeOnBackdrop={false}
      footer={<>
        <span className="cand-excl">{t('newProject.candidates.excluded')}</span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={close}>{t('common.button.cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={props.submitting || !ready || (paths.length === 0 && root === null)} onClick={submit}>{t('newProject.candidates.submit', { n: paths.length })}</button>
      </>}
    >
      <div className="faint">{t('newProject.candidates.lead')}</div>
      {body}
      {props.error && <div className="error" role="alert">{props.error}</div>}
    </Dialog>
  );
}
