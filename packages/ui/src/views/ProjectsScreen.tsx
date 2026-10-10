import { formatRoute, type ProjectStatus } from '@agent-hangar/shared';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useEmit, type Emit } from '../action/chain.tsx';
import { STATUS_LABEL } from '../presenters/format.ts';
import type { ProjectNowItem, ProjectRowProps, ProjectsProps } from '../presenters/projects.ts';
import { PageHeading } from './PageHeading.tsx';
import { useFlip } from './primitives/flip.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { MenuButton, type MenuItem } from './primitives/MenuButton.tsx';
import { fitCount } from './nowFit.ts';

const STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived'];

/**
 * Projects 画面（P1、行の表）。
 * 1 行 1 プロジェクトで、ステータスの札、名前と場所、いま、セッションの数、最後の活動、「…」を並べる。
 * 節は Active、Paused、Done の順で、行の無い節は出さない。Archived は末尾の 1 行から開く。
 * 絞り込みとアーカイブの出し入れは画面内だけの一時状態なので Root が useState で持ち、props で受け取る。
 * 名前は本物のリンクで、行のほかの所を押しても開く。↓ ↑ Home End で前後の行の名前へ焦点を移す。
 * 文は辞書の鍵で引く。ステータスの札は英語のまま、両方の言語で同じ表記にする。
 */
