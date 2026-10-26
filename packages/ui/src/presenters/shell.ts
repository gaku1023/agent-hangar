import { asideOf } from '../lib/aside.ts';
import { agentIconsOn, agentOfSession } from './agentIcon.ts';
import { presentSessionMenu, type SessionMenuProps } from './sessionMenu.ts';
import { type AgentIconKind, type AgentUsageDto, type IndexProgressDto, type LiveStatus, type Route, type SessionDto, type StopReason, type SyncStateKind, type SyncStatusDto, type Translate, type UsageDto, liveWithLimit, quietLive, resetAtText, stopReasonOf, usageAt } from '@agent-hangar/shared';
import { paneLeaves } from '../mediator/panes.ts';
import type { State } from '../mediator/types.ts';
import { accountList, accountOfSession, currentAccount, liveSessionIds, shownReason, waitingSessionIds, type Store } from '../store/store.ts';
import { presentAccounts, presentAgentUsage, type AccountGauge, type AccountView, type AgentUsageView } from './accounts.ts';
import { durationLabel, indexProgressLabel, relativeTime, resetsLabel } from './format.ts';
import { translatorOf, storeLanguage } from './i18n.ts';
import { presentOverlap } from './overlap.ts';
import { projectDisplayName } from './projectName.ts';
import { newSessionTarget, type NewSessionTarget } from './newSession.ts';
import { presentNotices, type NoticesProps } from './notices.ts';
import { limitedWord, syncStateWord } from './syncLabel.ts';

/**
 * count は項目に添える数で、今はホームの入力待ちの数だけに使う。
 * 0 なら添えない。
 */
export type NavItem = { route: Route; label: string; current: boolean; count: number };
/**
 * fiveHourResets と sevenDayResets は、Claude の利用上限の枠が戻る時刻の文で、届いていなければ null である。
 * fiveHourLimit と sevenDayLimit は、その枠の使用制限でセッションが止まっているときのリセットの時刻の文（試作 stop-reason-proto の H2）。
 * 止まっていなければ持たない。ゲージは砂時計の色にして、% の代わりにこの時刻を出す。
 */
export type UsageProps = { fiveHour: number | null; sevenDay: number | null; fiveHourResets: string | null; sevenDayResets: string | null; updatedLabel: string | null; fiveHourLimit?: string; sevenDayLimit?: string;
  /** 頭の札。Codex の枠が届いているときだけ付く（Claude の枠でも Claude と言う）。無ければ札を出さず、見た目は今のまま。 */
  agent?: { key: 'claude' | 'codex'; label: string } };
/**
 * ヘッダのアカウントの切り替え。アカウントが 1 件以下なら null で、ヘッダは今までのまま。
 * shown は計器を出すアカウントで、セッション画面ではそのセッションのアカウント、ほかではいまのアカウントである。
 * list は全アカウント（並びと current はいまのアカウントを基準にする）。
 * sessionId は、セッション画面で開いているセッションの id で、ほかでは null。選ぶとそのセッションの切り替えになる。
 * working は、そのセッションが動いていて作業中か。session.kill に添える値（SessionScreen.tsx）と同じ出どころである。
 * codex は、面の Codex の節に出す枠。値が未着か設定で切なら null（無いのと同じ）で、面は Claude の札だけになる。here は Codex の会話を開いているか。
 */
export type HeaderAccountProps = { shown: AccountView; list: AccountView[]; sessionId: string | null; working: boolean; codex?: { usage: AgentUsageView; here: boolean } | null } | null;
/**
 * 同期の一行は状態を示すだけで、操作は持たない。今すぐ同期、一時停止、PC を追加は設定の同期の群にある。
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
 * サイドバーの「実行中」の 1 行。waited は入力待ちのときだけ（「待ち 4 分」）。current はいま見ているセッション。
 * reason は止まっている理由で、点を盾（許可待ち）か砂時計（使用制限）に替える。waited も「許可待ち 4 分」、リセットの時刻（16:50）、「リセット済み」に替える。
 * aside は裏だけ動いていること。丸を薄いオレンジにするだけで、名前の横に語は添えない（利用者の決定）。
 * menu は行の右クリックと . で開くセッションのメニュー（1A）。一覧とホームの帯と同じものである。
 */
