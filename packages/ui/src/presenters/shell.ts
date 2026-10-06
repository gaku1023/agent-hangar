import { type IndexProgressDto, type LiveStatus, type Route, type SyncStateKind, usageAt } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import { accountList, accountOfSession, aliveRunOf, currentAccount, hasMultipleAccounts, liveSessionIds, tabsOf, waitingSessionIds, type Store } from '../store/store.ts';
import { presentAccounts, type AccountGauge, type AccountView } from './accounts.ts';
import { durationLabel, indexProgressLabel, relativeTime, resetsLabel, SYNC_STATE_LABEL } from './format.ts';
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
 * ヘッダのアカウントの切り替え。アカウントが 1 件以下なら null で、ヘッダは今までのまま。
 * shown は計器を出すアカウントで、セッション画面ではそのセッションのアカウント、ほかではいまのアカウントである。
 * list は全アカウント（並びと current はいまのアカウントを基準にする）。
 * sessionId は、セッション画面で開いているセッションの id で、ほかでは null。選ぶとそのセッションの切り替えになる。
 * working は、そのセッションが動いていて作業中か。session.kill に添える値（SessionScreen.tsx）と同じ出どころである。
 */
export type HeaderAccountProps = { shown: AccountView; list: AccountView[]; sessionId: string | null; working: boolean } | null;
/**
 * pending は未送信のメタデータ、sweepPending はまだ上げていない本文、skipped は送れなかった本文の件数である。
 * 後ろの 2 つは、数えられないときも 0 にする。
 * ヘッダーは 0 件を描かない約束なので、「分からない」と「無い」をここで同じ扱いにしてよい。
 */
export type SyncProps = { visible: boolean; state: SyncStateKind; label: string; pending: number; sweepPending: number; skipped: number; paused: boolean; reason: 'quota' | 'user' | null; quotaBack: boolean };
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
/**
 * 行のメニューの「停止」に要るもの（session.kill にそのまま渡す）。
 * working は作業中か入力待ちで、shellTabs は開いているシェルのタブの数。どちらかがあれば、止める前に確認を挟む（mediator/launch.ts）。
 */
export type SideLiveStop = { runId: string; working: boolean; shellTabs: number };
/**
 * サイドバーの「動いている」の 1 行。waited は入力待ちのときだけ（「待ち 4 分」）。current はいま見ているセッション。
 * stop は hangar の run が生きているときだけ持つ。hangar の外で動いているもの（VS Code の中の claude など）は hangar から止められないので null にする。
 */
export type SideLiveRow = { id: string; name: string; live: LiveStatus | null; waited: string | null; current: boolean; stop: SideLiveStop | null };
/**
 * サイドバーの「動いている」。
 * count は動いているセッションの全数、ids はその全部の並び（並べ替えの計算に使う）、rows は並べる行、more は並べきれなかった数である。
 */
export type SideLiveProps = { count: number; ids: string[]; rows: SideLiveRow[]; more: number };
export type ShellProps = { live: SideLiveProps; sidebarCollapsed: boolean; wide: boolean; nav: NavItem[]; conn: ConnProps; index: IndexProgressDto; indexLabel: string | null; usage: UsageProps; account: HeaderAccountProps; sync: SyncProps; retention: RetentionBannerProps; newSession: NewSessionTarget };

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