export function ProjectsScreen(props: ProjectsProps & { filter: string; onFilter: (s: string) => void; onShowArchived: (b: boolean) => void }) {
  const emit = useEmit();
  const t = useT();
  // ステータスを変えると行が別の節へ移るので、その移動だけを FLIP で見せる。
  const keyOf = (status: string, id: string) => `${status}:${id}`;
  const flipRef = useFlip([...props.sections.flatMap((s) => s.rows.map((r) => keyOf(s.status, r.id))), ...(props.archived?.rows.map((r) => keyOf('archived', r.id)) ?? [])]);
  const table = props.empty === null;
  return (
    <div className="screen projects-screen">
      <PageHeading title={t('projects.heading.title')}>
        {props.total > 0 && <span className="faint num page-sub">{props.total}</span>}
        {props.empty !== 'none' && <input className="input" placeholder={t('projects.filter.label')} value={props.filter} onChange={(e) => props.onFilter(e.target.value)} aria-label={t('projects.filter.label')} />}
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => emit({ type: 'project.new.open' })}><Icon name="add" /><span className="btn-label">{t('projects.new.button')}</span></button>
      </PageHeading>
      {props.empty === 'none' && <EmptyCard promoteSessionId={props.promoteSessionId} />}
      {props.empty === 'noMatch' && <div className="empty">{t('projects.list.noMatch')}</div>}
      {table && (
        <div className="ptable" onKeyDown={moveFocus}>
          <div className="pcols" aria-hidden="true">
            <span>{t('projects.col.status')}</span><span>{t('projects.col.nameAndPlace')}</span><span>{t('projects.col.now')}</span><span className="pn">{t('projects.col.sessions')}</span><span className="pn">{t('projects.col.lastActivity')}</span><span />
          </div>
          <div className="plist">
            {props.sections.map((s) => (
              <section key={s.status}>
                <div className="prow-head"><span className="prow-title" role="heading" aria-level={2}><span>{STATUS_LABEL[s.status]}</span><span className="row-head-count">{s.rows.length}</span></span></div>
                <div role="list">{s.rows.map((r) => <ProjectRow key={r.id} row={r} flipRef={flipRef(keyOf(s.status, r.id))} />)}</div>
              </section>
            ))}
            {props.archived && (
              <section>
                <div className="prow-head" data-section="archived">
                  <span className="prow-title" role="heading" aria-level={2}><span>{STATUS_LABEL.archived}</span><span className="row-head-count">{props.archived.count}</span></span>
                  <button type="button" className="row-head-more" aria-expanded={props.archived.open} onClick={() => props.onShowArchived(!props.archived!.open)}>
                    {props.archived.open ? t('projects.archived.hide') : t('projects.archived.show')}<Icon name={props.archived.open ? 'chevronDown' : 'chevron'} />
                  </button>
                </div>
                <div role="list">{props.archived.rows.map((r) => <ProjectRow key={r.id} row={r} flipRef={flipRef(keyOf('archived', r.id))} />)}</div>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 名前の上で ↓ ↑ Home End を押したときに、表の中の前後の名前へ焦点を移す。 */
function moveFocus(e: KeyboardEvent<HTMLElement>) {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('pname-link')) return;
  const links = [...e.currentTarget.querySelectorAll<HTMLElement>('.pname-link')];
  const i = links.indexOf(target);
  const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? links.length - 1 : null;
  if (next === null) return;
  e.preventDefault();
  links[Math.max(0, Math.min(links.length - 1, next))]?.focus();
}

/** 「…」のメニューの項目。新しいセッション、（場所が見つからなければ）場所を再指定、いまのもの以外のステータスの順。 */
function menuItems(row: ProjectRowProps, emit: Emit, t: ReturnType<typeof useT>): MenuItem[] {
  const items: MenuItem[] = [{ key: 'new', label: t('projects.menu.newSession'), icon: 'add', onSelect: () => emit({ type: 'session.new.open', projectId: row.id }) }];
  if (row.place?.kind === 'missing') items.push({ key: 'relocate', label: t('projects.menu.relocate'), icon: 'repoint', onSelect: () => emit({ type: 'project.resolve.open', id: row.id }) });
  for (const status of STATUSES) {
    if (status === row.status) continue;
    items.push({ key: status, label: status === 'active' ? t('projects.menu.markActive') : t('projects.menu.mark', { status: STATUS_LABEL[status] }), onSelect: () => emit({ type: 'project.setStatus', id: row.id, status }) });
  }
  return items;
}

function ProjectRow(props: { row: ProjectRowProps; flipRef: (el: HTMLElement | null) => void }) {
  const emit = useEmit();
  const t = useT();
  const r = props.row;
  const open = () => emit({ type: 'project.open', id: r.id });
  return (
    <div role="listitem" ref={props.flipRef} className="prow" data-archived={r.status === 'archived' ? 'true' : undefined}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('a, button')) open(); }}>
      <span className="prow-status"><span className="row-sq" data-s={r.status}>{STATUS_LABEL[r.status]}</span></span>
      <span className="pname">
        <a className="pname-link" href={formatRoute({ name: 'project', id: r.id })} aria-label={r.label} onClick={(e) => { e.preventDefault(); open(); }}>{r.name}</a>
        {r.place?.kind === 'outside' && (
          // 頭を省略して末尾を残す（.ppath の direction）。bdi が無いと、記号で始まるパスの並びが崩れる。
          <span className="ppath mono" title={r.place.path}><bdi>{r.place.path}</bdi></span>
        )}
        {r.place?.kind === 'missing' && (
          <button type="button" className="pwarn" title={t('projects.place.missing')} onClick={() => emit({ type: 'project.resolve.open', id: r.id })}><Icon name="warning" /><span className="pwarn-text">{t('projects.place.missing')}</span></button>
        )}
      </span>
      <NowCell items={r.now} />
      <span className="pn">{r.sessionsText}</span>
      <span className="pn">{r.lastActivity}</span>
      <span className="pmore"><MenuButton label={t('projects.row.menu', { name: r.name })} items={menuItems(r, emit, t)} faceClassName="btn btn-icon pmore-btn" minWidth={200} /></span>
    </div>
  );
}

/** プロジェクトが 1 つも無い人の 1 枚。できるようになることを 2 文で言い、作る入口と、クイックセッションを昇格する入口を置く。 */
function EmptyCard(props: { promoteSessionId: string | null }) {
  const emit = useEmit();
  const t = useT();
  return (
    <div className="empty-card">
      <h2>{t('projects.empty.title')}</h2>
      <p>{t('projects.empty.body1')}</p>
      <p>{t('projects.empty.body2')}</p>
      <div className="empty-acts">
        <button className="btn btn-primary" onClick={() => emit({ type: 'project.new.open' })}><Icon name="add" />{t('projects.new.button')}</button>
        {props.promoteSessionId !== null && <button className="btn" onClick={() => emit({ type: 'session.promote.open', id: props.promoteSessionId! })}><Icon name="promote" />{t('projects.empty.promote')}</button>}
      </div>
    </div>
  );
}

/**
 * 「いま」の列。入り切らない項目は途中で切らず、丸ごと落として最後に「ほか N」を置く。
 * 落とす数は描いた後の幅で決める。項目と「ほか N」を見えない写し（.pcounts-measure）に全部並べて幅を測り、列の幅と見比べる（fitCount）。
 * 列の幅が変わったとき（窓、サイドバーの開閉）は ResizeObserver で測り直す。
 * 全文は title に持つ。読み上げの名前は行の側が全部の数を言っているので、ここは見た目だけを決める。
 */
function NowCell(props: { items: ProjectNowItem[] }) {
  const t = useT();
  const host = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(props.items.length);
  const sig = props.items.map((i) => i.text).join('|');
  useLayoutEffect(() => {
    const el = host.current;
    const m = measure.current;
    if (!el || !m) return;
    const fit = () => {
      const kids = [...m.children] as HTMLElement[];
      const moreWidth = kids[kids.length - 1]?.offsetWidth ?? 0;
      const gap = parseFloat(getComputedStyle(el).columnGap);
      setShown(fitCount(kids.slice(0, -1).map((k) => k.offsetWidth), Number.isFinite(gap) ? gap : 12, el.clientWidth, moreWidth));
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    let last = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== last) { last = el.clientWidth; fit(); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, [sig]);
  const hidden = props.items.length - Math.min(shown, props.items.length);
  const more = (n: number, measuring = false) => <span data-now-more="true" className="pcounts-more" key={measuring ? 'm' : undefined}>{t('projects.now.more', { n })}</span>;
  return (
    <span className="pnow" title={props.items.length > 0 ? props.items.map((i) => i.text).join(t('projects.now.separator')) : undefined}>
      <span ref={host} className="pcounts">
        {props.items.slice(0, props.items.length - hidden).map((n) => <span key={n.kind} data-kind={n.kind}>{n.text}</span>)}
        {hidden > 0 && more(hidden)}
      </span>
      <span ref={measure} className="pcounts-measure" aria-hidden="true">
        {props.items.map((n) => <span key={n.kind} data-kind={n.kind}>{n.text}</span>)}
        {more(props.items.length, true)}
      </span>
    </span>
  );
}
