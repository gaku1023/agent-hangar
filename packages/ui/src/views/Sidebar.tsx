import { formatRoute } from '@agent-hangar/shared';
import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { NavItem, SideLiveProps, SideLiveRow } from '../presenters/shell.ts';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';

/** 画面の名前からナビのアイコンへの対応。見た目の話なので Presenter ではなくここに置く。 */
const NAV_ICON: Record<string, IconName> = { home: 'home', projects: 'projects', sessions: 'sessions', settings: 'settings' };

/**
 * 項目に添える入力待ちの数。
 * 開いた帯では項目の右端の錠剤、畳んだ帯ではアイコンの右上の丸になる（base.css の .nav-count）。
 * 見えるのは数字だけなので、読み上げには何の数かを添える。
 */
function NavCount(props: { n: number }) {
  return <span className="nav-count"><span aria-hidden="true">{props.n}</span><span className="sr-only">、入力待ち {props.n}</span></span>;
}

/** 行を別の行の前か後ろへ移した後の並び。移す先が無ければ元のまま返す。 */
export function moveId(ids: string[], id: string, target: string, before: boolean): string[] {
  if (id === target || !ids.includes(id)) return ids;
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(target);
  if (at < 0) return ids;
  rest.splice(before ? at : at + 1, 0, id);
  return rest;
}

/** 行を 1 つ上か下へずらした後の並び。端ではそのまま返す。 */
export function nudgeId(ids: string[], id: string, delta: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const out = [...ids];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/**
 * 「動いている」の節。
 * 行を押すとそのセッションへ移る。行を掴んで上下に動かすと並べ替えられ、並びは端末が覚える（sidebar.order）。
 * キーボードでは、行に焦点があるときに ⌥↑ と ⌥↓ で 1 つずつ動かす。
 * 動かすのは行だけで、見出しは動かない。ドラッグの途中の印（入る場所の線）は、ここだけで持つ。
 * 畳んだ帯では点だけを縦に並べ、名前は title に持つ（base.css）。
 */
function LiveSection(props: { live: SideLiveProps }) {
  const emit = useEmit();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; before: boolean } | null>(null);
  const { live } = props;
  if (live.count === 0) return null;
  const end = () => { setDrag(null); setOver(null); };
  const onDragOver = (e: DragEvent, r: SideLiveRow) => {
    if (drag === null || drag === r.id) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < box.top + box.height / 2;
    if (over?.id !== r.id || over.before !== before) setOver({ id: r.id, before });
  };
  const onDrop = (e: DragEvent, r: SideLiveRow) => {
    if (drag === null || drag === r.id) return;
    e.preventDefault();
    const ids = moveId(live.ids, drag, r.id, over?.id === r.id ? over.before : true);
    end();
    if (ids !== live.ids) emit({ type: 'sidebar.order', ids });
  };
  const onKeyDown = (e: KeyboardEvent, r: SideLiveRow) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const ids = nudgeId(live.ids, r.id, e.key === 'ArrowUp' ? -1 : 1);
    if (ids !== live.ids) emit({ type: 'sidebar.order', ids });
  };
  return (
    <section className="side-live" aria-label="動いているセッション">
      <h2 className="side-live-h">動いている<span className="side-live-n">{live.count}</span></h2>
      <ul className="side-live-list">
        {live.rows.map((r) => (
          <li key={r.id}>
            <a className="side-live-row" href={formatRoute({ name: 'session', id: r.id })} draggable aria-current={r.current ? 'page' : undefined}
              data-live={r.live ?? undefined} data-dragging={drag === r.id ? 'true' : undefined} data-over={over?.id === r.id ? (over.before ? 'before' : 'after') : undefined}
              title={r.waited ? `${r.name}（${r.waited}）` : r.name}
              onClick={(e) => { e.preventDefault(); emit({ type: 'session.open', id: r.id }); }} onKeyDown={(e) => onKeyDown(e, r)}
              onDragStart={(e) => { setDrag(r.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); }}
              onDragOver={(e) => onDragOver(e, r)} onDragLeave={() => { if (over?.id === r.id) setOver(null); }} onDrop={(e) => onDrop(e, r)} onDragEnd={end}>
              <StatusDot status={r.live} /><span className="side-live-name">{r.name}</span>{r.waited && <span className="side-live-wait num">{r.waited}</span>}
            </a>
          </li>
        ))}
      </ul>
      {live.more > 0 && <a className="side-live-more" href={formatRoute(HOME)} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: HOME }); }}>ほか {live.more} 件</a>}
    </section>
  );
}

/** 「ほか N 件」の行き先。ホームの実行中と要対応に全部が並ぶ。 */
const HOME = { name: 'home' } as const;

export function Sidebar(props: { nav: NavItem[]; collapsed: boolean; live: SideLiveProps }) {
  const emit = useEmit();
  const item = (n: NavItem) => (
    <a key={n.label} className="nav-item" href={formatRoute(n.route)} aria-current={n.current ? 'page' : undefined} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: n.route }); }}>{NAV_ICON[n.route.name] && <Icon name={NAV_ICON[n.route.name]!} />}<span className="nav-label">{n.label}</span>{n.count > 0 && <NavCount n={n.count} />}</a>
  );
  const toggle = (
    <button className="btn sidebar-toggle" aria-controls="sidebar" aria-expanded={!props.collapsed} aria-label={props.collapsed ? 'サイドバーを開く' : 'サイドバーを閉じる'} onClick={() => emit({ type: 'sidebar.toggle' })}><Icon name="sidebar" /><span className="toggle-tip" aria-hidden="true">{props.collapsed ? '開く' : '閉じる'}<kbd>⌘B</kbd></span></button>
  );
  const [first, ...rest] = props.nav;
  return (
    <nav id="sidebar" className="sidebar" aria-label="主ナビゲーション">
      {/* ロゴはヘッダへ移した。開閉のボタンは、開いた帯では最初の項目（ホーム）の行の右端に、畳んだ帯では帯の一番上に置く（base.css の .nav-row）。開閉の間は、その 2 か所を滑って移る。
          2 つの形は CSS だけで作り、DOM の組み立ては変えない。開閉の動きは、開閉の印だけを一瞬戻して前の形を測るからである（sidebarMotion.ts）。 */}
      <div className="nav-row">{first && item(first)}{toggle}</div>
      {rest.map(item)}
      <LiveSection live={props.live} />
    </nav>
  );
}