/** 次の UTC の 0 時を、端末の時差での時刻の文にする（例: 9:00）。 */
function resetClockLabel(now: number, tz?: string): string {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return new Intl.DateTimeFormat('ja-JP', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(next);
}

/**
 * ヘッダーに出す同期の一行。
 * 同期を設定していない端末（off）では出さないので、visible を false にする。
 * 一度も往復していない間は時刻が無いので、時刻の代わりに準備中と出す。
 * 無料枠の見張りが止めたとき（reason が quota）は、手で止めたのと分けて、いつ戻るかを言う。
 * 枠は UTC の日で区切るので、止めた日のうちは戻る時刻を端末の時刻で、日が変わったあとは戻ったことを言う。
 * tz は端末の時差で、試験でだけ決めて渡す。
 */
function syncProps(state: State, store: Store, now: number, tz?: string): SyncProps {
  const s = state.sync;
  // 止めた理由は止まっているときだけ見る。古いサーバは理由を送らないので、手で止めたものとして扱う。
  // quotaPausedDay は止まっていなくても返るので、reason が quota のときにだけ使う。
  const reason = s.kind === 'paused' ? (store.sync?.pausedReason ?? 'user') : null;
  const quotaDay = store.sync?.quotaPausedDay ?? null;
  const today = new Date(now).toISOString().slice(0, 10);
  // 無料枠で止めた日が過ぎていれば、枠はもう戻っている。点を緑に、文を注意の色にする（試作 usage-merged.html の H3）。
  const quotaBack = reason === 'quota' && quotaDay !== null && quotaDay < today;
  // 語は設定の「状態」と同じ表から引く。
  const label =
    s.kind === 'off' ? ''
    : reason === 'quota' ? (quotaBack ? '無料枠で停止 · 枠は戻りました' : `無料枠で停止 · ${resetClockLabel(now, tz)} に戻る`)
    : s.kind === 'error' ? `${SYNC_STATE_LABEL.error}: ${s.message}`
    : s.kind !== 'idle' ? SYNC_STATE_LABEL[s.kind]
    : s.lastAt === null ? '同期の準備中'
    : `同期 ${relativeTime(s.lastAt, now)}`;
  return { visible: s.kind !== 'off', state: s.kind, label, pending: state.pending, sweepPending: store.sync?.sweepPending ?? 0, skipped: store.sync?.skipped.length ?? 0, paused: s.kind === 'paused', reason, quotaBack };
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

/** サイドバーの「動いている」に並べる行の上限。超えた分は数だけにして、ホームへ案内する。 */
export const SIDE_LIVE_MAX = 8;

/**
 * サイドバーの「動いている」。
 * セッション画面にいる間、ほかのセッションのどれが待っているかを横目で見て、1 押しで移るための場所である。
 * 並びは覚えた順（state.sidebarOrder）だけで決め、状態や最後の活動では並べ直さない。動かすのは利用者の手だけである。
 * 覚えた並びにまだ無いもの（いま動き始めたもの）は、始めた順で末尾に置く。Mediator が同じ順で並びに書き足すので（sidebar.ts の sidebarLiveStep）、書き足す前と後で行は動かない。
 * 入力待ちになっても行は動かさない。待ちは色と太字と待った時間で知らせる。
 */
function sideLive(state: State, store: Store, now: number): SideLiveProps {
  const live = liveSessionIds(store);
  const on = new Set(live);
  const known = new Set(state.sidebarOrder);
  const ids = [...state.sidebarOrder.filter((id) => on.has(id)), ...live.filter((id) => !known.has(id))];
  const current = state.screen.name === 'session' ? state.screen.id : null;
  const rows = ids.slice(0, SIDE_LIVE_MAX).map((id): SideLiveRow => {
    const s = store.sessions[id]!;
    const run = aliveRunOf(store, id);
    // 作業中の数え方と、数えるタブは、セッション画面の「停止」と同じにする（views/SessionScreen.tsx）。
    const stop = run ? { runId: run.id, working: s.live === 'busy' || s.live === 'waiting', shellTabs: tabsOf(store, run.id).filter((t) => t.kind === 'shell').length } : null;
    return { id, name: s.name ?? '（名前なし）', live: s.live, waited: s.live === 'waiting' ? `待ち ${durationLabel(now - (s.lastActivityAt ?? now))}` : null, current: id === current, stop };
  });
  return { count: ids.length, ids, rows, more: ids.length - rows.length };
}

const gaugePercent = (g: AccountGauge | null): number | null => g?.percent ?? null;

/**
 * ヘッダの計器とアカウントの切り替え。
 * アカウントが 2 件以上あるときだけ切り替えを出し、計器は shown の値から作る。
 * 1 件以下のときは、今までどおり store.usage から作る。
 */
function headerAccount(state: State, store: Store, now: number): { account: HeaderAccountProps; usage: UsageProps } {
  const u = usageAt(store.usage, now);
  const plain: UsageProps = { fiveHour: u.fiveHour?.usedPercent ?? null, sevenDay: u.sevenDay?.usedPercent ?? null, fiveHourResets: resetsLabel(u.fiveHour?.resetsAt ?? null, now), sevenDayResets: resetsLabel(u.sevenDay?.resetsAt ?? null, now), updatedLabel: u.updatedAt === null ? null : relativeTime(u.updatedAt, now) };
  if (!hasMultipleAccounts(store)) return { account: null, usage: plain };
  const sessionId = state.screen.name === 'session' ? state.screen.id : null;
  const raw = (sessionId === null ? currentAccount(store) : accountOfSession(store, sessionId)) ?? accountList(store)[0]!;
  const list = presentAccounts(store, now);
  const shown = list.find((a) => a.id === raw.id) ?? list[0]!;
  const live = sessionId === null ? null : store.sessions[sessionId]?.live ?? null;
  const usage: UsageProps = { fiveHour: gaugePercent(shown.fiveHour), sevenDay: gaugePercent(shown.sevenDay), fiveHourResets: shown.fiveHour?.resets ?? null, sevenDayResets: shown.sevenDay?.resets ?? null, updatedLabel: shown.updatedLabel };
  return { account: { shown, list, sessionId, working: live === 'busy' || live === 'waiting' }, usage };
}

/** tz は日付と時刻を言うときの時差で、省略すると端末の時差になる。 */
export function presentShell(state: State, store: Store, now: number, tz?: string): ShellProps {
  const s = state.screen;
  const idx = store.index;
  const indexLabel = indexProgressLabel(idx);
  // 使用率は Claude が動いている間だけ届くので、最終更新を添えて古さを見せる。
  const { account, usage } = headerAccount(state, store, now);
  // ホームに入力待ちの数を添える。
  // 数え方は shared の liveFilterOf に従う（waitingSessionIds）。
  const waiting = waitingSessionIds(store).length;
  return { sidebarCollapsed: state.sidebarCollapsed, wide: s.name === 'session', nav: NAV.map((n) => ({ route: n.route, label: n.label, current: n.matches.includes(s.name), count: n.route.name === 'home' ? waiting : 0 })), conn: connProps(state, store, now), index: idx, indexLabel, usage, account, sync: syncProps(state, store, now, tz), retention: retentionBanner(state, store, now), newSession: newSessionTarget(state, store), live: sideLive(state, store, now) };
}
