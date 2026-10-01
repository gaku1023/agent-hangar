import { formatRoute } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { NavItem } from '../presenters/shell.ts';
import { Icon, type IconName } from './primitives/Icon.tsx';

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

export function Sidebar(props: { nav: NavItem[]; collapsed: boolean }) {
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
    </nav>
  );
}
