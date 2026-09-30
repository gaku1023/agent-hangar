import type { IndexProgressDto, Route, SyncStateKind } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { relativeTime } from './format.ts';

export type NavItem = { route: Route; label: string; current: boolean };
export type UsageProps = { fiveHour: number | null; sevenDay: number | null; updatedLabel: string | null };
/**
 * pending は未送信のメタデータ、sweepPending はまだ上げていない本文、skipped は諦めた本文の件数である。
 * 後ろの 2 つは、数えられないときも 0 にする。
 * ヘッダーは 0 件を描かない約束なので、「分からない」と「無い」をここで同じ扱いにしてよい。
 */
export type SyncProps = { visible: boolean; state: SyncStateKind; label: string; pending: number; sweepPending: number; skipped: number; paused: boolean };
/** 切れているあいだだけ出す帯。つながっている間は visible が false で、文言も空である。 */
export type ConnProps = { visible: boolean; staleLabel: string; retryLabel: string };
export type ShellProps = { sidebarCollapsed: boolean; nav: NavItem[]; searchText: string; conn: ConnProps; index: IndexProgressDto; indexLabel: string | null; usage: UsageProps; sync: SyncProps };

/**
 * 切れているあいだの帯。
 * connecting では出さない。最初の接続は読み込み中の画面が担っていて、そこに帯を重ねても言うことが増えないからである。
 * 言うのは「WebSocket の状態」ではなく、その結果である「画面がいつのまま止まっているか」と「次にいつ試すか」の 2 つにする。
 */
function connProps(state: State, now: number): ConnProps {
  if (state.connection !== 'disconnected') return { visible: false, staleLabel: '', retryLabel: '' };
  const left = state.nextRetryAt === null ? 0 : Math.ceil((state.nextRetryAt - now) / 1000);
  // 1 分未満は「1 分未満前のまま」と読みにくいので、時刻を言わずに止まったことだけを言う。
  const justNow = state.staleSince === null || now - state.staleSince < 60_000;
  return {
    visible: true,
    staleLabel: justNow ? '画面の更新が止まっています' : `画面は ${relativeTime(state.staleSince, now)}のまま止まっています`,
    // 待ち時間が尽きたあとは、秒を 0 と出さずに、試している最中だと言う。
    retryLabel: left > 0 ? `${left} 秒後に再接続します` : '再接続しています',
  };
}

/**
 * ヘッダーに出す同期の一行。
 * 同期を設定していない端末（off）では出さないので、visible を false にする。
 * 一度も往復していない間は時刻が無いので、時刻の代わりに準備中と出す。
 */
function syncProps(state: State, store: Store, now: number): SyncProps {
  const s = state.sync;
  const label =
    s.kind === 'off' ? ''
    : s.kind === 'pushing' ? '送信中'
    : s.kind === 'pulling' ? '受信中'
    : s.kind === 'paused' ? '一時停止中'
    : s.kind === 'error' ? `同期エラー: ${s.message}`
    : s.lastAt === null ? '同期の準備中'
    : `同期 ${relativeTime(s.lastAt, now)}`;
  return { visible: s.kind !== 'off', state: s.kind, label, pending: state.pending, sweepPending: store.sync?.sweepPending ?? 0, skipped: store.sync?.skipped.length ?? 0, paused: s.kind === 'paused' };
}

const NAV: { route: Route; label: string; matches: string[] }[] = [
  { route: { name: 'home' }, label: 'ホーム', matches: ['home', 'booting'] },
  { route: { name: 'projects' }, label: 'プロジェクト', matches: ['projects', 'project'] },
  { route: { name: 'sessions' }, label: 'セッション', matches: ['sessions', 'session'] },
  { route: { name: 'settings' }, label: '設定', matches: ['settings'] },
];

export function presentShell(state: State, store: Store, now: number): ShellProps {
  const s = state.screen;
  const idx = store.index;
  const indexLabel = idx.phase === 'idle' ? null : idx.phase === 'scanning' ? '索引を準備中' : `${idx.phase === 'rebuilding' ? '再構築' : '索引'} ${idx.done} / ${idx.total} 件`;
  const u = store.usage;
  // 使用率は Claude が動いている間だけ届くので、最終更新を添えて古さを見せる。
  const usage: UsageProps = { fiveHour: u.fiveHour?.usedPercent ?? null, sevenDay: u.sevenDay?.usedPercent ?? null, updatedLabel: u.updatedAt === null ? null : relativeTime(u.updatedAt, now) };
  return { sidebarCollapsed: state.sidebarCollapsed, nav: NAV.map((n) => ({ route: n.route, label: n.label, current: n.matches.includes(s.name) })), searchText: state.search.text, conn: connProps(state, now), index: idx, indexLabel, usage, sync: syncProps(state, store, now) };
}
