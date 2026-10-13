import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { FolderRegisterItem } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import { homePath } from '../lib/paths.ts';
import type { FolderBrowseProps, FolderRow } from '../presenters/projectCandidates.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/** 小さなチェック。3 状態（一部だけ選んだ「−」）を持てる。 */
/** gray は登録済みの外せない灰のチェックである。 */
export function Check(props: { label: string; title?: string; checked: boolean | 'mixed'; disabled?: boolean; gray?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="checkbox" aria-label={props.label} title={props.title} aria-checked={props.checked} disabled={props.disabled} data-gray={props.gray ? 'true' : undefined} className="cand-check" onClick={() => props.onChange(props.checked !== true)}>
      <Icon name={props.checked === 'mixed' ? 'minus' : 'check'} />
    </button>
  );
}

/** 選べる行の一覧で、次の 1 行。group は 1 段下の行のときの親の行である。 */
type Entry = { row: FolderRow; group: FolderRow | null };

/**
 * まとめて登録の「フォルダの中から」の中身（0.6.1、試作 proto-register の推す案）。
 * 頭に親フォルダの欄と「選ぶ…」、その直下を名前順に並べ、行ごとに押すと何が起きるかを名前の下の 1 行で言う。
 * 開いた時点では何もチェックしない（利用者の答え）。「すべて選択」は一覧の頭の 3 状態のチェックで、選べる行だけを入れる。
 * 選んだものは送るまで外へ出ないので、Mediator ではなくここに持つ。ダイアログの足元が件数と送る中身を使うので、フックで返す。
 */
