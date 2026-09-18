import type { IndexProgressDto, StatuslineStatusDto, SummarizerTestDto, TerminalApp, UsageAggregateDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

export type SettingsProps = {
  workspaceRoot: string; claudeDir: string; device: { id: string; name: string } | null; version: string; index: IndexProgressDto; sessionCount: number; projectCount: number;
  tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null; mcpInstallCommand: string;
  lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number;
  summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null;
  statusline: StatuslineStatusDto | null; statuslineCommand: string; usageAggregate: UsageAggregateDto | null;
};

export function presentSettings(_state: State, store: Store): SettingsProps {
  const s = store.settings;
  return {
    workspaceRoot: s?.workspaceRoot ?? '', claudeDir: s?.claudeDir ?? '', device: store.device, version: store.version, index: store.index,
    sessionCount: Object.keys(store.sessions).length, projectCount: Object.keys(store.projects).length,
    tmuxPath: s?.tmuxPath ?? null, terminalApp: s?.terminalApp ?? 'terminal', codePath: s?.codePath ?? null, mcpInstallCommand: 'npm run hangar -- mcp install',
    lmStudioUrl: s?.lmStudioUrl ?? '', lmStudioModel: s?.lmStudioModel ?? null, summaryFallback: s?.summaryFallback ?? true, summaryHourlyCap: s?.summaryHourlyCap ?? 20,
    summarizerModels: store.summarizerModels, summarizerTest: store.summarizerTest,
    statusline: store.statusline, statuslineCommand: 'npm run hangar -- statusline install', usageAggregate: store.usageAggregate,
  };
}
