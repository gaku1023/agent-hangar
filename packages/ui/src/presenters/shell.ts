import { asideOf } from '../lib/aside.ts';
import { type IndexProgressDto, type LiveStatus, type Route, type SyncStateKind, type SyncStatusDto, type UsageDto, usageAt } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import { accountList, accountOfSession, aliveRunOf, currentAccount, hasMultipleAccounts, liveSessionIds, tabsOf, waitingSessionIds, type Store } from '../store/store.ts';
import { presentAccounts, type AccountGauge, type AccountView } from './accounts.ts';
import { durationLabel, indexProgressLabel, relativeTime, resetsLabel } from './format.ts';
import { translatorOf, storeLanguage } from './i18n.ts';
import { newSessionTarget, type NewSessionTarget } from './newSession.ts';
import { presentNotices, type NoticesProps } from './notices.ts';
import { limitedWord, syncStateWord } from './syncLabel.ts';

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
 * 同期の一行は状態を示すだけで、操作は持たない。今すぐ同期、一時停止、参加トークンは設定の同期の群にある。
 * label は状態の語、title は label と件数を並べた全文で、狭いヘッダーで畳んだ部品もここから読める。
 * pending、sweepPending、skipped は件数の文で、0 件のときは null にする（ヘッダーは 0 件を描かない約束で、「分からない」と「無い」を同じ扱いにしてよい）。
 * pending は未送信の変更、sweepPending はまだ上げていないトランスクリプト、skipped は送信に失敗したトランスクリプトである。
 * visible が偽なのは、状態がまだ届いていない間だけである。同期を使っていない端末は、state が off で「同期オフ」と言う。
 */
export type SyncProps = { visible: boolean; state: SyncStateKind; label: string; title: string; pending: string | null; sweepPending: string | null; skipped: string | null; /** quota は Cloudflare の上限で退いている、user は利用者が止めた。 */ reason: 'quota' | 'user' | null; /** 一時停止のまま、押した 1 回の同期が進んでいる最中。 */ once?: boolean };
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
/**
 * newSession はヘッダーの新規ボタンで開くダイアログの、最初の選択である。
 * wide は本文の幅の上限（--main-w）を外す画面か。
 * セッション画面だけ外し、ターミナルに幅と高さを渡す（UX 刷新 2 の案 b）。
 */
/**
 * 行のメニューの「停止」に要るもの（session.kill にそのまま渡す）。
 * working は作業中か入力待ちで、shellTabs は開いているシェルのタブの数。どちらかがあれば、止める前に確認を挟む（mediator/launch.ts）。
 * aside は裏だけ動いていることで、確認の文言を「バックグラウンドの作業も終わる」にする。
 */
export type SideLiveStop = { runId: string; working: boolean; aside: boolean; shellTabs: number };
/**
 * サイドバーの「実行中」の 1 行。waited は入力待ちのときだけ（「待ち 4 分」）。current はいま見ているセッション。
 * aside は裏だけ動いていること。丸を薄いオレンジにするだけで、名前の横に語は添えない（利用者の決定）。
 * stop は hangar の run が生きているときだけ持つ。hangar の外で動いているもの（VS Code の中の claude など）は hangar から止められないので null にする。
 */
export type SideLiveRow = { id: string; name: string; live: LiveStatus | null; aside: boolean; waited: string | null; current: boolean; stop: SideLiveStop | null };
/**
 * サイドバーの「実行中」。
 * count は動いているセッションの全数、ids はその全部の並び（並べ替えの計算に使う）、rows は並べる行、more は並べきれなかった数である。
 */
export type SideLiveProps = { count: number; ids: string[]; rows: SideLiveRow[]; more: number };
export type ShellProps = { live: SideLiveProps; sidebarCollapsed: boolean; wide: boolean; nav: NavItem[]; foot: NavItem[]; conn: ConnProps; index: IndexProgressDto; indexLabel: string | null; usage: UsageProps; account: HeaderAccountProps; sync: SyncProps; notices: NoticesProps; newSession: NewSessionTarget };

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
 * 状態がまだ届いていない間（Store の sync が null）は何も出さない。届いた off は「同期オフ」と言い、押せば設定の同期の群へ行ける。
 * 一度も往復していない間は時刻が無いので、時刻の代わりに準備中と出す。
 * Cloudflare の上限で退いている間（state は paused で、戻る時刻 limitedUntil がある）は、手で止めたのと分けて、いつ戻るかを言う。
 * 語は設定の同期の群の「状態」と同じ表（syncLabel.ts）から、設定の言語で引く。
 * tz は端末の時差で、試験でだけ決めて渡す。
 */
/** 同期の見え方。サーバの SyncStatusDto を、ヘッダーが描く形に写したもの。 */
type SyncView = { kind: 'off' } | { kind: 'idle'; lastAt: number | null } | { kind: 'pushing' } | { kind: 'pulling' } | { kind: 'paused' } | { kind: 'error'; message: string | null };

/** サーバの同期状態を写す。まだ届いていない間（null）は、同期を設定していないのと同じに扱う。 */
function toSyncView(s: SyncStatusDto | null): SyncView {
  if (s === null) return { kind: 'off' };
  switch (s.state) {
    case 'off': return { kind: 'off' };
    case 'pushing': return { kind: 'pushing' };
    case 'pulling': return { kind: 'pulling' };
    case 'paused': return { kind: 'paused' };
    case 'error': return { kind: 'error', message: s.error };
    case 'idle': return { kind: 'idle', lastAt: s.lastPullAt ?? s.lastPushAt };
  }
}

