import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { ShellProps } from '../presenters/shell.ts';
import { ConnectionBanner } from './ConnectionBanner.tsx';
import { Header } from './Header.tsx';
import { RetentionBanner } from './RetentionBanner.tsx';
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
      <Header crumbs={props.crumbs} searchText={props.searchText} indexLabel={props.indexLabel} usage={props.usage} sync={props.sync} />
      {/* 帯は 2 行目に縦に積む。切断を上に置く。どちらも無いときは箱が空になり、:empty で潰れる。 */}
      <div className="banners"><ConnectionBanner {...props.conn} /><RetentionBanner {...props.retention} /></div>
      <main className="main"><div className="main-inner">{props.children}</div></main>
      {props.overlays}
    </div>
  );
}
