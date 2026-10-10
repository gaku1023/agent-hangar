import { formatRoute } from '@agent-hangar/shared';
import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { NavItem, SideLiveProps, SideLiveRow } from '../presenters/shell.ts';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { MenuPop, type MenuAnchor, type MenuCloseHow, type MenuItem } from './primitives/MenuButton.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';

/** 画面の名前からナビのアイコンへの対応。見た目の話なので Presenter ではなくここに置く。 */
const NAV_ICON: Record<string, IconName> = { home: 'home', projects: 'projects', settings: 'settings' };

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
 * 「実行中」の節。
 * 行を押すとそのセッションへ移る。行を掴んで上下に動かすと並べ替えられ、並びは端末が覚える（sidebar.order）。
 * キーボードでは、行に焦点があるときに ⌥↑ と ⌥↓ で 1 つずつ動かす。
 * 動かすのは行だけで、見出しは動かない。ドラッグの途中の印（入る場所の線）は、ここだけで持つ。
 * 畳んだ帯では点だけを縦に並べ、名前は title に持つ（base.css）。
 * 行を右クリックするか、行に焦点があるときに . を押すと、その行のメニューを出す。中身は「停止」だけで、画面を移らずに Claude を終わらせるためのものである。
 * メニューは節に 1 つだけ持ち、開いている行には印（data-menu）を付けて、どの行のものかを見せる。
 */
function LiveSection(props: { live: SideLiveProps }) {
  const emit = useEmit();
  const t = useT();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; before: boolean } | null>(null);
  // 開いているメニュー。at は吊るす相手で、右クリックなら押した点、打鍵なら行の矩形。
  const [menu, setMenu] = useState<{ id: string; at: MenuAnchor } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const anchor = useCallback(() => menu?.at ?? null, [menu]);
  // 開いている間に行が消えたら（ほかの場所で止めた、Claude が自分で終わった）、開いていたことも忘れる。同じ行がまた現れたときに、勝手に開き直さないためである。
  const gone = menu !== null && !props.live.rows.some((r) => r.id === menu.id);
  useEffect(() => { if (gone) setMenu(null); }, [gone]);
  const { live } = props;
  if (live.count === 0) return null;
  const menuRow = menu ? live.rows.find((r) => r.id === menu.id) ?? null : null;
  const closeMenu = (how: MenuCloseHow) => {
    const id = menu?.id;
    setMenu(null);
    // 外を押したときは、押した先にフォーカスを任せる。ほかは行へ戻す（止めて行が消えたら、戻す先は無い）。
    if (how !== 'outside' && id) list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
  };
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
    // . は一覧の行の「⋯」と同じ打鍵。修飾の付いたものはアプリ全体の打鍵なので取らない。
    if (e.key === '.' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const box = e.currentTarget.getBoundingClientRect();
      setMenu({ id: r.id, at: { top: box.top, bottom: box.bottom, left: box.left, width: box.width } });
      return;
    }
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const ids = nudgeId(live.ids, r.id, e.key === 'ArrowUp' ? -1 : 1);
    if (ids !== live.ids) emit({ type: 'sidebar.order', ids });
  };
  return (
    <section className="side-live" aria-label={t('sidebar.live.label')}>
      <h2 className="side-live-h">{t('sidebar.live.title')}<span className="side-live-n">{live.count}</span></h2>
      <ul className="side-live-list" ref={list}>
        {live.rows.map((r) => (
          <li key={r.id}>
            <a className="side-live-row" href={formatRoute({ name: 'session', id: r.id })} draggable aria-current={r.current ? 'page' : undefined} data-id={r.id} data-menu={menu?.id === r.id ? 'true' : undefined}
              data-live={r.live ?? undefined} data-dragging={drag === r.id ? 'true' : undefined} data-over={over?.id === r.id ? (over.before ? 'before' : 'after') : undefined}
              title={r.waited ? `${r.name}（${r.waited}）` : r.name}
              onClick={(e) => { e.preventDefault(); emit({ type: 'session.open', id: r.id }); }} onKeyDown={(e) => onKeyDown(e, r)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ id: r.id, at: { top: e.clientY, bottom: e.clientY, left: e.clientX, width: 0 } }); }}
              onDragStart={(e) => { setDrag(r.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); }}
              onDragOver={(e) => onDragOver(e, r)} onDragLeave={() => { if (over?.id === r.id) setOver(null); }} onDrop={(e) => onDrop(e, r)} onDragEnd={end}>
              <StatusDot status={r.live} aside={r.aside} /><span className="side-live-name">{r.name}</span>{r.waited && <span className="side-live-wait num">{r.waited}</span>}
            </a>
          </li>
        ))}
      </ul>
      {menuRow && <MenuPop key={menuRow.id} label={`${menuRow.name} の操作`} items={rowItems(menuRow, emit)} anchor={anchor} minWidth={260} align="start" onClose={closeMenu} />}
      {live.more > 0 && <a className="side-live-more" href={formatRoute(HOME)} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: HOME }); }}>ほか {live.more} 件</a>}
    </section>
  );
}

/**
 * 行のメニューの項目。「停止」だけにする。
 * 状態（Paused・Done）は会話の終わりと一覧の「⋯」で付けるので、ここには置かない。置くと、付けたのに行が残って見える。
 * 言葉と色はセッション画面の「停止」に合わせ、何が起きるかを 1 行添える。hangar の外で動いているものは止められないので、押せない形で理由を言う。
 */
function rowItems(r: SideLiveRow, emit: ReturnType<typeof useEmit>): MenuItem[] {
  const stop = r.stop;
  return [{ key: 'stop', label: '停止', danger: true, note: 'Claude を終わらせます。会話の記録は残るので、あとで再開できます', disabled: stop ? null : 'hangar の外で動いています', onSelect: () => { if (stop) emit({ type: 'session.kill', ...stop }); } }];
}

/** 「ほか N 件」の行き先。ホームの実行中と要対応に全部が並ぶ。 */
const HOME = { name: 'home' } as const;

/**
 * サイドバー。上から「ホーム」「プロジェクト」の 2 項目、「実行中」の節、下端の「設定」の順に置く（設計書 2.1）。
 * 設定は foot で受け取り、残りの高さの底に寄せる。
 */
export function Sidebar(props: { nav: NavItem[]; foot: NavItem[]; collapsed: boolean; live: SideLiveProps }) {
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
      {props.foot.length > 0 && <div className="side-foot">{props.foot.map(item)}</div>}
    </nav>
  );
}
