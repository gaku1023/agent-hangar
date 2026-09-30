import { formatRoute } from '@agent-hangar/shared';
import markUrl from '../brand/logo-mark.svg';
import { useEmit } from '../intent/chain.tsx';
import type { NavItem } from '../presenters/shell.ts';
import { Icon, type IconName } from './primitives/Icon.tsx';

/** 画面の名前からナビのアイコンへの対応。見た目の話なので Presenter ではなくここに置く。 */
const NAV_ICON: Record<string, IconName> = { home: 'home', projects: 'projects', sessions: 'sessions', settings: 'settings' };

/** ワードマークを押したときの行き先。 */
const HOME = { name: 'home' } as const;

export function Sidebar(props: { nav: NavItem[]; collapsed: boolean }) {
  const emit = useEmit();
  return (
    <nav id="sidebar" className="sidebar" aria-label="主ナビゲーション">
      {/* 開閉のボタンは、開いた帯ではワードマークの右に、畳んだ帯ではワードマークがあった一番上に置く（base.css）。開閉の間は、その 2 か所を滑って移る。 */}
      <div className="sidebar-top">
        <a className="brand" href={formatRoute(HOME)} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: HOME }); }}><img className="brand-mark" src={markUrl} width={44} height={44} alt="" /><span className="brand-word">Hangar</span></a>
        <button className="btn sidebar-toggle" aria-controls="sidebar" aria-expanded={!props.collapsed} aria-label={props.collapsed ? 'サイドバーを開く' : 'サイドバーを閉じる'} onClick={() => emit({ type: 'sidebar.toggle' })}><Icon name="sidebar" /><span className="toggle-tip" aria-hidden="true">{props.collapsed ? '開く' : '閉じる'}<kbd>⌘B</kbd></span></button>
      </div>
      {props.nav.map((n) => (
        <a key={n.label} className="nav-item" href={formatRoute(n.route)} aria-current={n.current ? 'page' : undefined} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: n.route }); }}>{NAV_ICON[n.route.name] && <Icon name={NAV_ICON[n.route.name]!} />}<span className="nav-label">{n.label}</span></a>
      ))}
    </nav>
  );
}
