import { presentOpencodeProviders, type OpencodeProvidersProps } from './opencodeProviders.ts';
import { CODEX_INJECTIONS, CODEX_VERIFIED_RANGE, codexEnabledOf, codexInjectionOf, codexInterceptOf, type CodexInjection, type CodexStatusDto, type AutoDoneIdleDays, DEFAULT_AUTO_DONE_IDLE_DAYS, DEFAULT_SUMMARY_CLAUDE_MODEL, EDITOR_NAMES, isAutoDoneIdleDays, KNOWN_EDITORS, type SummaryEngine, isSettingsField, SETTINGS_SECTIONS, type EditorDetectState, type EditorId, type EditorSetting, type EditorTestDto, type KnownEditorId, settingsSectionOf, terminalAppFor, terminalAppsFor, type IndexProgressDto, type Language, type SetupTarget, type SettingsField, type SettingsSection, type ShellHookStateDto, type StatuslineStatusDto, type SummarizerTestDto, type SyncSkippedDto, type SyncStateKind, type TerminalApp, type Translate, type UsageAggregateDto, setupGuidePrompt, OPENCODE_INJECTIONS, OPENCODE_VERIFIED_RANGE, opencodeEnabledOf, opencodeInjectionOf, opencodeInterceptOf, opencodePermissionPresetOf, type OpencodeInjection, type OpencodeStatusDto, DEFAULT_LOCAL_CONTEXT, LOCAL_CONTEXT_CHOICES, localContextOf, DEFAULT_IDLE_UNLOAD, IDLE_UNLOAD_CHOICES, idleUnloadOf } from '@agent-hangar/shared';
import type { SaveMark, State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { indexProgressLabel, relativeTime } from './format.ts';
import { storeLanguage, translatorOf } from './i18n.ts';
import { projectDisplayName } from './projectName.ts';
import { limitedWord, syncStateWord } from './syncLabel.ts';
import { presentAccounts, presentCodexAccounts, type AccountView } from './accounts.ts';
import { presentCloudUsage, SETUP_CLOUD_COMMAND, type CloudUsageProps } from './cloudUsage.ts';
import { cloudJoinCommand, presentCloudMember, type CloudMemberProps } from './cloudMember.ts';
import { presentConfigSection, type ConfigSyncSectionProps } from './configSync.ts';
import { daysLabel, RETENTION_CHOICES } from './retention.ts';
import { presentCompat, readinessCompat, type CompatProps } from './compat.ts';
import { clientPlatform, presentMux, toolLine, workspaceLine, type MuxStatus, type VerifyLine } from './readiness.ts';
import { usageBar, type UsageBarProps } from './retentionDialog.ts';
import { presentUpdateSection, type UpdateSectionProps } from './update.ts';
import { presentInjection, presentOpencodeInjection, type InjectionPart } from './injection.ts';

/**
 * 設定の「連携 › opencode」の版の区分。
 * verified、unverified、legacy（1.x）、unknown（見つかったが版を読めない）はサーバの judgeOpencodeVersion と同じ分け方で、
 * missing は PATH と既知の置き場に見つからないときである。
 */
export type OpencodeVersionKind = 'verified' | 'unverified' | 'legacy' | 'unknown' | 'missing';
/**
 * 設定の「連携 › opencode」の面（ベータ、試作の D1）。
 * available は面を出すか（いまはどの OS でも出す。Windows も実機で確かめた）。enabled が偽の間は、有効にする行だけを出す。
 * version は検出の答えが届く前は null。installed は手元の版、verified は確かめた範囲、note は版の並びの下に添える文である。
 * badge は見出しの右端の札で、答えが届く前は null。claudeNote は「Claude Code と同じ」を選んでいるときだけ添える注記である。
 */
export type OpencodeSettingsProps = {
  available: boolean; enabled: boolean; injection: OpencodeInjection;
  injectionOptions: { value: OpencodeInjection; label: string }[];
  /** 選んでいる量で送る追記の全文（presenters/injection.ts の presentOpencodeInjection）。追記しないときは空で、画面は畳みごと出さない。 */
  full: InjectionPart[];
  version: { kind: OpencodeVersionKind; installed: string | null; verified: string; note: string | null } | null;
  badge: { text: string; tone: 'ok' | 'info' | 'warn' } | null;
  claudeNote: string | null;
  /**
   * 「opencode コマンドを hangar 経由で起動」の行（段 D2）。available は macOS と Linux だけ真（Windows ではシェルの包みを作らない）。
   * note は、この PC にシェル連携が入っていないときの入れ方の注記。opencode() はシェル連携の本体の中に書くので、入っていなければ効かない。
   */
  intercept: { available: boolean; on: boolean; note: string | null };
  /**
   * 「コマンド実行前に確認」の行（許可のひな形）。byConfig は利用者の opencode.json が許可を決めていること（OpencodeStatusDto.configPermissions）で、
   * そのときはひな形を重ねないので、切に見せてスイッチを無効にし、note を添える。
   */
  permissionPreset: { on: boolean; byConfig: boolean; note: string | null };
  /** 「ローカルモデルのコンテキスト長」の行。起動前に LM Studio のモデルを載せる長さ（opencodeLocalContext）で、選べる長さは 32K、64K（推奨）、128K。 */
  localContext: { value: number; options: { value: number; label: string }[] };
  /**
   * 「使っていないモデルのアンロード」の行。会話がすべて止まってから LM Studio のモデルを外すまでの分（opencodeIdleUnload）で、0 は外さない。
   * label は今の値として行の右に出す名前（推奨の印つき）、tick は目盛りの下に出す短い名前。
   */
  idleUnload: { value: number; stops: { value: number; label: string; tick: string }[] };
};

function idleUnloadStop(t: Translate, value: number): { value: number; label: string; tick: string } {
  const tick = value === 0 ? t('launchPrep.idleUnload.never') : value % 60 === 0 ? t('launchPrep.idleUnload.hour', { n: value / 60 }) : t('launchPrep.idleUnload.minutes', { n: value });
  return { value, tick, label: value === DEFAULT_IDLE_UNLOAD ? t('launchPrep.idleUnload.recommended', { value: tick }) : tick };
}

const OPENCODE_INJECTION_KEY = { minimal: 'settings.opencode.injection.minimal', claude: 'settings.opencode.injection.claude', none: 'settings.opencode.injection.none' } as const;
const OPENCODE_VERSION_TEXT = {
  verified: { badge: 'settings.opencode.badge.verified', tone: 'ok', note: null },
  unverified: { badge: 'settings.opencode.badge.unverified', tone: 'info', note: 'settings.opencode.version.unverifiedNote' },
  legacy: { badge: 'settings.opencode.badge.legacy', tone: 'warn', note: 'settings.opencode.version.legacyNote' },
  unknown: { badge: 'settings.opencode.badge.unknown', tone: 'info', note: 'settings.opencode.version.unknownNote' },
  missing: { badge: 'settings.opencode.badge.missing', tone: 'warn', note: 'settings.opencode.version.missing' },
} as const;

/** 検出の答えを区分に分ける。1.x は 2.x と API の形が違う古い系統なので、範囲の外とは分けて言う。 */
export function opencodeVersionKind(s: OpencodeStatusDto): OpencodeVersionKind {
  if (!s.found) return 'missing';
  if (s.version === null) return 'unknown';
  if (s.verified) return 'verified';
  return /^1\./.test(s.version) ? 'legacy' : 'unverified';
}

/** 設定の「連携 › Codex」の版の区分。見つかった版が範囲の中か外か、読めないか、見つからない。 */
export type CodexVersionKind = 'verified' | 'unverified' | 'unknown' | 'missing';

/**
 * 設定の「連携 › Codex」の面（ベータ、C4 の案 A）。opencode の面と同じ形で、別の面に置く。
 * enabled のときだけ、版・横取り・追記の行を出す（切のままなら「有効にする」の 1 行だけ）。
 * version.login はログインしていないときだけの注記で、版の行の下に添える。札（badge）はログインでは変えない。
 * 追記の 3 択と横取りは、保存するだけである（シェルの包みと追記の中身は別の段）。
 */
export type CodexSettingsProps = {
  enabled: boolean; injection: CodexInjection;
  injectionOptions: { value: CodexInjection; label: string }[];
  intercept: { available: boolean; on: boolean; note: string | null };
  version: { kind: CodexVersionKind; installed: string | null; verified: string; note: string | null; login: string | null } | null;
  badge: { text: string; tone: 'ok' | 'info' | 'warn' } | null;
};

const CODEX_VERSION_TEXT = {
  verified: { badge: 'settings.codex.badge.verified', tone: 'ok', note: null },
  unverified: { badge: 'settings.codex.badge.unverified', tone: 'info', note: 'settings.codex.version.unverifiedNote' },
  unknown: { badge: 'settings.codex.badge.unknown', tone: 'info', note: 'settings.codex.version.unknownNote' },
  missing: { badge: 'settings.codex.badge.missing', tone: 'warn', note: 'settings.codex.version.missing' },
} as const;
const CODEX_INJECTION_KEY = { minimal: 'settings.codex.injection.minimal', claude: 'settings.codex.injection.claude', none: 'settings.codex.injection.none' } as const;

/** Codex の検出の答えを区分に分ける。 */
export function codexVersionKind(s: CodexStatusDto): CodexVersionKind {
  if (!s.found) return 'missing';
  if (s.version === null) return 'unknown';
  return s.verified ? 'verified' : 'unverified';
}

function presentCodex(t: Translate, settings: { codexEnabled?: boolean; codexInjection?: CodexInjection; codexIntercept?: boolean }, status: CodexStatusDto | null, platform: string, shell: ShellHookStateDto | null): CodexSettingsProps {
  const kind = status ? codexVersionKind(status) : null;
  const text = kind ? CODEX_VERSION_TEXT[kind] : null;
  return {
    enabled: codexEnabledOf(settings),
    injection: codexInjectionOf(settings),
    injectionOptions: CODEX_INJECTIONS.map((value) => ({ value, label: t(CODEX_INJECTION_KEY[value]) })),
    intercept: { available: platform !== 'win32', on: codexInterceptOf(settings), note: shell !== null && shell !== 'on' ? t('settings.codex.intercept.needsShell') : null },
    version: status && kind && text ? { kind, installed: status.version, verified: CODEX_VERIFIED_RANGE, note: text.note ? t(text.note) : null, login: status.found && status.loggedIn === false ? t('settings.codex.version.loggedOut') : null } : null,
    badge: text ? { text: t(text.badge), tone: text.tone } : null,
  };
}

/** 設定の「連携 › opencode」の面。platform は画面を開いている OS で、Windows ではコマンドの横取りの行だけを出さない。 */
function presentOpencode(t: Translate, settings: { opencodeEnabled?: boolean; opencodeInjection?: OpencodeInjection; opencodeIntercept?: boolean; opencodePermissionPreset?: boolean; opencodeLocalContext?: number; opencodeIdleUnload?: number; askStatusAtEnd?: boolean; liveHints?: boolean }, status: OpencodeStatusDto | null, platform: string, shell: ShellHookStateDto | null): OpencodeSettingsProps {
  const injection = opencodeInjectionOf(settings);
  const kind = status ? opencodeVersionKind(status) : null;
  const text = kind ? OPENCODE_VERSION_TEXT[kind] : null;
  return {
    available: true,
    enabled: opencodeEnabledOf(settings),
    injection,
    injectionOptions: OPENCODE_INJECTIONS.map((value) => ({ value, label: t(OPENCODE_INJECTION_KEY[value]) })),
    full: presentOpencodeInjection(t, { askStatusAtEnd: settings.askStatusAtEnd !== false, liveHints: settings.liveHints !== false }, injection),
    version: status && kind && text ? { kind, installed: status.version, verified: OPENCODE_VERIFIED_RANGE, note: text.note ? t(text.note) : null } : null,
    badge: text ? { text: t(text.badge), tone: text.tone } : null,
    claudeNote: injection === 'claude' ? t('settings.opencode.injection.claudeNote') : null,
    intercept: { available: platform !== 'win32', on: opencodeInterceptOf(settings), note: shell !== null && shell !== 'on' ? t('settings.opencode.intercept.needsShell') : null },
    permissionPreset: status?.configPermissions === true
      ? { on: false, byConfig: true, note: t('settings.opencode.permissionPreset.byConfig') }
      : { on: opencodePermissionPresetOf(settings), byConfig: false, note: null },
    localContext: { value: localContextOf(settings), options: LOCAL_CONTEXT_CHOICES.map((value) => ({ value, label: t(value === DEFAULT_LOCAL_CONTEXT ? 'launchPrep.settings.recommended' : 'launchPrep.settings.option', { n: value / 1024 }) })) },
    idleUnload: { value: idleUnloadOf(settings), stops: IDLE_UNLOAD_CHOICES.map((value) => idleUnloadStop(t, value)) },
  };
}

// id は一覧の React の key に使う。1 台の Mac で 2 端末を模すと名前も最終確認も揃うので、一意なのは id だけである。
export type CloudDeviceProps = { id: string; name: string; platform: string; lastSeen: string; self: boolean };
/**
 * sweepPending はまだ上げていない本文の件数で、数えられないときは null である。
 * ヘッダーと違ってここは 0 件も描く。0 と書いてあれば「追いついた」と読めるからである。
 * skipped は送れなかった本文で、件数だけでは直しようが無いので鍵と理由もそのまま渡す。
 * stateLabel はヘッダーと同じ表から引いた状態の語である。
 */
export type CloudSettingsProps = { configured: boolean; url: string | null; state: SyncStateKind; stateLabel: string; /** 節の見出しの右の札。目次の状態の語と同じもの。 */ badge: { text: string; tone: 'ok' | 'off' | 'warn' | 'stop' }; paused: boolean; /** Cloudflare の上限で退いているか。そのあいだは一時停止の切り替えを出さない（試作の Q4 の案 B）。 */ limited: boolean; /** 一時停止のまま、押した 1 回の同期が進んでいる最中。 */ once?: boolean; lastPullAt: string; pending: number; sweepPending: number | null; skipped: SyncSkippedDto[]; devices: CloudDeviceProps[]; usage: CloudUsageProps | null; /** 参加、PC の一覧と解除、この PC の参加の解除（presenters/cloudMember.ts）。試験の固定値は省ける（省くと今までの一覧とコマンドの案内を出す）。 */ member?: CloudMemberProps;
  /** cloud.json が古い形式で同期を止めているときの案内（再構築の手順の行き先と、状態を確かめるコマンド）。それ以外は null。試験の固定値は省ける。 */
  legacy?: { statusCommand: string; docUrl: string } | null };

/** 0.9.0 への再構築の手順（docs/cloud-sync.md の節）。公開リポジトリの main を指す。節の名前の部分は、UI の直書きの見張りに掛からないよう % で包んで書く。 */
export const CLOUD_REBUILD_DOC_URL = 'https://github.com/gaku1023/agent-hangar/blob/main/docs/cloud-sync.md#090-%E3%81%B8%E3%81%AE%E4%BD%9C%E3%82%8A%E7%9B%B4%E3%81%97';

/**
 * 外のターミナル（VS Code など）で起動した claude を hangar で開けるようにする包み方。
 * state はこの PC の状態で、読み込む前は null。devices は同期している PC ごとの状態で、自端末は測り直した値を使う。
 * command は入れるために貼るコマンドで、uninstallCommand は外すためのコマンド。
 */
/** available は、この PC の OS で包みを作るか。Windows のサーバでは偽で、画面は節ごと出さない。 */
export type ShellSettingsProps = { state: ShellHookStateDto | null; zshrc: string; line: string; command: string; uninstallCommand: string; available: boolean; devices: { id: string; name: string; self: boolean; state: ShellHookStateDto | null; label: string }[] };

/**
 * 連携の 1 枚の札（MCP サーバー、ステータスライン、シェル連携）の書き込み。
 * 殻の中では、ボタン（action）と書き込む先（file）を出し、コマンドは「ターミナルで行うとき」に畳む。
 * ブラウザでは書き込まない（D9）ので、ボタンを出さずにコマンド（command）を出す。
 * action は押せる操作で、状態が分からないとき（読み込み前、tmux が無いなど）は null。running は殻の返事を待っているもの。
 */
export type IntegrationAction = { target: SetupTarget; label: string; primary: boolean; disabled: boolean; running: boolean };
export type IntegrationCard = { file: string | null; action: IntegrationAction | null; command: string };
export type IntegrationsProps = { desktop: boolean; mcp: IntegrationCard; statusline: IntegrationCard; shell: IntegrationCard };

/**
 * エディタの欄の 1 行（試作の 1-1 の A）。tile は名前の頭の 2 文字の札（商標のアイコンは持たない決まり）。
 * state は見つかり方で、一覧が届く前と任意のコマンドは null。path は CLI かアプリの場所で、任意のコマンドはファイルのコマンド。
 */
export type EditorChoice = { id: EditorId; name: string; tile: string; state: EditorDetectState | null; path: string | null; version: string | null; selected: boolean; badge: { text: string; tone: 'ok' | 'warn' | 'mute' } | null };
/**
 * エディタの欄。name は選んでいるエディタの名前で、任意のコマンドは null。
 * test は「テスト」の進みと答え。loading は候補の一覧がまだ届いていないこと。
 */
export type EditorSettingsProps = { setting: EditorSetting; name: string | null; choices: EditorChoice[]; loading: boolean; test: { running: boolean; result: { tone: 'ok' | 'warn' | 'ng'; text: string } | null } };

const EDITOR_TILES: Record<KnownEditorId, string> = { vscode: 'VS', cursor: 'Cu', windsurf: 'Wi', zed: 'Ze', idea: 'IJ', webstorm: 'WS' };

/** テストの答えを、通り道ごとの文にする。URL と open -a は行の指定が効かないことがあるので、注意の色にする。 */
function editorTestResult(t: Translate, name: string, r: EditorTestDto): { tone: 'ok' | 'warn' | 'ng'; text: string } {
  if (!r.ok) return { tone: 'ng', text: r.missing ? t('settings.editor.test.missing', { message: r.message ?? '' }) : r.message ?? '' };
  if (r.via === 'openA') return { tone: 'warn', text: t('settings.editor.test.openA', { name }) };
  if (r.via === 'url') return { tone: 'ok', text: t('settings.editor.test.url', { name }) };
  return { tone: 'ok', text: t('settings.editor.test.ok', { name }) };
}

/** エディタの欄を組む。 */
function presentEditor(t: Translate, store: Store): EditorSettingsProps {
  const setting = store.settings?.editor ?? { id: 'vscode', path: null, fileCmd: '', dirCmd: '', terminal: 'none' };
  const list = store.editors?.candidates ?? null;
  const badge = (s: EditorDetectState): EditorChoice['badge'] => (s === 'found' ? { text: t('settings.editor.found'), tone: 'ok' } : s === 'app' ? { text: t('settings.editor.appOnly'), tone: 'warn' } : { text: t('settings.editor.notFound'), tone: 'mute' });
  const choices: EditorChoice[] = KNOWN_EDITORS.map((id) => {
    const c = list?.find((x) => x.id === id) ?? null;
    return { id, name: EDITOR_NAMES[id], tile: EDITOR_TILES[id], state: c?.state ?? null, path: c?.path ?? null, version: c?.version ?? null, selected: setting.id === id, badge: c ? badge(c.state) : null };
  });
  choices.push({ id: 'custom', name: t('settings.editor.custom'), tile: '{ }', state: null, path: setting.fileCmd || null, version: null, selected: setting.id === 'custom', badge: null });
  const name = setting.id === 'custom' ? null : EDITOR_NAMES[setting.id];
  const label = name ?? t('external.editor.generic');
  const r = store.editorTest;
  return { setting, name, choices, loading: list === null, test: { running: r === 'running', result: r && r !== 'running' ? editorTestResult(t, label, r) : null } };
}

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
export type SettingsTocRow = { id: SettingsSection; title: string; state: string; tone: 'default' | 'warn'; label: string;
  /** 「エージェント」の群の行。目次は、群の最初の行の前に群の見出しを出し、行の絵はエージェントの絵にする。 */
  agent?: 'claude-code' | 'codex' | 'opencode'; group?: 'agents';
  /** 上級者向けのベータの節（クラウド同期）。名前の横に「ベータ」の小札を添える。 */
  beta?: boolean };

/** 会話の保持の節。押しても保存せず、確認（retention.edit）を開く。 */
export type RetentionSettingsProps = { days: number; options: { value: string; label: string }[]; writable: boolean; reason: string | null; valueLabel: string; bar: UsageBarProps | null; syncNote: boolean };

/**
 * 連携の「hangar が起動する Claude Code に足すもの」（試作 1 節の推す案 B）。
 * 2 つのスイッチ（askStatusAtEnd、liveHints）と既定のモデル（null は Claude Code の既定）と、足す指示の全文。
 */
export type InjectionSettingsProps = { askStatusAtEnd: boolean; liveHints: boolean; /** Remote Control を付けて起動する（--remote-control）。この項目を知らない古いサーバは返さないので入りとして読む。 */ remoteControl: boolean; defaultModel: string | null; full: InjectionPart[] };

/** アカウントに付けられる 5 色（#rrggbb）。サーバは何色でも受けるが、画面からはここから選ぶ。 */
export const ACCOUNT_COLORS = ['#2a57b8', '#7a4a9e', '#2b7048', '#c77a1a', '#a2452f'];

/** アカウントの節。一覧が空なのは、まだ届いていないときだけ（1 件でもあれば出す）。 */
export type AccountSettingsProps = { list: AccountView[]; colors: string[] };

export type SettingsProps = {
  workspaceRoot: string; claudeDir: string; device: { id: string; name: string } | null; version: string; index: IndexProgressDto; indexLabel: string; sessionCount: number; projectCount: number;
  tmuxPath: string | null; terminalApp: TerminalApp;
  /** エディタの欄（一般の節）。 */
  editor: EditorSettingsProps;
  /**
   * 外部ターミナルの選択肢と説明。画面を開いている OS のものだけを出す（macOS は Terminal.app と iTerm2、Windows は Windows Terminal と既定のターミナル）。
   * terminalDescAlways は説明を行に常に出すか（macOS の iTerm2 の許可）で、偽なら見出しの横の ⓘ に畳む。
   */
  terminalOptions: { value: TerminalApp; label: string }[]; terminalDesc: string; terminalDescAlways: boolean;
  /** ターミナルで打つコマンド。どれも同じ hangar の呼び方にそろえる。 */
  /** join は入れた版の CLI でも打てる。setupCloud は wrangler が要るので、リポジトリを clone した場所での呼び方である。 */
  commands: { mcp: string; statusline: string; join: string; setupCloud: string };
  /** 要約エンジン（使わない、Claude、OpenAI 互換）。古いサーバの設定は「使わない」に寄せてある。 */
  summaryEngine: SummaryEngine;
  /** 要約に使う Claude のモデル。 */
  summaryClaudeModel: string;
  /** OpenAI 互換の要約器の API キーを保存しているか（キーそのものは画面に来ない）。 */
  summaryApiKeySet: boolean;
  lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number; allowExternalSummarizer: boolean;
  /** 連携の「hangar が起動する Claude Code に足すもの」。 */
  injection: InjectionSettingsProps;
  summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null;
  statusline: StatuslineStatusDto | null; usageAggregate: UsageAggregateDto | null;
  cloud: CloudSettingsProps;
  /** クラウド同期の節の中の、Claude Code の設定の同期（作り直した実装）。 */
  configSync: ConfigSyncSectionProps;
  shell: ShellSettingsProps;
  /** 同梱サーバを起こす Node の場所。未指定は空文字で表す。 */
  nodePath: string;
  /** run を起こす claude の場所。未指定は null で表す。 */
  claudePath: string | null;
  /** codex と opencode の場所（ベータ）。未指定は null で表す（空欄なら PATH から探す）。 */
  codexPath: string | null; opencodePath: string | null;
  /** インデックスの読み取り元（~/.claude と、Codex が有効なら ~/.codex）を並べた 1 行。 */
  indexSource: string;
  /** Claude Code の会話の保持期間。まだ届いていなければ null。 */
  retention: RetentionSettingsProps | null;
  /**
   * 入力待ちの通知。
   * 出せる環境か（available）と、受け取るか（on）。
   */
  /** ask は OS にまだ尋ねていないこと（「まだ許可していません」と［許可する］を添える）。 */
  notify: { available: boolean; on: boolean; blocked: boolean; ask?: boolean };
  /** ツールの節の先頭の psmux（tmux）の状態の行（段 6 の B3）。準備の確かめが届く前は null。 */
  mux?: MuxStatus | null;
  /**
   * 新しいフォルダの作成場所の「選ぶ…」（Finder）。desktop は殻の中か（ブラウザでは出さない）、picked は殻が返した最後の選択である。
   * 省けば出さない。
   */
  workspacePick?: { desktop: boolean; picked: { path: string; n: number } | null };
  /** 欄の下の 1 行の検証（B1）。準備の確かめが届く前は null。作成場所は空のとき null（行を出さない）。 */
  verify: { workspace: VerifyLine | null; tmux: VerifyLine | null; claude: VerifyLine | null; node: VerifyLine | null; git: VerifyLine | null };
  /** hangar の MCP サーバが user スコープに載っているか。届く前は null。 */
  mcpRegistered: boolean | null;
  /** 連携の 3 枚の札の書き込み（ボタン、書き込む先、ターミナルで行うときのコマンド）。 */
  integrations: IntegrationsProps;
  /** 欄ごとの保存の知らせ（C1）。欄の名前で引く。 */
  save: Record<string, SaveMark>;
  /**
   * 群ごとの直すものの数。目次に印を付ける。無くても動くものは数えない。
   * Claude Code との互換のずれは、利用者が直せるものではないので数えない（目次の点も灯さない）。
   */
  todo: { must: number; link: number };
  /** Claude Code との互換の節（C2）。準備の確かめが届く前と、compat の無い古いサーバの答えでは null。 */
  compat: CompatProps | null;
  /** 連携の「Codex」の面（ベータ）。opencode の面の下に置く。 */
  codex: CodexSettingsProps;
  /** 連携の「opencode」の面（ベータ）。互換の節のすぐ下に置く。 */
  opencode: OpencodeSettingsProps;
  /** 連携の opencode の面の下の「プロバイダー」（ベータ）。opencode を有効にしたときだけ出す。 */
  opencodeProviders?: OpencodeProvidersProps;
  accounts: AccountSettingsProps;
  /** Codex のアカウントの一覧（Codex の節に置く）。Codex が切、または届いていなければ空。 */
  codexAccounts: AccountSettingsProps;
  /** 右に出している節。URL の `at` で決まる（無ければ「一般」、`sync` はクラウド同期、`accounts` はセッション）。 */
  section: SettingsSection;
  /** 左の目次。節ごとに、名前と今の状態の 1 行を持つ。 */
  toc: SettingsTocRow[];
  /** 一般の先頭の言語の行。visible が false の間は描かない。 */
  language: { value: Language };
  /**
   * 開いたとき、節の中の位置へ移る印。
   * accounts はヘッダーのアカウントの設定から、unsent はベルの行から、欄の名前はホームの準備の帯の「設定を開く」から来たときだけ入る。
   */
  focus: 'accounts' | 'unsent' | SettingsField | null;
  /** アプリの更新の節（presenters/update.ts）。 */
  update: UpdateSectionProps;
  /** 一般の「hangar が自分で行うこと」の 2 つのスイッチ。設定の値が無ければ入り（サーバの読み方と同じ）。 */
  /** autoDoneIdleDays は長く動いていない会話を Done にする日数（0 はしない）。 */
  self: { autoDone: boolean; autoDoneIdleDays: AutoDoneIdleDays; autoPark: boolean };
  /**
   * 連携の末尾の「Claude Code に環境を見てもらう」の札。prompt は貼る一言で、画面の言語で作る（setupGuidePrompt）。version は右上の版の札。
   * 写しが取れていなければ null で、札を出さない。
   */
  setupGuide: { prompt: string; version: string } | null;
};

/**
 * 連携の 3 枚の札の書き込み。入っていれば解除の操作、入っていなければ入れる操作を出す。
 * 解除のコマンドは、入れるコマンドの末尾の install を uninstall に替えたもの（同じ hangar の呼び方）。
 */
function presentIntegrations(t: Translate, state: State, store: Store, install: { mcp: string; statusline: string; shell: string }): IntegrationsProps {
  const r = store.readiness;
  const running = state.setupRunning;
  const off = (c: string) => c.replace(/ install$/, ' uninstall');
  const act = (target: SetupTarget, label: string, primary: boolean, disabled = false): IntegrationAction => ({
    target, primary, running: running === target,
    label: running === target ? t('settings.integrations.waiting') : label,
    // 返事を待っているあいだは、ほかの札も押せなくする（殻は承認の窓を 1 つしか出さない）。
    disabled: disabled || running !== null,
  });
  const mcpOn = r?.mcp.registered ?? null;
  const sl = store.statusline;
  const sh = store.shellHook;
  return {
    desktop: store.desktop,
    mcp: {
      file: r?.mcp.file ?? null,
      action: mcpOn === null ? null : mcpOn ? act('mcp-uninstall', t('settings.integrations.mcp.unregister'), false) : act('mcp-install', t('settings.integrations.mcp.register'), true),
      command: mcpOn ? off(install.mcp) : install.mcp,
    },
    statusline: {
      file: sl?.scriptPath ?? null,
      // スクリプトが無いときは、入れる先が無いので押せない（/statusline で作ってから）。
      action: sl === null ? null : sl.installed ? act('statusline-uninstall', t('settings.integrations.statusline.remove'), false) : act('statusline-install', t('settings.integrations.statusline.setup'), true, sl.scriptPath === null),
      command: sl?.installed ? off(install.statusline) : install.statusline,
    },
    shell: {
      file: sh?.zshrc ?? null,
      action: sh?.state === 'on' ? act('shell-uninstall', t('settings.integrations.shell.uninstall'), false) : sh?.state === 'off' ? act('shell-install', t('settings.integrations.shell.install'), true) : null,
      command: sh?.state === 'on' ? off(install.shell) : install.shell,
    },
  };
}

/** 選択肢は決まった 4 つに、今の値がそこに無ければそれを足して、短い順に並べる。 */
function retentionSettings(store: Store): RetentionSettingsProps | null {
  const r = store.retention;
  if (!r) return null;
  const values = [...new Set<number>([...RETENTION_CHOICES, r.days])].sort((a, b) => a - b);
  const projected = r.usage ? r.usage.dailyBytes * r.days : null;
  const t = translatorOf(store);
  return {
    days: r.days,
    options: values.map((d) => ({ value: String(d), label: daysLabel(t, d) })),
    writable: r.writable,
    reason: r.unwritableReason,
    valueLabel: daysLabel(t, r.days),
    bar: usageBar(r.usage, projected, r.days, t),
    // 設定の同期が入っていれば、cleanupPeriodDays も他の PC へ運ぶ。
    syncNote: store.configSync?.enabled === true,
  };
}

/** 「エージェント」の群の節と、その絵の組。 */
const AGENT_OF: Partial<Record<SettingsSection, 'claude-code' | 'codex' | 'opencode'>> = { agentClaude: 'claude-code', agentCodex: 'codex', agentOpencode: 'opencode' };

function agentState(t: Translate, enabled: boolean, badge: { text: string; tone: 'ok' | 'info' | 'warn' } | null): { state: string; tone: 'default' | 'warn' } {
  if (!enabled) return { state: t('settings.toc.agentOff'), tone: 'default' };
  if (!badge) return { state: t('settings.toc.checking'), tone: 'default' };
  return { state: badge.text, tone: badge.tone === 'warn' ? 'warn' : 'default' };
}

/** 目次の各行の状態。連携とツールは、準備の確かめが届くまで分からないので「確認中」と言う。 */
function presentToc(a: {
  t: Translate; language: Language; todo: { must: number; link: number }; cloud: CloudSettingsProps; cloudWord: string; cloudTone: string;
  sync: Store['sync']; notify: Store['notify']; readiness: boolean; summaryEngine: SummaryEngine; summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null; sessionCount: number; retentionDays: number | null; now: number;
  update: UpdateSectionProps; desktop: boolean; usageAggregate: UsageAggregateDto | null; version: string;
  codex: CodexSettingsProps; opencode: OpencodeSettingsProps;
}): SettingsTocRow[] {
  const { t } = a;
  type St = { state: string; tone: 'default' | 'warn' };
  const fix = (n: number, ok: string): St => (n > 0 ? { state: t('settings.fix.count', { n }), tone: 'warn' } : { state: ok, tone: 'default' });
  const checking: St = { state: t('settings.toc.checking'), tone: 'default' };
  const state: Record<SettingsSection, St> = {
    general: { state: !a.notify.available ? t('settings.toc.notifyUnavailable') : a.notify.on ? t('settings.toc.notifyOn') : t('settings.toc.notifyOff'), tone: 'default' },
    cloud: {
      state: a.cloud.state === 'idle' && a.sync?.lastPullAt != null ? t('settings.toc.cloudReceived', { state: a.cloudWord, time: relativeTime(t, a.sync.lastPullAt, a.now) }) : a.cloudWord,
      tone: a.cloudTone === 'warn' || a.cloudTone === 'stop' ? 'warn' : 'default',
    },
    agentClaude: a.readiness ? fix(a.todo.link, t('settings.toc.noIssues')) : checking,
    // Codex と opencode は、切のままなら淡く「オフ」と言う。入れたあとは、版の札（検証済み、未検証、見つかりません）をそのまま状態にする。
    agentCodex: agentState(t, a.codex.enabled, a.codex.badge),
    agentOpencode: agentState(t, a.opencode.enabled, a.opencode.badge),
    // 使わないときは淡く「オフ」とだけ言う（試作 3 節の 2b の案 A）。繋がらない警告は、OpenAI 互換を選んだときだけ出す。
    summary: a.summaryEngine === 'off' ? { state: t('settings.toc.summaryOff'), tone: 'default' }
      : a.summarizerTest?.ok === false ? { state: t('settings.toc.summaryTestFailed'), tone: 'warn' }
        : a.summaryEngine === 'claude' ? { state: t('settings.toc.summaryClaude'), tone: 'default' }
          : a.summarizerModels === null ? checking
            : a.summarizerModels.length === 0 ? { state: t('settings.toc.summaryOffline'), tone: 'warn' }
              : { state: t('settings.toc.summaryConnected'), tone: 'default' },
    environment: a.readiness ? fix(a.todo.must, t('settings.toc.allFound')) : checking,
    // 保持期間の日数は、注意の一覧から外してここに残す（2026-10-13 の決定、9a）。保持の欄と同じ節に置く。
    sessions: { state: a.retentionDays === null ? t('settings.toc.sessions', { n: a.sessionCount.toLocaleString('en-US') }) : t('settings.toc.sessionsRetention', { n: a.sessionCount.toLocaleString('en-US'), days: daysLabel(t, a.retentionDays) }), tone: 'default' },
    // セッションの数は、プロジェクト別の件数を足す（日ごとの件数は日をまたぐ会話を重ねて数える）。
    usage: a.usageAggregate === null ? checking : { state: t('settings.toc.usage', { n: a.usageAggregate.projects.reduce((n, p) => n + p.sessions, 0).toLocaleString('en-US') }), tone: 'default' },
    // 殻の中では更新の状態、ブラウザではバージョンだけを言う。失敗と再起動待ちは注意の色にする（見出しの札の stop と warn）。
    about: a.desktop
      ? { state: a.update.tocState, tone: a.update.badge?.tone === 'stop' || a.update.badge?.tone === 'warn' ? 'warn' : 'default' }
      : { state: t('settings.toc.version', { version: a.version }), tone: 'default' },
  };
  // 「Hangar について」はブラウザでも出す。更新の段は殻の中だけで、ブラウザではバージョンとこの PC を出す。
  return SETTINGS_SECTIONS.map((id) => {
    const title = t(`settings.section.${id}`);
    // クラウド同期は上級者向けのベータ。小札は状態の段を潰さないよう、名前の横に添える（試作の 5 節の案 A）。
    const agent = AGENT_OF[id];
    const beta = id === 'cloud' || id === 'agentCodex' || id === 'agentOpencode';
    const name = beta ? `${title} ${t('settings.toc.beta')}` : title;
    return { id, title, ...state[id], label: t('settings.toc.row', { name, state: state[id].state }), ...(beta ? { beta } : {}), ...(agent ? { agent, group: 'agents' as const } : {}) };
  });
}

/** 外部ターミナルの選択肢の名前。製品の名前はそのまま出し、Windows の既定のターミナルだけ辞書で引く。 */
function terminalLabel(t: Translate, app: TerminalApp): string {
  switch (app) {
    case 'terminal': return 'Terminal.app';
    case 'iterm': return 'iTerm2';
    case 'windowsTerminal': return 'Windows Terminal';
    case 'windowsDefault': return t('settings.general.terminal.windowsDefault');
  }
}

// now は相対時刻のためだけに使う。フェーズ 3 までの呼び出しは 2 引数なので既定値を置く。
// platform は画面を開いている OS で、外部ターミナルの選択肢を決める。試験では差し込む。
export function presentSettings(state: State, store: Store, now: number = Date.now(), platform: string = clientPlatform()): SettingsProps {
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
  // 古い形式の cloud.json で止まっている PC は、未参加と同じ「同期オフ」にせず、再構築が要ることを札と目次でも言う。
  const legacy = sync?.state === 'off' && sync.legacyConfig === true;
  const cloudWord = legacy ? t('settings.toc.cloudLegacy') : limited ? t('settings.toc.cloudLimited') : sync?.state === 'error' && sync.paused ? t('header.sync.pausedErrorShort') : syncStateWord(t, sync?.state ?? 'off');
  const cloudTone: 'ok' | 'off' | 'warn' | 'stop' = legacy ? 'warn' : limited ? 'stop' : sync?.state === 'error' ? 'warn' : sync === null || sync.state === 'off' ? 'off' : sync.state === 'paused' ? 'off' : 'ok';
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
    lastPullAt: relativeTime(t, sync?.lastPullAt ?? null, now),
    pending: sync?.pending ?? 0,
    sweepPending: sync?.sweepPending ?? null,
    skipped: sync?.skipped ?? [],
    devices: store.devices.map((d) => ({ id: d.id, name: d.name, platform: d.platform, lastSeen: relativeTime(t, d.lastSeenAt, now), self: d.self })),
    usage: presentCloudUsage(t, store.cloudUsage, sync, now),
    member: presentCloudMember(store, now),
    // 状態のコマンドは、参加のコマンドと同じ hangar の呼び方（同梱の hangar の絶対パスなど）を使う。
    legacy: legacy ? { statusCommand: cloudJoinCommand(store).replace(/ cloud join <URL>$/, ' cloud status'), docUrl: CLOUD_REBUILD_DOC_URL } : null,
  };
  const at = state.screen.name === 'settings' ? state.screen.at : undefined;
  const h = store.shellHook;
  const command = h?.command ?? 'hangar shell install';
  const shell: ShellSettingsProps = {
    state: h?.state ?? null, zshrc: h?.zshrc ?? '', line: h?.line ?? '', command, uninstallCommand: command.replace(/ install$/, ' uninstall'),
    // osSupported を返さない古いサーバは、今までどおり出す。
    available: h?.osSupported !== false,
    // 自端末の行は 10 分おきにしか書き直されないので、Settings を開いたときに測った値で上書きする。
    // Windows の端末は包みを作らないので、tmux の有無ではなく OS で使えないと書く。
    devices: store.devices.map((d) => { const state = d.self && h ? h.state : d.shell; return { id: d.id, name: d.name, self: d.self, state, label: d.platform === 'win32' ? t('settings.integrations.shell.unsupportedOs') : shellLabel(t, state) }; }),
  };
  const r = store.readiness;
  // 鍵を知らない古いサーバの設定は「使わない」として読む。
  const summaryEngine: SummaryEngine = s?.summaryEngine ?? 'off';
  const verify = {
    workspace: r ? workspaceLine(t, r.workspace) : null,
    tmux: r ? toolLine(t, 'tmux', r.tools.tmux) : null,
    claude: r ? toolLine(t, 'claude', r.tools.claude) : null,
    node: r ? toolLine(t, 'node', r.tools.node) : null,
    // git は設定の欄が無いので、ツールの節に読むだけの行で出す。古いサーバは返さない。
    git: r?.tools.git ? toolLine(t, 'git', r.tools.git) : null,
  };
  // compat の無い古いサーバの答えでは、互換の節を「確かめています」のままにする。
  const compatSummary = r ? readinessCompat(r) : undefined;
  const hard = (l: VerifyLine | null) => (l && !l.ok && !l.soft ? 1 : 0);
  const update = presentUpdateSection(store, now);
  const todo = {
    must: hard(verify.workspace) + hard(verify.tmux) + hard(verify.node),
    link: r ? (r.mcp.registered ? 0 : 1) + (r.statusline.installed ? 0 : 1) + hard(verify.claude) : 0,
  };
  const codex = presentCodex(t, s ?? {}, store.codexStatus, platform, store.shellHook?.state ?? null);
  const opencode = presentOpencode(t, s ?? {}, store.opencodeStatus, platform, store.shellHook?.state ?? null);
  const integrations = presentIntegrations(t, state, store, { mcp: r?.commands.mcp ?? 'hangar mcp install', statusline: r?.commands.statusline ?? 'hangar statusline install', shell: command });
  return {
    cloud,
    integrations,
    configSync: presentConfigSection(store, now, at === 'unsent'),
    shell,
    verify, todo,
    mux: presentMux(r, state.muxCheck),
    compat: compatSummary ? presentCompat(t, compatSummary, store.compat, store.version) : null,
    opencode,
    opencodeProviders: presentOpencodeProviders(state, store),
    codex,
    mcpRegistered: r ? r.mcp.registered : null,
    save: state.settingsSave,
    // 準備の確かめが届く前も、同じ hangar の呼び方で見せる。
    commands: { mcp: r?.commands.mcp ?? 'hangar mcp install', statusline: r?.commands.statusline ?? 'hangar statusline install', join: cloudJoinCommand(store), setupCloud: SETUP_CLOUD_COMMAND },
    workspacePick: { desktop: store.desktop, picked: store.pickedFolder },
    workspaceRoot: s?.workspaceRoot ?? '', claudeDir: s?.claudeDir ?? '', device: store.device, version: store.version, index: store.index,
    // 進んでいる間はヘッダーと同じ文にし、終わっていれば数を出す。
    indexLabel: indexProgressLabel(t, store.index) ?? t('settings.info.index.counts', { sessions: Object.keys(store.sessions).length, projects: Object.keys(store.projects).length }),
    sessionCount: Object.keys(store.sessions).length, projectCount: Object.keys(store.projects).length,
    // 別の OS で保存した値（macOS の iTerm2 を Windows で読んだときなど）は、この OS の既定として見せる。
    tmuxPath: s?.tmuxPath ?? null, terminalApp: terminalAppFor(s?.terminalApp, platform), editor: presentEditor(t, store),
    terminalOptions: terminalAppsFor(platform).map((value) => ({ value, label: terminalLabel(t, value) })),
    terminalDesc: t(platform === 'win32' ? 'settings.general.terminal.descWindows' : 'settings.general.terminal.desc'), terminalDescAlways: platform !== 'win32',
    summaryEngine, summaryClaudeModel: s?.summaryClaudeModel ?? DEFAULT_SUMMARY_CLAUDE_MODEL, summaryApiKeySet: s?.summaryApiKeySet === true,
    injection: { askStatusAtEnd: s?.askStatusAtEnd !== false, liveHints: s?.liveHints !== false, remoteControl: s?.remoteControl !== false, defaultModel: s?.defaultModel ?? null, full: presentInjection(t, { askStatusAtEnd: s?.askStatusAtEnd !== false, liveHints: s?.liveHints !== false }) },
    lmStudioUrl: s?.lmStudioUrl ?? '', lmStudioModel: s?.lmStudioModel ?? null, summaryFallback: s?.summaryFallback ?? false, summaryHourlyCap: s?.summaryHourlyCap ?? 20, allowExternalSummarizer: s?.allowExternalSummarizer ?? false,
    summarizerModels: store.summarizerModels, summarizerTest: store.summarizerTest,
    statusline: store.statusline, usageAggregate: store.usageAggregate && { ...store.usageAggregate, projects: store.usageAggregate.projects.map((u) => { const p = u.projectId ? store.projects[u.projectId] : undefined; return p ? { ...u, name: projectDisplayName(p, t) } : u; }) },
    nodePath: s?.nodePath ?? '',
    claudePath: s?.claudePath ?? null,
    codexPath: s?.codexPath ?? null,
    opencodePath: s?.opencodePath ?? null,
    indexSource: [s?.claudeDir ?? '', ...(codexEnabledOf(s ?? {}) ? ['~/.codex'] : [])].join(storeLanguage(store) === 'ja' ? '、' : ', '),
    retention: retentionSettings(store),
    accounts: { list: presentAccounts(store, now), colors: ACCOUNT_COLORS },
    codexAccounts: { list: presentCodexAccounts(store, now), colors: ACCOUNT_COLORS },
    section: settingsSectionOf(at),
    toc: presentToc({ t, language: storeLanguage(store), todo, cloud, cloudWord, cloudTone, sync, notify: store.notify, readiness: r !== null, summaryEngine, summarizerModels: store.summarizerModels, summarizerTest: store.summarizerTest, sessionCount: Object.keys(store.sessions).length, retentionDays: store.retention?.days ?? null, now, update, desktop: store.desktop, codex, opencode, usageAggregate: store.usageAggregate, version: store.version }),
    update,
    language: { value: storeLanguage(store) },
    focus: at === 'accounts' || at === 'unsent' || isSettingsField(at) ? at : null,
    notify: { available: store.notify.available, on: store.notify.on, blocked: store.notify.blocked, ...(store.notify.ask ? { ask: true } : {}) },
    self: { autoDone: s?.autoDone !== false, autoDoneIdleDays: isAutoDoneIdleDays(s?.autoDoneIdleDays) ? s.autoDoneIdleDays : DEFAULT_AUTO_DONE_IDLE_DAYS, autoPark: s?.autoPark !== false },
    setupGuide: store.setupGuide ? { prompt: setupGuidePrompt(t, store.setupGuide), version: store.setupGuide.version } : null,
  };
}