export type SideLiveRow = { id: string; name: string; live: LiveStatus | null; aside: boolean; reason: StopReason | null; waited: string | null; current: boolean; menu: SessionMenuProps;
  /** 同じファイルを別のセッションと編集していること。行末の印に乗せたときの文（相手の名前）。無ければ null か無し。 */
  overlap?: string | null;
  /** 名前の右端のエージェントのアイコン（一覧の行と同じ、agentIcon.ts）。出さないときは持たない。 */
  agent?: AgentIconKind | null;
  /** 画面の分割に入っているときの、ペインの番号（木の順で 1 から）。ペインが 2 つ未満、または木に無いときは持たない。 */
  pane?: number };
/** 「実行中」のグループ。key はプロジェクトの id で、未分類は空の文字列。waiting は入力待ちの行の数（畳んだ見出しに出す）。 */
export type SideLiveGroup = { key: string; name: string; open: boolean; waiting: number; rows: SideLiveRow[] };
/**
 * サイドバーの「実行中」。
 * count は動いているセッションの全数、ids と rows は見えている順（グループをつないだ順）の全部の並びと行（ids は並べ替えの計算に使う）、groups はプロジェクトごとのグループである。
 */
export type SideLiveProps = { count: number; ids: string[]; rows: SideLiveRow[]; groups: SideLiveGroup[] };
export type ShellProps = { live: SideLiveProps; sidebarCollapsed: boolean; sidebarWidth: number; wide: boolean; nav: NavItem[]; foot: NavItem[]; conn: ConnProps; index: IndexProgressDto; indexLabel: string | null; usage: UsageProps; account: HeaderAccountProps; sync: SyncProps; notices: NoticesProps; newSession: NewSessionTarget };

/**
 * 切れているあいだの帯。
 * connecting では出さない。最初の接続は読み込み中の画面が担っていて、そこに帯を重ねても言うことが増えないからである。
 * 言うのは「WebSocket の状態」ではなく、その結果である「画面がいつのまま止まっているか」と「次にいつ試すか」の 2 つにする。
 */
