import type { IndexProgressDto, ShellHookStateDto, StatuslineStatusDto, SummarizerTestDto, SyncSkippedDto, SyncStateKind, TerminalApp, UsageAggregateDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { indexProgressLabel, relativeTime, SYNC_STATE_LABEL } from './format.ts';

// id は一覧の React の key に使う。1 台の Mac で 2 端末を模すと名前も最終確認も揃うので、一意なのは id だけである。
export type CloudDeviceProps = { id: string; name: string; platform: string; lastSeen: string; self: boolean };
/**
 * sweepPending はまだ上げていない本文の件数で、数えられないときは null である。
 * ヘッダーと違ってここは 0 件も描く。0 と書いてあれば「追いついた」と読めるからである。
 * skipped は送れなかった本文で、件数だけでは直しようが無いので鍵と理由もそのまま渡す。
 * stateLabel はヘッダーと同じ表から引いた状態の語である。
 */
export type CloudSettingsProps = { configured: boolean; url: string | null; state: SyncStateKind; stateLabel: string; paused: boolean; lastPullAt: string; pending: number; sweepPending: number | null; skipped: SyncSkippedDto[]; devices: CloudDeviceProps[]; joinToken: string | null; syncClaudeConfig: boolean; configConfirmed: boolean };

/**
 * 外のターミナル（VS Code など）で起動した claude を hangar で開けるようにする包み方。
 * state はこの PC の状態で、読み込む前は null。devices は同期している PC ごとの状態で、自端末は測り直した値を使う。
 * command は入れるために貼るコマンドで、uninstallCommand は外すためのコマンド。
 */
export type ShellSettingsProps = { state: ShellHookStateDto | null; zshrc: string; line: string; command: string; uninstallCommand: string; devices: { id: string; name: string; self: boolean; label: string }[] };

/** PC ごとの状態の言い方。null は状態を知らせてこない古い版の hangar である。 */
const SHELL_LABEL: Record<ShellHookStateDto, string> = { on: '入っています', off: 'まだです', unsupported: 'この Claude Code では使えません' };
const shellLabel = (s: ShellHookStateDto | null): string => (s ? SHELL_LABEL[s] : '分かりません（hangar が古い版です）');

export type SettingsProps = {
  workspaceRoot: string; claudeDir: string; device: { id: string; name: string } | null; version: string; index: IndexProgressDto; indexLabel: string; sessionCount: number; projectCount: number;
  tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null; mcpInstallCommand: string;
  lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number; allowExternalSummarizer: boolean;
  summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null;
  statusline: StatuslineStatusDto | null; statuslineCommand: string; usageAggregate: UsageAggregateDto | null;
  cloud: CloudSettingsProps;
  shell: ShellSettingsProps;
  /** 同梱サーバを起こす Node の場所。未指定は空文字で表す。 */
  nodePath: string;
  /** run を起こす claude の場所。未指定は null で表す。 */
  claudePath: string | null;
};

// now は相対時刻のためだけに使う。フェーズ 3 までの呼び出しは 2 引数なので既定値を置く。
export function presentSettings(_state: State, store: Store, now: number = Date.now()): SettingsProps {
  const s = store.settings;
  const sync = store.sync;
  // 同期の状態が届いていない端末と、off が届いている端末は同じ「設定していない」扱いにする。
  const cloud: CloudSettingsProps = {
    configured: sync !== null && sync.state !== 'off',
    url: sync?.url ?? null,
    state: sync?.state ?? 'off',
    stateLabel: SYNC_STATE_LABEL[sync?.state ?? 'off'],
    paused: sync?.state === 'paused',
    lastPullAt: relativeTime(sync?.lastPullAt ?? null, now),
    pending: sync?.pending ?? 0,
    sweepPending: sync?.sweepPending ?? null,
    skipped: sync?.skipped ?? [],
    devices: store.devices.map((d) => ({ id: d.id, name: d.name, platform: d.platform, lastSeen: relativeTime(d.lastSeenAt, now), self: d.self })),
    joinToken: store.joinToken,
    syncClaudeConfig: s?.syncClaudeConfig ?? false,
    configConfirmed: sync?.claudeConfig.confirmed ?? false,
  };
  const h = store.shellHook;
  const command = h?.command ?? 'hangar shell install';
  const shell: ShellSettingsProps = {
    state: h?.state ?? null, zshrc: h?.zshrc ?? '', line: h?.line ?? '', command, uninstallCommand: command.replace(/ install$/, ' uninstall'),
    // 自端末の行は 10 分おきにしか書き直されないので、Settings を開いたときに測った値で上書きする。
    devices: store.devices.map((d) => ({ id: d.id, name: d.name, self: d.self, label: shellLabel(d.self && h ? h.state : d.shell) })),
  };
  return {
    cloud,
    shell,
    workspaceRoot: s?.workspaceRoot ?? '', claudeDir: s?.claudeDir ?? '', device: store.device, version: store.version, index: store.index,
    // 進んでいる間はヘッダーと同じ文にし、終わっていれば数を出す。
    indexLabel: indexProgressLabel(store.index) ?? `${Object.keys(store.sessions).length} セッション、${Object.keys(store.projects).length} プロジェクト`,
    sessionCount: Object.keys(store.sessions).length, projectCount: Object.keys(store.projects).length,
    tmuxPath: s?.tmuxPath ?? null, terminalApp: s?.terminalApp ?? 'terminal', codePath: s?.codePath ?? null, mcpInstallCommand: 'npm run hangar -- mcp install',
    lmStudioUrl: s?.lmStudioUrl ?? '', lmStudioModel: s?.lmStudioModel ?? null, summaryFallback: s?.summaryFallback ?? true, summaryHourlyCap: s?.summaryHourlyCap ?? 20, allowExternalSummarizer: s?.allowExternalSummarizer ?? false,
    summarizerModels: store.summarizerModels, summarizerTest: store.summarizerTest,
    statusline: store.statusline, statuslineCommand: 'npm run hangar -- statusline install', usageAggregate: store.usageAggregate,
    nodePath: s?.nodePath ?? '',
    claudePath: s?.claudePath ?? null,
  };
}
