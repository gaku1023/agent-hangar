import type { IndexProgressDto, ShellHookStateDto, StatuslineStatusDto, SummarizerTestDto, SyncSkippedDto, SyncStateKind, TerminalApp, UsageAggregateDto } from '@agent-hangar/shared';
import type { SaveMark, State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { indexProgressLabel, relativeTime, SYNC_ONCE_LABEL, SYNC_STATE_LABEL } from './format.ts';
import { presentAccounts, type AccountView } from './accounts.ts';
import { presentCloudUsage, type CloudUsageProps } from './cloudUsage.ts';
import { daysLabel, RETENTION_CHOICES } from './retention.ts';
import { presentCompat, readinessCompat, type CompatProps } from './compat.ts';
import { toolLine, workspaceLine, type VerifyLine } from './readiness.ts';
import { usageBar, type UsageBarProps } from './retentionDialog.ts';

// id は一覧の React の key に使う。1 台の Mac で 2 端末を模すと名前も最終確認も揃うので、一意なのは id だけである。
export type CloudDeviceProps = { id: string; name: string; platform: string; lastSeen: string; self: boolean };
/**
 * sweepPending はまだ上げていない本文の件数で、数えられないときは null である。
 * ヘッダーと違ってここは 0 件も描く。0 と書いてあれば「追いついた」と読めるからである。
 * skipped は送れなかった本文で、件数だけでは直しようが無いので鍵と理由もそのまま渡す。
 * stateLabel はヘッダーと同じ表から引いた状態の語である。
 */
export type CloudSettingsProps = { configured: boolean; url: string | null; state: SyncStateKind; stateLabel: string; paused: boolean; /** 一時停止のまま、押した 1 回の同期が進んでいる最中。 */ once?: boolean; lastPullAt: string; pending: number; sweepPending: number | null; skipped: SyncSkippedDto[]; devices: CloudDeviceProps[]; joinToken: string | null; joinTokenExpiresAt: number | null; syncClaudeConfig: boolean; configConfirmed: boolean; usage: CloudUsageProps | null };

/**
 * 外のターミナル（VS Code など）で起動した claude を hangar で開けるようにする包み方。
 * state はこの PC の状態で、読み込む前は null。devices は同期している PC ごとの状態で、自端末は測り直した値を使う。
 * command は入れるために貼るコマンドで、uninstallCommand は外すためのコマンド。
 */
export type ShellSettingsProps = { state: ShellHookStateDto | null; zshrc: string; line: string; command: string; uninstallCommand: string; devices: { id: string; name: string; self: boolean; label: string }[] };

/** 参加トークンを画面に置いておく長さ。全セッションの読み書き権を持つ秘密なので、写し終わる頃に消す。 */
export const JOIN_TOKEN_TTL_MS = 120_000;

/** PC ごとの状態の言い方。null は状態を知らせてこない古い版の hangar である。 */
const SHELL_LABEL: Record<ShellHookStateDto, string> = { on: '入っています', off: 'まだです', unsupported: 'tmux が無いので使えません' };
const shellLabel = (s: ShellHookStateDto | null): string => (s ? SHELL_LABEL[s] : '分かりません（hangar が古い版です）');

/** 会話の保持の節。押しても保存せず、確認（retention.edit）を開く。 */
export type RetentionSettingsProps = { days: number; options: { value: string; label: string }[]; writable: boolean; reason: string | null; valueLabel: string; bar: UsageBarProps | null; syncNote: boolean };

/** アカウントに付けられる 5 色（#rrggbb）。サーバは何色でも受けるが、画面からはここから選ぶ。 */
export const ACCOUNT_COLORS = ['#2a57b8', '#7a4a9e', '#2b7048', '#c77a1a', '#a2452f'];

/** アカウントの節。一覧が空なのは、まだ届いていないときだけ（1 件でもあれば出す）。 */
export type AccountSettingsProps = { list: AccountView[]; colors: string[] };

export type SettingsProps = {
  workspaceRoot: string; claudeDir: string; device: { id: string; name: string } | null; version: string; index: IndexProgressDto; indexLabel: string; sessionCount: number; projectCount: number;
  tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null;
  /** ターミナルで打つコマンド。どれも同じ hangar の呼び方にそろえる。 */
  commands: { mcp: string; statusline: string };
  lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number; allowExternalSummarizer: boolean;
  summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null;
  statusline: StatuslineStatusDto | null; usageAggregate: UsageAggregateDto | null;
  cloud: CloudSettingsProps;
  shell: ShellSettingsProps;
  /** 同梱サーバを起こす Node の場所。未指定は空文字で表す。 */
  nodePath: string;
  /** run を起こす claude の場所。未指定は null で表す。 */
  claudePath: string | null;
  /** Claude Code の会話の保持期間。まだ届いていなければ null。 */
  retention: RetentionSettingsProps | null;
  /**
   * 入力待ちの通知。
   * 出せる環境か（available）と、受け取るか（on）。
   */
  notify: { available: boolean; on: boolean; blocked: boolean };
  /** 欄の下の 1 行の検証（B1）。準備の確かめが届く前は null。 */
  verify: { workspace: VerifyLine | null; tmux: VerifyLine | null; claude: VerifyLine | null; code: VerifyLine | null; node: VerifyLine | null };
  /** hangar の MCP サーバが user スコープに載っているか。届く前は null。 */
  mcpRegistered: boolean | null;
  /** 欄ごとの保存の知らせ（C1）。欄の名前で引く。 */
  save: Record<string, SaveMark>;
  /**
   * 群ごとの直すものの数。目次に印を付ける。無くても動くものは数えない。
   * Claude Code との互換のずれは、利用者が直せるものではないので数えない（目次の点も灯さない）。
   */
  todo: { must: number; link: number };
  /** Claude Code との互換の節（C2）。準備の確かめが届く前と、compat の無い古いサーバの答えでは null。 */
  compat: CompatProps | null;
  accounts: AccountSettingsProps;
  /** 開いたときに見える位置へ移る節。ヘッダの「アカウントの設定」から来たときだけ入る。 */
  focus: 'accounts' | null;
};

/** 選択肢は決まった 4 つに、今の値がそこに無ければそれを足して、短い順に並べる。 */
function retentionSettings(store: Store): RetentionSettingsProps | null {
  const r = store.retention;
  if (!r) return null;
  const values = [...new Set<number>([...RETENTION_CHOICES, r.days])].sort((a, b) => a - b);
  const projected = r.usage ? r.usage.dailyBytes * r.days : null;
  return {
    days: r.days,
    options: values.map((d) => ({ value: String(d), label: daysLabel(d) })),
    writable: r.writable,
    reason: r.unwritableReason,
    valueLabel: daysLabel(r.days),
    bar: usageBar(r.usage, projected, r.days),
    syncNote: store.settings?.syncClaudeConfig ?? false,
  };
}

// now は相対時刻のためだけに使う。フェーズ 3 までの呼び出しは 2 引数なので既定値を置く。
export function presentSettings(state: State, store: Store, now: number = Date.now()): SettingsProps {
  const s = store.settings;
  const sync = store.sync;
  // 同期の状態が届いていない端末と、off が届いている端末は同じ「設定していない」扱いにする。
  const cloud: CloudSettingsProps = {
    configured: sync !== null && sync.state !== 'off',
    url: sync?.url ?? null,
    state: sync?.state ?? 'off',
    stateLabel: sync?.state === 'paused' && sync.oncePass ? SYNC_ONCE_LABEL : SYNC_STATE_LABEL[sync?.state ?? 'off'],
    paused: sync?.state === 'paused',
    once: sync?.state === 'paused' && sync.oncePass,
    lastPullAt: relativeTime(sync?.lastPullAt ?? null, now),
    pending: sync?.pending ?? 0,
    sweepPending: sync?.sweepPending ?? null,
    skipped: sync?.skipped ?? [],
    devices: store.devices.map((d) => ({ id: d.id, name: d.name, platform: d.platform, lastSeen: relativeTime(d.lastSeenAt, now), self: d.self })),
    joinToken: store.joinToken,
    joinTokenExpiresAt: store.joinTokenExpiresAt,
    syncClaudeConfig: s?.syncClaudeConfig ?? false,
    configConfirmed: sync?.claudeConfig.confirmed ?? false,
    usage: presentCloudUsage(store.cloudUsage, sync, now),
  };
  const h = store.shellHook;
  const command = h?.command ?? 'hangar shell install';
  const shell: ShellSettingsProps = {
    state: h?.state ?? null, zshrc: h?.zshrc ?? '', line: h?.line ?? '', command, uninstallCommand: command.replace(/ install$/, ' uninstall'),
    // 自端末の行は 10 分おきにしか書き直されないので、Settings を開いたときに測った値で上書きする。
    devices: store.devices.map((d) => ({ id: d.id, name: d.name, self: d.self, label: shellLabel(d.self && h ? h.state : d.shell) })),
  };
  const r = store.readiness;
  const verify = {
    workspace: r ? workspaceLine(r.workspace) : null,
    tmux: r ? toolLine('tmux', r.tools.tmux) : null,
    claude: r ? toolLine('claude', r.tools.claude) : null,
    code: r ? toolLine('code', r.tools.code) : null,
    node: r ? toolLine('node', r.tools.node) : null,
  };
  // compat の無い古いサーバの答えでは、互換の節を「確かめています」のままにする。
  const compatSummary = r ? readinessCompat(r) : undefined;
  const hard = (l: VerifyLine | null) => (l && !l.ok && !l.soft ? 1 : 0);
  const todo = {
    must: hard(verify.workspace) + hard(verify.tmux) + hard(verify.claude) + hard(verify.node),
    link: r ? (r.mcp.registered ? 0 : 1) + (r.statusline.installed ? 0 : 1) : 0,
  };
  return {
    cloud,
    shell,
    verify, todo,
    compat: compatSummary ? presentCompat(compatSummary, store.compat, store.version) : null,
    mcpRegistered: r ? r.mcp.registered : null,
    save: state.settingsSave,
    // 準備の確かめが届く前も、同じ hangar の呼び方で見せる。
    commands: { mcp: r?.commands.mcp ?? 'hangar mcp install', statusline: r?.commands.statusline ?? 'hangar statusline install' },
    workspaceRoot: s?.workspaceRoot ?? '', claudeDir: s?.claudeDir ?? '', device: store.device, version: store.version, index: store.index,
    // 進んでいる間はヘッダーと同じ文にし、終わっていれば数を出す。
    indexLabel: indexProgressLabel(store.index) ?? `${Object.keys(store.sessions).length} セッション、${Object.keys(store.projects).length} プロジェクト`,
    sessionCount: Object.keys(store.sessions).length, projectCount: Object.keys(store.projects).length,
    tmuxPath: s?.tmuxPath ?? null, terminalApp: s?.terminalApp ?? 'terminal', codePath: s?.codePath ?? null,
    lmStudioUrl: s?.lmStudioUrl ?? '', lmStudioModel: s?.lmStudioModel ?? null, summaryFallback: s?.summaryFallback ?? true, summaryHourlyCap: s?.summaryHourlyCap ?? 20, allowExternalSummarizer: s?.allowExternalSummarizer ?? false,
    summarizerModels: store.summarizerModels, summarizerTest: store.summarizerTest,
    statusline: store.statusline, usageAggregate: store.usageAggregate,
    nodePath: s?.nodePath ?? '',
    claudePath: s?.claudePath ?? null,
    retention: retentionSettings(store),
    accounts: { list: presentAccounts(store, now), colors: ACCOUNT_COLORS },
    focus: state.screen.name === 'settings' && state.screen.at === 'accounts' ? 'accounts' : null,
    notify: { available: state.notify.available, on: state.notify.on, blocked: state.notify.blocked },
  };
}
