import { formatRoute } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { NavItem } from '../presenters/shell.ts';
import { Icon, type IconName } from './primitives/Icon.tsx';

/** 画面の名前からナビのアイコンへの対応。見た目の話なので Presenter ではなくここに置く。 */
const NAV_ICON: Record<string, IconName> = { home: 'home', projects: 'projects', sessions: 'sessions', settings: 'settings' };

export function Sidebar(props: { nav: NavItem[] }) {
  const emit = useEmit();
  return (
    <nav className="sidebar" aria-label="主ナビゲーション">
      <div style={{ padding: '0 16px 12px', fontWeight: 600 }}>agent-hangar</div>
      {props.nav.map((n) => (
        <a key={n.label} className="nav-item" href={formatRoute(n.route)} aria-current={n.current ? 'page' : undefined} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: n.route }); }}>{NAV_ICON[n.route.name] && <Icon name={NAV_ICON[n.route.name]!} />}{n.label}</a>
      ))}
    </nav>
  );
}
