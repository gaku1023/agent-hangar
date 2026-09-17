import type { IndexProgressDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

export type SettingsProps = { workspaceRoot: string; claudeDir: string; device: { id: string; name: string } | null; version: string; index: IndexProgressDto; sessionCount: number; projectCount: number };

export function presentSettings(_state: State, store: Store): SettingsProps {
  return { workspaceRoot: store.settings?.workspaceRoot ?? '', claudeDir: store.settings?.claudeDir ?? '', device: store.device, version: store.version, index: store.index, sessionCount: Object.keys(store.sessions).length, projectCount: Object.keys(store.projects).length };
}
