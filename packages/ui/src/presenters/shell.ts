import type { IndexProgressDto, Route, SyncStateKind } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import { waitingSessionIds, type Store } from '../store/store.ts';
import { indexProgressLabel, relativeTime, resetsLabel, SYNC_STATE_LABEL } from './format.ts';
import { newSessionTarget, type NewSessionTarget } from './newSession.ts';
import { bytesLabel, countExpiring, daysLabel, EXTEND_TO } from './retention.ts';

/**
 * count は項目に添える数で、今はホームの入力待ちの数だけに使う。
 * 0 なら添えない。
 */
export type NavItem = { route: Route; label: string; current: boolean; count: number };
/** fiveHourResets と sevenDayResets は、Claude の利用上限の枠が戻る時刻の文で、届いていなければ null である。 */
export type UsageProps = { fiveHour: number | null; sevenDay: number | null; fiveHourResets: string | null; sevenDayResets: string | null; updatedLabel: string | null };
/**
 * pending は未送信のメタデータ、sweepPending はまだ上げていない本文、skipped は送れなかった本文の件数である。
 * 後ろの 2 つは、数えられないときも 0 にする。
 * ヘッダーは 0 件を描かない約束なので、「分からない」と「無い」をここで同じ扱いにしてよい。
 */
export type SyncProps = { visible: boolean; state: SyncStateKind; label: string; pending: number; sweepPending: number; skipped: number; paused: boolean };
/** 切れているあいだだけ出す帯。つながっている間は visible が false で、文言も空である。 */
/**
 * 切断の帯。
 * hard は再接続が続けて失敗し、待っても戻らないと見た状態で、帯は同じ場所のまま濃い赤にして再起動を促す。
 * desktop は殻の中かどうかで、殻があれば「ログを開く」「再起動」を、無ければログの場所のコピーと文を出す。
 */
export type ConnProps = { visible: boolean; staleLabel: string; retryLabel: string; hard: boolean; desktop: boolean };
/** 殻とサーバがともに書くログ。殻の中でもブラウザでも同じ場所を言う。 */
export const DESKTOP_LOG_PATH = '~/.agent-hangar/desktop.log';
/** 帯を強い形に切り替えるまでに許す、再接続の失敗の回数。 */
export const HARD_AFTER_FAILURES = 3;
/** 保持期間の帯。既定の 30 日のままで、書けて、まだ閉じていないときだけ出す。 */
export type RetentionBannerProps = { visible: boolean; title: string; detail: string; extendTo: number };
/**
 * newSession はヘッダーの新規ボタンで開くダイアログの、最初の選択である。
 * wide は本文の幅の上限（--main-w）を外す画面か。
 * セッション画面だけ外し、ターミナルに幅と高さを渡す（UX 刷新 2 の案 b）。
 */
export type ShellProps = { sidebarCollapsed: boolean; wide: boolean; nav: NavItem[]; conn: ConnProps; index: IndexProgressDto; indexLabel: string | null; usage: UsageProps; sync: SyncProps; retention: RetentionBannerProps; newSession: NewSessionTarget };

/**
 * 切れているあいだの帯。
 * connecting では出さない。最初の接続は読み込み中の画面が担っていて、そこに帯を重ねても言うことが増えないからである。
 * 言うのは「WebSocket の状態」ではなく、その結果である「画面がいつのまま止まっているか」と「次にいつ試すか」の 2 つにする。
 */