function connProps(state: State, store: Store, now: number): ConnProps {
  const desktop = store.desktop;
  const t = translatorOf(store);
  if (state.connection !== 'disconnected') return { visible: false, staleLabel: '', retryLabel: '', hard: false, desktop };
  const left = state.nextRetryAt === null ? 0 : Math.ceil((state.nextRetryAt - now) / 1000);
  // 1 分未満は「1 分未満前のまま」と読みにくいので、時刻を言わずに止まったことだけを言う。
  const justNow = state.staleSince === null || now - state.staleSince < 60_000;
  return {
    visible: true,
    staleLabel: justNow ? t('conn.stale.stopped') : t('conn.stale.since', { time: relativeTime(t, state.staleSince, now) }),
    // 待ち時間が尽きたあとは、秒を 0 と出さずに、試している最中だと言う。
    retryLabel: left > 0 ? t('conn.retry.in', { n: left }) : t('conn.retry.now'),
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
    : t('header.sync.synced', { time: relativeTime(t, s.lastAt, now) });
  const count = (n: number | undefined, key: 'header.sync.pending' | 'header.sync.sweepPending' | 'header.sync.skipped') => (n !== undefined && n > 0 ? t(key, { n }) : null);
  const pending = count(store.sync?.pending, 'header.sync.pending');
  const sweepPending = count(store.sync?.sweepPending ?? undefined, 'header.sync.sweepPending');
  const skipped = count(store.sync?.skipped.length, 'header.sync.skipped');
  const text = [label, pending, sweepPending, skipped].filter((x): x is string => x !== null && x !== '').join(t('header.sync.separator'));
  return { visible: store.sync !== null, state: s.kind, label, title: store.sync === null ? '' : t('header.sync.title', { text }), pending, sweepPending, skipped, reason, once };
}

type NavDef = { route: Route; label: string; matches: string[] };
/** サイドバーの上の組。セッションの一覧の画面は無くなったので、項目はこの 2 つと、その下の「実行中」の節である（設計書 2.1）。 */
const navDefs = (t: Translate): NavDef[] => [
  { route: { name: 'home' }, label: t('sidebar.nav.home'), matches: ['home', 'booting'] },
  { route: { name: 'projects' }, label: t('sidebar.nav.projects'), matches: ['projects', 'project'] },
];
/** 下端の組。設定だけを置く。 */
const footDefs = (t: Translate): NavDef[] => [
  { route: { name: 'settings' }, label: t('sidebar.nav.settings'), matches: ['settings'] },
];

/**
 * サイドバーの「実行中」。
 * セッション画面にいる間、ほかのセッションのどれが待っているかを横目で見て、1 押しで移るための場所である。
 * 並びは覚えた順（state.sidebarOrder）だけで決め、状態や最後の活動では並べ直さない。動かすのは利用者の手だけである。
 * 覚えた並びにまだ無いもの（いま動き始めたもの）は、始めた順で末尾に置く。Mediator が同じ順で並びに書き足すので（sidebar.ts の sidebarLiveStep）、書き足す前と後で行は動かない。
 * 入力待ちになっても行は動かさない。待ちは色と太字と待った時間で知らせる。
 * 行はプロジェクトごとのグループに分ける。グループの順は、並びの中でそのプロジェクトの行が先に出てくる順で、グループの中は並びの順である。
 * グループの順を別に持たない。グループを動かしたときは、つないだ並びを sidebar.order で覚え直す（views/Sidebar.tsx）。
 * 行の数に上限は無く、入りきらない分は節の中でスクロールする。
 */
function sideLive(state: State, store: Store, now: number): SideLiveProps {
  const t = translatorOf(store);
  const live = liveSessionIds(store);
  const on = new Set(live);
  const known = new Set(state.sidebarOrder);
  const order = [...state.sidebarOrder.filter((id) => on.has(id)), ...live.filter((id) => !known.has(id))];
  const current = state.screen.name === 'session' ? state.screen.id : null;
  const icons = agentIconsOn(store);
  const paneNo = new Map(paneLeaves(state.panes.root).length >= 2 ? paneLeaves(state.panes.root).flatMap((l, i) => (l.sessionId ? [[l.sessionId, i + 1] as const] : [])) : []);
  const rowOf = (id: string): SideLiveRow => {
    const s = store.sessions[id]!;
    const aside = asideOf(s.live, s.liveAside);
    // 点と「待ち N 分」は、入力待ちの数え方と同じ規則（shownLive）で決める。Done と Archived にした入力待ちは、行は残すが休みとして出す。
    // 停止の確認（stop.working）は本当の動きで決める。答えを待つ会話は、止めると問いが消える。
    const shown = quietLive(liveWithLimit(s.live, s.limit), s.state?.status);
    const reason = shownReason(s, shown);
    return { id, name: s.name ?? t('common.label.noName'), live: shown, aside: aside !== null, reason, waited: sideWaited(t, s, shown, reason, now), current: id === current, menu: presentSessionMenu(store, s, t), overlap: presentOverlap(store, id, now)?.sidebarTitle ?? null, ...(icons ? { agent: agentOfSession(store, s) } : {}), ...(paneNo.has(id) ? { pane: paneNo.get(id)! } : {}) };
  };
  const byKey = new Map<string, string[]>();
  for (const id of order) {
    const key = store.sessions[id]!.projectId ?? '';
    byKey.set(key, [...byKey.get(key) ?? [], id]);
  }
  const folded = new Set(state.sidebarFolded);
  const groups = [...byKey].map(([key, ids]): SideLiveGroup => {
    const rows = ids.map(rowOf);
    const p = store.projects[key];
    const name = key === '' ? t('common.label.uncategorized') : p ? projectDisplayName(p, t) : t('common.label.noName');
    return { key, name, open: !folded.has(key), waiting: rows.filter((r) => r.live === 'waiting').length, rows };
  });
  const rows = groups.flatMap((g) => g.rows);
  return { count: rows.length, ids: rows.map((r) => r.id), rows, groups };
}

/** サイドバーの行の右端の語。入力待ちと許可待ちは待った時間、使用制限はリセットの時刻、リセット済みはその語。 */
function sideWaited(t: Translate, s: SessionDto, shown: LiveStatus | null, reason: StopReason | null, now: number): string | null {
  if (reason === 'limit' && s.limit) return resetAtText(t, s.limit.resetsAt, now);
  if (reason === 'reset') return t('stop.state.reset');
  if (shown !== 'waiting') return null;
  const time = durationLabel(t, now - (s.lastActivityAt ?? now));
  return reason === 'permission' ? t('stop.waited.permission', { time }) : t('sidebar.live.waited', { time });
}

/**
 * 使用制限でリセットを待っているセッション（shared の stopReasonOf が limit のもの）。
 * accountId を渡せば、そのアカウントのものだけにする（アカウントが 2 つ以上あるとき、計器は 1 つのアカウントのものだから）。
 */
function limitedSessions(store: Store, accountId: string | null): SessionDto[] {
  return Object.values(store.sessions).filter((s) => stopReasonOf(s) === 'limit' && (accountId === null || accountOfSession(store, s.id)?.id === accountId));
}

/** 止まっている枠ごとの、いちばん早いリセットの時刻の文。止まっていない枠は持たない。 */
function limitTimes(t: Translate, list: SessionDto[], now: number): Pick<UsageProps, 'fiveHourLimit' | 'sevenDayLimit'> {
  const earliest = (kind: 'five_hour' | 'weekly') => {
    const at = list.filter((s) => s.limit?.kind === kind).map((s) => s.limit!.resetsAt);
    return at.length ? resetAtText(t, Math.min(...at), now) : null;
  };
  const five = earliest('five_hour');
  const week = earliest('weekly');
  return { ...(five ? { fiveHourLimit: five } : {}), ...(week ? { sevenDayLimit: week } : {}) };
}

const gaugePercent = (g: AccountGauge | null): number | null => g?.percent ?? null;

/** Codex の枠。リセット済みの窓は 0% に読む（usageAt）。使用制限で止まった会話の時刻は Claude の枠のものなので付けない。 */
function codexUsage(t: Translate, c: AgentUsageDto, now: number): UsageProps {
  const u = usageAt(c, now);
  return { fiveHour: u.fiveHour?.usedPercent ?? null, sevenDay: u.sevenDay?.usedPercent ?? null, fiveHourResets: resetsLabel(u.fiveHour?.resetsAt ?? null, now), sevenDayResets: resetsLabel(u.sevenDay?.resetsAt ?? null, now), updatedLabel: u.updatedAt === null ? null : relativeTime(t, u.updatedAt, now), agent: { key: 'codex', label: t('header.gauge.agentCodex') } };
}

/** 使用率がまだ届いていないときの値。 */
const NO_USAGE: UsageDto = { fiveHour: null, sevenDay: null, updatedAt: null };

/**
 * ヘッダの計器とアカウントの切り替え。
 * アカウントが 1 件でもあれば切り替えを出し、計器は shown の値から作る。1 件のときも 2 件以上と同じ顔と面にする（面でリセットの時刻と「アカウントを追加」が見えるため）。
 * サーバは常にメインのアカウントを返すので、一覧が空なのは、まだ一覧が届いていない間だけである。その間は切り替えを出さず、計器は空にする。
 * 使用率は accounts.update だけで届く。
 */
function headerAccount(state: State, store: Store, now: number): { account: HeaderAccountProps; usage: UsageProps } {
  const t = translatorOf(store);
  if (accountList(store).length === 0) {
    const u = usageAt(currentAccount(store)?.usage ?? NO_USAGE, now);
    const limited = limitedSessions(store, null);
    return { account: null, usage: { fiveHour: u.fiveHour?.usedPercent ?? null, sevenDay: u.sevenDay?.usedPercent ?? null, fiveHourResets: resetsLabel(u.fiveHour?.resetsAt ?? null, now), sevenDayResets: resetsLabel(u.sevenDay?.resetsAt ?? null, now), updatedLabel: u.updatedAt === null ? null : relativeTime(t, u.updatedAt, now), ...limitTimes(t, limited, now) } };
  }
  // opencode と Codex の会話には Claude のアカウントが無いので、ホームと同じく、いまのアカウントを出す（決まりは design.md の opencode の札の節）。
  // 会話のアカウントを引くと、対応に無い会話としてメインのアカウントが出て、いまのアカウントと違う使用量になる。
  // 切り替えも会話の付け替えではなく、いまのアカウントの切り替えにするため、sessionId は null にする。
  const screenId = state.screen.name === 'session' ? state.screen.id : null;
  const screenSession = screenId === null ? undefined : store.sessions[screenId];
  const screenAgent = screenSession ? agentOfSession(store, screenSession) : null;
  const sessionId = screenAgent === 'opencode' || screenAgent === 'codex' ? null : screenId;
  const raw = (sessionId === null ? currentAccount(store) : accountOfSession(store, sessionId)) ?? accountList(store)[0]!;
  const list = presentAccounts(store, now);
  const shown = list.find((a) => a.id === raw.id) ?? list[0]!;
  const live = sessionId === null ? null : store.sessions[sessionId]?.live ?? null;
  const limited = limitedSessions(store, shown.id);
  const claudeUsage: UsageProps = { fiveHour: gaugePercent(shown.fiveHour), sevenDay: gaugePercent(shown.sevenDay), fiveHourResets: shown.fiveHour?.resets ?? null, sevenDayResets: shown.sevenDay?.resets ?? null, updatedLabel: shown.updatedLabel, ...limitTimes(t, limited, now) };
  // Codex の枠が届いているときだけ、開いている会話のエージェントの枠に切り替える（U1）。値が未着か切なら agents ごと無いので、Claude の枠のまま札も出さない。
  const codex = store.accounts?.agents?.codex;
  const usage: UsageProps = !codex ? claudeUsage
    : screenAgent === 'codex' ? codexUsage(t, codex, now)
    : { ...claudeUsage, agent: { key: 'claude', label: t('header.gauge.agentClaude') } };
  // 面には、開いている会話によらず Codex の枠も並べる（Claude Code と Codex の節、AccountSwitcher.tsx）。
  const codexCard = codex ? { usage: presentAgentUsage(t, codex, now), here: screenAgent === 'codex' } : null;
  return { account: { shown, list, sessionId, working: live === 'busy' || live === 'waiting', codex: codexCard }, usage };
}

/** tz は日付と時刻を言うときの時差で、省略すると端末の時差になる。 */
export function presentShell(state: State, store: Store, now: number, tz?: string): ShellProps {
  const s = state.screen;
  const idx = store.index;
  const t = translatorOf(store);
  const indexLabel = indexProgressLabel(t, idx);
  // 使用率は Claude が動いている間だけ届くので、最終更新を添えて古さを見せる。
  const { account, usage } = headerAccount(state, store, now);
  // ホームに入力待ちの数を添える。
  // 数え方は shared の liveFilterOf に従う（waitingSessionIds）。
  const waiting = waitingSessionIds(store).length;
  const item = (n: NavDef): NavItem => ({ route: n.route, label: n.label, current: n.matches.includes(s.name), count: n.route.name === 'home' ? waiting : 0 });
  return { sidebarCollapsed: state.sidebarCollapsed, sidebarWidth: state.sidebarWidth, wide: s.name === 'session', nav: navDefs(t).map(item), foot: footDefs(t).map(item), conn: connProps(state, store, now), index: idx, indexLabel, usage, account, sync: syncProps(store, now, tz), notices: presentNotices(state, store, now, tz), newSession: newSessionTarget(state, store), live: sideLive(state, store, now) };
}
