import { SETTINGS_SECTIONS, settingsSectionOf, type IndexProgressDto, type Language, type SettingsSection, type ShellHookStateDto, type StatuslineStatusDto, type SummarizerTestDto, type SyncSkippedDto, type SyncStateKind, type TerminalApp, type Translate, type UsageAggregateDto } from '@agent-hangar/shared';
import type { SaveMark, State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { indexProgressLabel, relativeTime } from './format.ts';
import { storeLanguage, translatorOf } from './i18n.ts';
import { limitedWord, syncStateWord } from './syncLabel.ts';
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
export type CloudSettingsProps = { configured: boolean; url: string | null; state: SyncStateKind; stateLabel: string; /** 節の見出しの右の札。目次の状態の語と同じもの。 */ badge: { text: string; tone: 'ok' | 'off' | 'warn' | 'stop' }; paused: boolean; /** Cloudflare の上限で退いているか。そのあいだは一時停止の切り替えを出さない（試作の Q4 の案 B）。 */ limited: boolean; /** 一時停止のまま、押した 1 回の同期が進んでいる最中。 */ once?: boolean; lastPullAt: string; pending: number; sweepPending: number | null; skipped: SyncSkippedDto[]; devices: CloudDeviceProps[]; joinToken: string | null; joinTokenExpiresAt: number | null; syncClaudeConfig: boolean; configConfirmed: boolean; usage: CloudUsageProps | null };

/**
 * 外のターミナル（VS Code など）で起動した claude を hangar で開けるようにする包み方。
 * state はこの PC の状態で、読み込む前は null。devices は同期している PC ごとの状態で、自端末は測り直した値を使う。
 * command は入れるために貼るコマンドで、uninstallCommand は外すためのコマンド。
 */
export type ShellSettingsProps = { state: ShellHookStateDto | null; zshrc: string; line: string; command: string; uninstallCommand: string; devices: { id: string; name: string; self: boolean; state: ShellHookStateDto | null; label: string }[] };

/** 参加トークンを画面に置いておく長さ。全セッションの読み書き権を持つ秘密なので、写し終わる頃に消す。 */
export const JOIN_TOKEN_TTL_MS = 120_000;

/** PC ごとの状態の言い方。null は状態を知らせてこない古い版の hangar である。 */
const shellLabel = (t: Translate, s: ShellHookStateDto | null): string => {
  switch (s) {
    case 'on': return t('settings.integrations.shell.on');
    case 'off': return t('settings.integrations.shell.off');
    case 'unsupported': return t('settings.integrations.shell.unsupported');
    case null: return t('settings.integrations.shell.unknown');
  }
};

/**
 * 設定の目次の 1 行。title は節の名前、state は今の状態の 1 行。
 * tone の warn は、直すものがあるか、止まっているときの注意の色である。
 * label は読み上げの名前で、節の名前と状態をつなげる（要修正は数を言う）。
 */
export type SettingsTocRow = { id: SettingsSection; title: string; state: string; tone: 'default' | 'warn'; label: string };

/**
 * 言語の行。作ってあるが、辞書が埋まるまで出さない（段 4 の PR 25 で visible を true にする）。
 * 出さない間は、目次の一般の状態にも言語を言わない。
 */
export const LANGUAGE_ROW_VISIBLE = false;

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
  /** 右に出している節。URL の `at` で決まる（無ければ「一般」、`sync` はクラウド同期、`accounts` は連携）。 */
  section: SettingsSection;
  /** 左の目次。節ごとに、名前と今の状態の 1 行を持つ。 */
  toc: SettingsTocRow[];
  /** 一般の先頭の言語の行。visible が false の間は描かない。 */
  language: { visible: boolean; value: Language };
  /** 連携の節を開いたとき、アカウントの位置へ移る印。ヘッダーのアカウントの設定から来たときだけ入る。 */
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

/** 目次の各行の状態。連携とツールは、準備の確かめが届くまで分からないので「確認中」と言う。 */
function presentToc(a: {
  t: Translate; language: Language; todo: { must: number; link: number }; cloud: CloudSettingsProps; cloudWord: string; cloudTone: string;
  sync: Store['sync']; notify: Store['notify']; readiness: boolean; summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null; sessionCount: number; now: number;
}): SettingsTocRow[] {
  const { t } = a;
  type St = { state: string; tone: 'default' | 'warn' };
  const fix = (n: number, ok: string): St => (n > 0 ? { state: t('settings.fix.count', { n }), tone: 'warn' } : { state: ok, tone: 'default' });
  const checking: St = { state: t('settings.toc.checking'), tone: 'default' };
  const state: Record<SettingsSection, St> = {
    // 言語の行を出していない間は、言語を言わない。
    general: { state: [LANGUAGE_ROW_VISIBLE ? t(a.language === 'ja' ? 'settings.general.language.ja' : 'settings.general.language.en') : null, !a.notify.available ? t('settings.toc.notifyUnavailable') : a.notify.on ? t('settings.toc.notifyOn') : t('settings.toc.notifyOff')].filter((x): x is string => x !== null).join(t('settings.toc.separator')), tone: 'default' },
    cloud: {
      state: a.cloud.state === 'idle' && a.sync?.lastPullAt != null ? t('settings.toc.cloudReceived', { state: a.cloudWord, time: relativeTime(a.sync.lastPullAt, a.now) }) : a.cloudWord,
      tone: a.cloudTone === 'warn' || a.cloudTone === 'stop' ? 'warn' : 'default',
    },
    integrations: a.readiness ? fix(a.todo.link, t('settings.toc.noIssues')) : checking,
    summary: a.summarizerTest?.ok === false ? { state: t('settings.toc.summaryTestFailed'), tone: 'warn' }
      : a.summarizerModels === null ? checking
        : a.summarizerModels.length === 0 ? { state: t('settings.toc.summaryOffline'), tone: 'warn' }
          : { state: t('settings.toc.summaryConnected'), tone: 'default' },
    tools: a.readiness ? fix(a.todo.must, t('settings.toc.allFound')) : checking,
    info: { state: t('settings.toc.sessions', { n: a.sessionCount.toLocaleString('en-US') }), tone: 'default' },
  };
  return SETTINGS_SECTIONS.map((id) => {
    const title = t(`settings.section.${id}`);
    return { id, title, ...state[id], label: t('settings.toc.row', { name: title, state: state[id].state }) };
  });
}

// now は相対時刻のためだけに使う。フェーズ 3 までの呼び出しは 2 引数なので既定値を置く。
export function presentSettings(state: State, store: Store, now: number = Date.now()): SettingsProps {
  const s = store.settings;
  const sync = store.sync;
  const t = translatorOf(store);
  // 同期の状態が届いていない端末と、off が届いている端末は同じ「設定していない」扱いにする。
  const stateLabel = sync?.state === 'paused' && sync.oncePass ? t('header.sync.once')
    : sync?.state === 'paused' && sync.limitedUntil !== null ? limitedWord(t, storeLanguage(store), sync.limitedUntil)
    // 一時停止中に版で止まったときは、状態は error でも一時停止していることを頭に添える。
    : sync?.state === 'error' && sync.paused ? t('header.sync.pausedErrorShort')
    : syncStateWord(t, sync?.state ?? 'off');
  const limited = sync?.state === 'paused' && sync.limitedUntil !== null;
  // 目次の行と節の見出しの札は、同じ短い語を使う（無料枠で停止は、戻る時刻を節の中に出す）。
  const cloudWord = limited ? t('settings.toc.cloudLimited') : sync?.state === 'error' && sync.paused ? t('header.sync.pausedErrorShort') : syncStateWord(t, sync?.state ?? 'off');
  const cloudTone: 'ok' | 'off' | 'warn' | 'stop' = limited ? 'stop' : sync?.state === 'error' ? 'warn' : sync === null || sync.state === 'off' ? 'off' : sync.state === 'paused' ? 'off' : 'ok';
  const cloud: CloudSettingsProps = {
    configured: sync !== null && sync.state !== 'off',
    url: sync?.url ?? null,
    state: sync?.state ?? 'off',
    // 語はヘッダーの同期の一行と同じ表（syncLabel.ts）から引く。
    stateLabel,
    badge: { text: cloudWord, tone: cloudTone },
    // 上限で退いているのは利用者が止めたのではないので、一時停止とは言わない。そのあいだは切り替えを出さない（limited）。
    // 版で止まると state は error になるので、一時停止しているかは印でも見る。
    paused: (sync?.state === 'paused' && sync.limitedUntil === null) || sync?.paused === true,
    limited: sync?.state === 'paused' && sync.limitedUntil !== null,
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
  const at = state.screen.name === 'settings' ? state.screen.at : undefined;
  const h = store.shellHook;
  const command = h?.command ?? 'hangar shell install';
  const shell: ShellSettingsProps = {
    state: h?.state ?? null, zshrc: h?.zshrc ?? '', line: h?.line ?? '', command, uninstallCommand: command.replace(/ install$/, ' uninstall'),
    // 自端末の行は 10 分おきにしか書き直されないので、Settings を開いたときに測った値で上書きする。
    devices: store.devices.map((d) => { const state = d.self && h ? h.state : d.shell; return { id: d.id, name: d.name, self: d.self, state, label: shellLabel(t, state) }; }),
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
    indexLabel: indexProgressLabel(store.index) ?? t('settings.info.index.counts', { sessions: Object.keys(store.sessions).length, projects: Object.keys(store.projects).length }),
    sessionCount: Object.keys(store.sessions).length, projectCount: Object.keys(store.projects).length,
    tmuxPath: s?.tmuxPath ?? null, terminalApp: s?.terminalApp ?? 'terminal', codePath: s?.codePath ?? null,
    lmStudioUrl: s?.lmStudioUrl ?? '', lmStudioModel: s?.lmStudioModel ?? null, summaryFallback: s?.summaryFallback ?? true, summaryHourlyCap: s?.summaryHourlyCap ?? 20, allowExternalSummarizer: s?.allowExternalSummarizer ?? false,
    summarizerModels: store.summarizerModels, summarizerTest: store.summarizerTest,
    statusline: store.statusline, usageAggregate: store.usageAggregate,
    nodePath: s?.nodePath ?? '',
    claudePath: s?.claudePath ?? null,
    retention: retentionSettings(store),
    accounts: { list: presentAccounts(store, now), colors: ACCOUNT_COLORS },
    section: settingsSectionOf(at),
    toc: presentToc({ t, language: storeLanguage(store), todo, cloud, cloudWord, cloudTone, sync, notify: store.notify, readiness: r !== null, summarizerModels: store.summarizerModels, summarizerTest: store.summarizerTest, sessionCount: Object.keys(store.sessions).length, now }),
    language: { visible: LANGUAGE_ROW_VISIBLE, value: storeLanguage(store) },
    focus: at === 'accounts' ? 'accounts' : null,
    notify: { available: store.notify.available, on: store.notify.on, blocked: store.notify.blocked },
  };
}