export function useFolderBrowse(b: FolderBrowseProps, active: boolean) {
  const emit = useEmit();
  const t = useT();
  const [input, setInput] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  // 結び付く行のうち、利用者が「新しく作る」に切り替えたもの。
  const [makeNew, setMakeNew] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [gitOnly, setGitOnly] = useState(false);
  // 作成場所にするチェックは、開いた時点では入れない。入れると直下の会話のある行が自動の登録でチェックされ、開いた時点で何もチェックしない決まり（利用者の答え）と食い違うからである。
  const [useRoot, setUseRoot] = useState(false);
  const loaded = useRef<string | null>(null);
  // Finder の結果は、この欄の「選ぶ…」を押した後に届いたものだけを入れる（ParentField と同じ）。
  const seen = useRef(b.picked?.n ?? 0);
  const waiting = useRef(false);

  const load = (raw: string) => {
    const p = raw.trim();
    if (!p) return;
    loaded.current = p;
    emit({ type: 'project.folders.load', parent: p });
  };
  // 開いた時点の親（作成場所か、会話の多い親）が決まったら、一度だけ入れてすぐ直下を読む。
  useEffect(() => {
    if (!active || seeded || b.initialParent === undefined) return;
    setSeeded(true);
    if (b.initialParent === null) return;
    setInput(b.initialParent);
    load(b.initialParent);
  }, [active, b.initialParent]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const p = b.picked;
    if (!p || p.n <= seen.current) return;
    seen.current = p.n;
    if (!waiting.current) return;
    waiting.current = false;
    const label = homePath(p.path, b.home);
    setInput(label);
    load(label);
  }, [b.picked?.n]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 親が変わったら、前の一覧の選択と絞り込みは捨てる（同じパスの行は無い）。
  useEffect(() => {
    setChecked(new Set());
    setMakeNew(new Set());
    setExpanded(new Set());
    setGitOnly(false);
  }, [b.parent?.path]);

  const ready = b.status === 'ready';
  const root = ready && b.rootable && useRoot ? b.parent : null;
  // 作成場所にする親の直下で会話のあるフォルダは、保存のときにサーバが自動で登録するので、外せないチェックにする。
  const locked = (r: FolderRow, group: FolderRow | null) => root !== null && group === null && !r.registered && r.sessions > 0;
  const shown = (r: FolderRow) => !gitOnly || r.git || r.children !== null;
  // 「すべて選択」の対象。登録済み、自動で登録するもの、worktree、別のプロジェクトの中は入れない（親そのものが中にあり帯で言ったときは入れる）。
  // 自動で登録するフォルダの 1 段下は、そのフォルダのプロジェクトの中になるので選ばせない（選んでも入れ子で断られる）。
  const underLocked = (group: FolderRow | null) => group !== null && locked(group, null);
  const pickable = (r: FolderRow, group: FolderRow | null) => !r.registered && !locked(r, group) && !underLocked(group) && !r.worktree && (!r.inside || b.band !== null) && (!gitOnly || r.git);
  const entries: Entry[] = ready ? b.rows.filter(shown).flatMap((r) => [{ row: r, group: null }, ...(r.children ?? []).filter(shown).map((c) => ({ row: c, group: r }))]) : [];
  const targets = entries.filter((e) => (e.group === null ? !(e.row.children && expanded.has(e.row.path)) : expanded.has(e.group.path)) && pickable(e.row, e.group));
  const on = (r: FolderRow, group: FolderRow | null) => r.registered || locked(r, group) || (!underLocked(group) && checked.has(r.path));
  const picked = targets.filter((e) => checked.has(e.row.path)).length;
  const head: boolean | 'mixed' = targets.length > 0 && picked === targets.length ? true : picked > 0 ? 'mixed' : false;

  /** 1 行を入れ外しする。1 段下を開いたフォルダは、親と子を同時には選ばない（親を選べば子を外し、子を選べば親を外す）。 */
  const setOn = (next: Set<string>, r: FolderRow, group: FolderRow | null, v: boolean) => {
    if (!v) { next.delete(r.path); return; }
    next.add(r.path);
    if (group) next.delete(group.path);
    for (const c of r.children ?? []) next.delete(c.path);
  };
  const toggle = (r: FolderRow, group: FolderRow | null, v: boolean) => setChecked((cur) => { const next = new Set(cur); setOn(next, r, group, v); return next; });
  const toggleAll = (v: boolean) => setChecked((cur) => { const next = new Set(cur); for (const e of targets) setOn(next, e.row, e.group, v); return next; });
  const flip = (set: (f: (cur: Set<string>) => Set<string>) => void, path: string) => set((cur) => { const next = new Set(cur); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const linking = (r: FolderRow, group: FolderRow | null) => r.link !== null && (locked(r, group) || !makeNew.has(r.path));

  // 送るもの。git のフォルダだけに絞って隠した行は送らない。登録済みはすでにあるので送らない。
  const chosen = entries.filter((e) => !e.row.registered && on(e.row, e.group));
  const items: FolderRegisterItem[] = chosen.map(({ row: r, group }) => ({
    path: r.path,
    // 自動で登録する行は、サーバが自動の登録で結び付けるので、結び付け先を添えない。
    ...(r.link && !locked(r, group) && !makeNew.has(r.path) ? { linkTo: r.link.projectId } : {}),
    ...(r.inside ? { allowNested: true } : {}),
  }));
  const linkCount = chosen.filter((e) => linking(e.row, e.group)).length;

  const onParentKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    load(input);
  };
  const parentLabel = t('newProject.browse.parent');

  const line = ({ row: r, group }: Entry) => {
    const lock = r.registered || locked(r, group) || underLocked(group);
    const open = expanded.has(r.path);
    const name = group ? `${group.name}/${r.name}` : r.name;
    let small: ReactNode = r.note;
    if (r.link) {
      const asNew = !locked(r, group) && makeNew.has(r.path);
      small = (
        <>
          {asNew ? t('newProject.browse.willCreate') : r.link.note}
          {!locked(r, group) && <button type="button" className="linkish" onClick={() => flip(setMakeNew, r.path)}>{asNew ? t('newProject.browse.linkBack') : t('newProject.browse.makeNew')}</button>}
        </>
      );
    }
    return (
      <div key={r.path} className="cand-row reg-row" data-depth={group ? '1' : undefined} data-off={r.registered || r.worktree || (r.inside && b.band === null) ? 'true' : undefined} data-locked={lock ? 'true' : undefined}>
        <Check label={name} title={locked(r, group) ? t('newProject.candidates.auto') : underLocked(group) ? t('newProject.browse.underAuto', { name: group!.name }) : undefined} checked={on(r, group)} disabled={lock} gray={r.registered} onChange={(v) => toggle(r, group, v)} />
        <span className="cand-path">
          {r.children
            ? <button type="button" className="reg-fold" aria-expanded={open} onClick={() => flip(setExpanded, r.path)}><Icon name={open ? 'chevronDown' : 'chevron'} /><span className="mono" title={r.path}>{r.name}</span></button>
            : <span className="mono" title={r.path}>{r.name}</span>}
          {small && <small>{small}</small>}
        </span>
        <span className="reg-git">{r.git && <Icon name="branch" label={t('newProject.browse.gitMark')} />}</span>
        <span className="cand-count" data-zero={r.sessions === 0 ? 'true' : undefined} aria-label={r.countLabel}>{r.count}</span>
        <span className="cand-when">{r.when}</span>
      </div>
    );
  };

  let list: ReactNode;
  if (b.status === 'idle') list = input.trim() === '' ? <div className="faint">{t('newProject.browse.noParent')}</div> : null;
  else if (b.status === 'loading') list = <div className="faint">{t('newProject.browse.loading')}</div>;
  else if (b.status === 'failed') list = <div className="error" role="alert">{t('newProject.browse.loadFailed', { reason: b.failure ?? '' })}</div>;
  else if (b.rows.length === 0) list = <div className="faint">{t('newProject.browse.empty')}</div>;
  else list = (
    <div className="cand-list" role="group" aria-label={t('newProject.browse.listAria', { path: b.parent?.label ?? '' })}>
      <div className="cand-head">
        <Check label={t('newProject.browse.selectAll')} checked={head} disabled={targets.length === 0} onChange={toggleAll} />
        <span className="h-all">{t('newProject.browse.selectAll')}<span className="faint">{t('newProject.browse.selectAllCount', { n: picked, total: targets.length })}</span></span>
        <span className="reg-filter"><Check label={t('newProject.browse.gitOnly')} checked={gitOnly} onChange={setGitOnly} />{t('newProject.browse.gitOnly')}</span>
        <span className="h-c">{t('newProject.browse.colGit')}</span>
        <span className="h-r">{t('newProject.browse.colCount')}</span>
        <span className="h-r">{t('newProject.browse.colLast')}</span>
      </div>
      {entries.filter((e) => e.group === null || expanded.has(e.group.path)).map(line)}
      {entries.length === 0 && <div className="cand-empty">{t('newProject.browse.noGit')}</div>}
    </div>
  );

  const sum: ReactNode[] = [];
  if (items.length - linkCount > 0) sum.push(<span key="new">{t('newProject.browse.sumNew')} <b>{t('newProject.browse.sumCount', { n: items.length - linkCount })}</b></span>);
  if (linkCount > 0) sum.push(<span key="link">{sum.length ? t('common.list.separator') : ''}{t('newProject.browse.sumLink')} <b>{t('newProject.browse.sumCount', { n: linkCount })}</b></span>);

  const body = (
    <>
      <div className="field">{parentLabel}
        <div className="reg-parent">
          <input className="input mono" aria-label={parentLabel} placeholder={t('newProject.browse.parentPlaceholder')} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onParentKey} onBlur={() => { if (input.trim() !== (loaded.current ?? '')) load(input); }} />
          {b.desktop && (
            <button type="button" className="btn" aria-label={t('home.band.actionFor', { action: t('newProject.parent.pick'), name: parentLabel })} onClick={() => { waiting.current = true; emit({ type: 'folder.pick' }); }}>
              <Icon name="folderOpen" />{t('newProject.parent.pick')}
            </button>
          )}
        </div>
        <span className="reg-note">{t('newProject.browse.parentNote')}</span>
      </div>
      {ready && b.band && (
        <div className="rh-band" role="note"><Icon name="warning" /><div><b>{t('newProject.browse.bandTitle', { name: b.band })}</b><span>{t('newProject.browse.bandNote', { name: b.band })}</span></div></div>
      )}
      {list}
      {sum.length > 0 && <div className="reg-sum">{sum}</div>}
      {ready && b.rootable && b.parent && (
        <div className="cand-root">
          <Check label={t('newProject.candidates.suggest', { path: b.parent.label })} checked={useRoot} onChange={setUseRoot} />
          <span>{t('newProject.candidates.suggest', { path: b.parent.label })}<small>{t('newProject.candidates.suggestNote')}</small></span>
        </div>
      )}
    </>
  );
  return { body, items, workspaceRoot: root?.path ?? null, ready };
}
