import type { IndexProgressDto, TerminalApp } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

export type SettingsProps = { workspaceRoot: string; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null; mcpInstallCommand: string; device: { id: string; name: string } | null; version: string; index: IndexProgressDto; sessionCount: number; projectCount: number };

export function presentSettings(_state: State, store: Store): SettingsProps {
  const s = store.settings;
  return { workspaceRoot: s?.workspaceRoot ?? '', claudeDir: s?.claudeDir ?? '', tmuxPath: s?.tmuxPath ?? null, terminalApp: s?.terminalApp ?? 'terminal', codePath: s?.codePath ?? null, mcpInstallCommand: 'npx hangar mcp install', device: store.device, version: store.version, index: store.index, sessionCount: Object.keys(store.sessions).length, projectCount: Object.keys(store.projects).length };
}
