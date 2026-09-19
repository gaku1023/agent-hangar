import type { IndexProgressDto, StatuslineStatusDto, SummarizerTestDto, SyncStateKind, TerminalApp, UsageAggregateDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { relativeTime } from './format.ts';

// id は一覧の React の key に使う。1 台の Mac で 2 端末を模すと名前も最終確認も揃うので、一意なのは id だけである。
export type CloudDeviceProps = { id: string; name: string; platform: string; lastSeen: string; self: boolean };
export type CloudSettingsProps = { configured: boolean; url: string | null; state: SyncStateKind; paused: boolean; lastPullAt: string; pending: number; devices: CloudDeviceProps[]; joinToken: string | null; syncClaudeConfig: boolean; configConfirmed: boolean };

export type SettingsProps = {
  workspaceRoot: string; claudeDir: string; device: { id: string; name: string } | null; version: string; index: IndexProgressDto; sessionCount: number; projectCount: number;
  tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null; mcpInstallCommand: string;
  lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number; allowExternalSummarizer: boolean;
  summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null;
  statusline: StatuslineStatusDto | null; statuslineCommand: string; usageAggregate: UsageAggregateDto | null;
  cloud: CloudSettingsProps;
  /** 同梱サーバを起こす Node の場所。未指定は空文字で表す。 */
  nodePath: string;
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
    paused: sync?.state === 'paused',
    lastPullAt: relativeTime(sync?.lastPullAt ?? null, now),
    pending: sync?.pending ?? 0,
    devices: store.devices.map((d) => ({ id: d.id, name: d.name, platform: d.platform, lastSeen: relativeTime(d.lastSeenAt, now), self: d.self })),
    joinToken: store.joinToken,
    syncClaudeConfig: s?.syncClaudeConfig ?? false,
    configConfirmed: sync?.claudeConfig.confirmed ?? false,
  };
  return {
    cloud,
    workspaceRoot: s?.workspaceRoot ?? '', claudeDir: s?.claudeDir ?? '', device: store.device, version: store.version, index: store.index,
    sessionCount: Object.keys(store.sessions).length, projectCount: Object.keys(store.projects).length,
    tmuxPath: s?.tmuxPath ?? null, terminalApp: s?.terminalApp ?? 'terminal', codePath: s?.codePath ?? null, mcpInstallCommand: 'npm run hangar -- mcp install',
    lmStudioUrl: s?.lmStudioUrl ?? '', lmStudioModel: s?.lmStudioModel ?? null, summaryFallback: s?.summaryFallback ?? true, summaryHourlyCap: s?.summaryHourlyCap ?? 20, allowExternalSummarizer: s?.allowExternalSummarizer ?? false,
    summarizerModels: store.summarizerModels, summarizerTest: store.summarizerTest,
    statusline: store.statusline, statuslineCommand: 'npm run hangar -- statusline install', usageAggregate: store.usageAggregate,
    nodePath: s?.nodePath ?? '',
  };
}
