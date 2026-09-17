import { formatRoute } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { NavItem } from '../presenters/shell.ts';

export function Sidebar(props: { nav: NavItem[] }) {
  const emit = useEmit();
  return (
    <nav className="sidebar" aria-label="主ナビゲーション">
      <div style={{ padding: '0 16px 12px', fontWeight: 600 }}>agent-hangar</div>
      {props.nav.map((n) => (
        <a key={n.label} className="nav-item" href={formatRoute(n.route)} aria-current={n.current ? 'page' : undefined} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: n.route }); }}>{n.label}</a>
      ))}
    </nav>
  );
}