function syncProps(store: Store, now: number, tz?: string): SyncProps {
  // 同期の状態と未送信の数は、Store の sync だけから読む。
  const t = translatorOf(store);
  const language = storeLanguage(store);
  const s = toSyncView(store.sync);
  const limitedUntil = s.kind === 'paused' ? (store.sync?.limitedUntil ?? null) : null;
  const reason = s.kind === 'paused' ? (limitedUntil !== null ? 'quota' : 'user') : null;
  // 一時停止のまま押した 1 巡の最中。状態は paused のままなので、付録の印で見分ける。
  const once = s.kind === 'paused' && store.sync?.oncePass === true;
  // 版で止まると state は error になり、一時停止していることが state だけでは読めない。印でも見る。
  // 上限で退いている間は利用者が止めたのではないので、一時停止とは見なさない。
  const paused = (s.kind === 'paused' && limitedUntil === null) || store.sync?.paused === true;
  const label =
    store.sync === null ? ''
    : once ? t('header.sync.once')
    : limitedUntil !== null ? limitedWord(t, language, limitedUntil, tz)
    : s.kind === 'error' ? t(paused ? 'header.sync.pausedError' : 'header.sync.errorDetail', { message: s.message ?? t('header.sync.failed') })
    : s.kind !== 'idle' ? syncStateWord(t, s.kind)
    : s.lastAt === null ? t('header.sync.preparing')
    : t('header.sync.synced', { time: relativeTime(s.lastAt, now) });
  const count = (n: number | undefined, key: 'header.sync.pending' | 'header.sync.sweepPending' | 'header.sync.skipped') => (n !== undefined && n > 0 ? t(key, { n }) : null);
  const pending = count(store.sync?.pending, 'header.sync.pending');
  const sweepPending = count(store.sync?.sweepPending ?? undefined, 'header.sync.sweepPending');
  const skipped = count(store.sync?.skipped.length, 'header.sync.skipped');
  const text = [label, pending, sweepPending, skipped].filter((x): x is string => x !== null && x !== '').join(t('header.sync.separator'));
  return { visible: store.sync !== null, state: s.kind, label, title: store.sync === null ? '' : t('header.sync.title', { text }), pending, sweepPending, skipped, reason, once };
}

type NavDef = { route: Route; label: string; matches: string[] };
/** サイドバーの上の組。セッションの一覧の画面は無くなったので、項目はこの 2 つと、その下の「実行中」の節である（設計書 2.1）。 */
const NAV: NavDef[] = [
  { route: { name: 'home' }, label: 'ホーム', matches: ['home', 'booting'] },
  { route: { name: 'projects' }, label: 'プロジェクト', matches: ['projects', 'project'] },
];
/** 下端の組。設定だけを置く。 */
const FOOT: NavDef[] = [
  { route: { name: 'settings' }, label: '設定', matches: ['settings'] },
];

/** サイドバーの「実行中」に並べる行の上限。超えた分は数だけにして、ホームへ案内する。 */
export const SIDE_LIVE_MAX = 8;

/**
 * サイドバーの「実行中」。
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
    // 裏だけ動いているものも作業中として確かめる。止めると裏の作業も消える。
    const aside = asideOf(s.live, s.liveAside);
    const stop = run ? { runId: run.id, working: s.live === 'busy' || s.live === 'waiting', aside: aside !== null, shellTabs: tabsOf(store, run.id).filter((t) => t.kind === 'shell').length } : null;
    return { id, name: s.name ?? '（名前なし）', live: s.live, aside: aside !== null, waited: s.live === 'waiting' ? `待ち ${durationLabel(now - (s.lastActivityAt ?? now))}` : null, current: id === current, stop };
  });
  return { count: ids.length, ids, rows, more: ids.length - rows.length };
}

const gaugePercent = (g: AccountGauge | null): number | null => g?.percent ?? null;

/** 使用率がまだ届いていないときの値。 */
const NO_USAGE: UsageDto = { fiveHour: null, sevenDay: null, updatedAt: null };

/**
 * ヘッダの計器とアカウントの切り替え。
 * アカウントが 2 件以上あるときだけ切り替えを出し、計器は shown の値から作る。
 * 1 件以下のときは、いまのアカウント（最初のアカウント）の値から作る。使用率は accounts.update だけで届く。
 */
function headerAccount(state: State, store: Store, now: number): { account: HeaderAccountProps; usage: UsageProps } {
  if (!hasMultipleAccounts(store)) {
    const u = usageAt(currentAccount(store)?.usage ?? NO_USAGE, now);
    return { account: null, usage: { fiveHour: u.fiveHour?.usedPercent ?? null, sevenDay: u.sevenDay?.usedPercent ?? null, fiveHourResets: resetsLabel(u.fiveHour?.resetsAt ?? null, now), sevenDayResets: resetsLabel(u.sevenDay?.resetsAt ?? null, now), updatedLabel: u.updatedAt === null ? null : relativeTime(u.updatedAt, now) } };
  }
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
  const item = (n: NavDef): NavItem => ({ route: n.route, label: n.label, current: n.matches.includes(s.name), count: n.route.name === 'home' ? waiting : 0 });
  return { sidebarCollapsed: state.sidebarCollapsed, wide: s.name === 'session', nav: NAV.map(item), foot: FOOT.map(item), conn: connProps(state, store, now), index: idx, indexLabel, usage, account, sync: syncProps(store, now, tz), notices: presentNotices(state, store, now, tz), newSession: newSessionTarget(state, store), live: sideLive(state, store, now) };
}
