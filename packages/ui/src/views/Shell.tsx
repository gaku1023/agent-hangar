import type { ReactNode } from 'react';
import type { ShellProps } from '../presenters/shell.ts';
import { ConnectionBanner } from './ConnectionBanner.tsx';
import { Header } from './Header.tsx';
import { Sidebar } from './Sidebar.tsx';

export function Shell(props: ShellProps & { children: ReactNode; overlays: ReactNode }) {
  return (
    <div className="shell">
      <Sidebar nav={props.nav} />
      <Header crumbs={props.crumbs} searchText={props.searchText} indexLabel={props.indexLabel} usage={props.usage} sync={props.sync} />
      <ConnectionBanner {...props.conn} />
      <main className="main"><div className="main-inner">{props.children}</div></main>
      {props.overlays}
    </div>
  );
}
