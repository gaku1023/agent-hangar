import type { IndexProgressDto, Route } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { relativeTime } from './format.ts';

export type NavItem = { route: Route; label: string; current: boolean };
export type UsageProps = { fiveHour: number | null; sevenDay: number | null; updatedLabel: string | null };
export type ShellProps = { nav: NavItem[]; crumbs: { label: string; route?: Route }[]; searchText: string; connection: State['connection']; index: IndexProgressDto; indexLabel: string | null; usage: UsageProps };

const NAV: { route: Route; label: string; matches: string[] }[] = [
  { route: { name: 'home' }, label: 'Home', matches: ['home', 'booting'] },
  { route: { name: 'projects' }, label: 'Projects', matches: ['projects', 'project'] },
  { route: { name: 'sessions' }, label: 'Sessions', matches: ['sessions', 'session'] },
  { route: { name: 'settings' }, label: 'Settings', matches: ['settings'] },
];

export function presentShell(state: State, store: Store, now: number): ShellProps {
  const s = state.screen;
  const crumbs: ShellProps['crumbs'] = [];
  if (s.name === 'projects') crumbs.push({ label: 'Projects' });
  if (s.name === 'project') crumbs.push({ label: 'Projects', route: { name: 'projects' } }, { label: store.projects[s.id]?.name ?? s.id });
  if (s.name === 'sessions') crumbs.push({ label: 'Sessions' });
  if (s.name === 'session') { const ses = store.sessions[s.id]; const proj = ses?.projectId ? store.projects[ses.projectId] : null; if (proj) crumbs.push({ label: proj.name, route: { name: 'project', id: proj.id } }); crumbs.push({ label: ses?.name ?? s.id }); }
  if (s.name === 'settings') crumbs.push({ label: 'Settings' });
  if (s.name === 'home') crumbs.push({ label: 'Home' });
  const idx = store.index;
  const indexLabel = idx.phase === 'idle' ? null : idx.phase === 'scanning' ? '索引を準備中' : `${idx.phase === 'rebuilding' ? '再構築' : '索引'} ${idx.done} / ${idx.total} 件`;
  const u = store.usage;
  // 使用率は Claude が動いている間だけ届くので、最終更新を添えて古さを見せる。
  const usage: UsageProps = { fiveHour: u.fiveHour?.usedPercent ?? null, sevenDay: u.sevenDay?.usedPercent ?? null, updatedLabel: u.updatedAt === null ? null : relativeTime(u.updatedAt, now) };
  return { nav: NAV.map((n) => ({ route: n.route, label: n.label, current: n.matches.includes(s.name) })), crumbs, searchText: state.search.text, connection: state.connection, index: idx, indexLabel, usage };
}
