import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { sidebarWidthCss } from '../mediator/sidebar.ts';
import type { ShellProps } from '../presenters/shell.ts';
import { ConnectionBanner } from './ConnectionBanner.tsx';
import { DeleteApprovalStrip } from './DeleteApprovalStrip.tsx';
import { Header } from './Header.tsx';
import { playSidebarMotion, playSidebarWidth } from './primitives/sidebarMotion.ts';
import { Sidebar } from './Sidebar.tsx';
import { SidebarGrip } from './SidebarGrip.tsx';

export function Shell(props: ShellProps & { children: ReactNode; overlays: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef(props.sidebarCollapsed);
  // 開閉が替わった描画の直後（塗る前）に、前の形から今の形へ動かす。最初の描画と、開閉以外の描画では動かさない。
  useLayoutEffect(() => {
    if (shown.current === props.sidebarCollapsed) return;
    shown.current = props.sidebarCollapsed;
    if (ref.current) playSidebarMotion(ref.current);
  }, [props.sidebarCollapsed]);
  // 幅が替わったら（矢印、ダブルクリック）、前の幅から動かす。ドラッグを離したときは指に付いて動いた後なので動かさない。
  const width = useRef(props.sidebarWidth);
  useLayoutEffect(() => {
    if (width.current === props.sidebarWidth) return;
    const from = sidebarWidthCss(width.current);
    width.current = props.sidebarWidth;
    const shell = ref.current;
    if (!shell) return;
    if (shell.dataset.sidebarDropped) { delete shell.dataset.sidebarDropped; return; }
    playSidebarWidth(shell, from);
  }, [props.sidebarWidth]);
  const style = { '--sidebar-w': sidebarWidthCss(props.sidebarWidth) } as CSSProperties;
  return (
    <div ref={ref} className="shell" data-sidebar={props.sidebarCollapsed ? 'collapsed' : undefined} data-wide={props.wide ? 'true' : undefined} style={style}>
      <Sidebar nav={props.nav} foot={props.foot} collapsed={props.sidebarCollapsed} live={props.live} />
      {!props.sidebarCollapsed && <SidebarGrip width={props.sidebarWidth} />}
      <Header indexLabel={props.indexLabel} usage={props.usage} account={props.account} sync={props.sync} notices={props.notices} newSession={props.newSession} />
      {/* 帯は 2 行目に置く。切断の帯だけで、無いときは箱が空になり、:empty で潰れる。保持期間は帯でなくベルの一覧の行になった。 */}
      <div className="banners"><ConnectionBanner {...props.conn} /></div>
      <main className="main"><DeleteApprovalStrip rows={props.approvals} /><div className="main-inner">{props.children}</div></main>
      {props.overlays}
    </div>
  );
}
