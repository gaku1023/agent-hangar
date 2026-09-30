import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { ShellProps } from '../presenters/shell.ts';
import { ConnectionBanner } from './ConnectionBanner.tsx';
import { Header } from './Header.tsx';
import { playSidebarMotion } from './primitives/sidebarMotion.ts';
import { Sidebar } from './Sidebar.tsx';

export function Shell(props: ShellProps & { children: ReactNode; overlays: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef(props.sidebarCollapsed);
  // 開閉が替わった描画の直後（塗る前）に、前の形から今の形へ動かす。最初の描画と、開閉以外の描画では動かさない。
  useLayoutEffect(() => {
    if (shown.current === props.sidebarCollapsed) return;
    shown.current = props.sidebarCollapsed;
    if (ref.current) playSidebarMotion(ref.current);
  }, [props.sidebarCollapsed]);
  return (
    <div ref={ref} className="shell" data-sidebar={props.sidebarCollapsed ? 'collapsed' : undefined}>
      <Sidebar nav={props.nav} collapsed={props.sidebarCollapsed} />
      <Header searchText={props.searchText} indexLabel={props.indexLabel} usage={props.usage} sync={props.sync} />
      <ConnectionBanner {...props.conn} />
      <main className="main"><div className="main-inner">{props.children}</div></main>
      {props.overlays}
    </div>
  );
}