function connProps(state: State, store: Store, now: number): ConnProps {
  const desktop = store.desktop;
  if (state.connection !== 'disconnected') return { visible: false, staleLabel: '', retryLabel: '', hard: false, desktop };
  const left = state.nextRetryAt === null ? 0 : Math.ceil((state.nextRetryAt - now) / 1000);
  // 1 分未満は「1 分未満前のまま」と読みにくいので、時刻を言わずに止まったことだけを言う。
  const justNow = state.staleSince === null || now - state.staleSince < 60_000;
  return {
    visible: true,
    staleLabel: justNow ? '画面の更新が止まっています' : `画面は ${relativeTime(state.staleSince, now)}のまま止まっています`,
    // 待ち時間が尽きたあとは、秒を 0 と出さずに、試している最中だと言う。
    retryLabel: left > 0 ? `${left} 秒後に再接続します` : '再接続しています',
    // reconnectAttempt は最初の切断で 1 になり、再接続に失敗するたびに 1 ずつ増える。
    hard: state.reconnectAttempt - 1 >= HARD_AFTER_FAILURES,
    desktop,
  };
}

/**
 * ヘッダーに出す同期の一行。
 * 同期を設定していない端末（off）では出さないので、visible を false にする。
 * 一度も往復していない間は時刻が無いので、時刻の代わりに準備中と出す。
 */
function syncProps(state: State, store: Store, now: number): SyncProps {
  const s = state.sync;
  // 語は設定の「状態」と同じ表から引く。
  const label =
    s.kind === 'off' ? ''
    : s.kind === 'error' ? `${SYNC_STATE_LABEL.error}: ${s.message}`
    : s.kind !== 'idle' ? SYNC_STATE_LABEL[s.kind]
    : s.lastAt === null ? '同期の準備中'
    : `同期 ${relativeTime(s.lastAt, now)}`;
  return { visible: s.kind !== 'off', state: s.kind, label, pending: state.pending, sweepPending: store.sync?.sweepPending ?? 0, skipped: store.sync?.skipped.length ?? 0, paused: s.kind === 'paused' };
}

/**
 * 保持期間の帯。値を自分で入れた人（30 日を含む）と、組織の設定で決まっている人には出さない。
 * 消えかけの会話があればその件数を、無ければ「消える」という決まりそのものを言う。
 */
function retentionBanner(state: State, store: Store, now: number): RetentionBannerProps {
  const r = store.retention;
  const hidden: RetentionBannerProps = { visible: false, title: '', detail: '', extendTo: EXTEND_TO };
  if (!store.bootstrapped || !r || r.source !== 'default' || !r.writable || state.retentionBannerDismissed) return hidden;
  const soon = countExpiring(Object.values(store.sessions), r.days, now);
  const usage = r.usage ? ` ・ いま ${bytesLabel(r.usage.bytes)}` : '';
  return soon > 0
    ? { visible: true, title: `${soon} 件の会話が、まもなく削除されます`, detail: `Claude Code は ${daysLabel(r.days)}で本文を消します${usage}`, extendTo: EXTEND_TO }
    : { visible: true, title: `会話は ${daysLabel(r.days)}で削除されます`, detail: `hangar の履歴からも消えます${usage}`, extendTo: EXTEND_TO };
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
  const indexLabel = indexProgressLabel(idx);
  const u = store.usage;
  // 使用率は Claude が動いている間だけ届くので、最終更新を添えて古さを見せる。
  const usage: UsageProps = { fiveHour: u.fiveHour?.usedPercent ?? null, sevenDay: u.sevenDay?.usedPercent ?? null, fiveHourResets: resetsLabel(u.fiveHour?.resetsAt ?? null, now), sevenDayResets: resetsLabel(u.sevenDay?.resetsAt ?? null, now), updatedLabel: u.updatedAt === null ? null : relativeTime(u.updatedAt, now) };
  // ホームに入力待ちの数を添える。
  // 数え方は shared の liveFilterOf に従う（waitingSessionIds）。
  const waiting = waitingSessionIds(store).length;
  return { sidebarCollapsed: state.sidebarCollapsed, wide: s.name === 'session', nav: NAV.map((n) => ({ route: n.route, label: n.label, current: n.matches.includes(s.name), count: n.route.name === 'home' ? waiting : 0 })), conn: connProps(state, store, now), index: idx, indexLabel, usage, sync: syncProps(state, store, now), retention: retentionBanner(state, store, now), newSession: newSessionTarget(state, store) };
}
