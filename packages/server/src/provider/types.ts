import type { LiveSessionDto, TranscriptEvent } from '@agent-hangar/shared';

export type DiscoveredFile = { path: string; sessionId: string; agentId: string | null };
export type LiveSession = LiveSessionDto;

export type LaunchMode =
  | { kind: 'start'; sessionUuid: string }
  | { kind: 'resume'; sessionUuid: string }
  | { kind: 'fork'; sessionUuid: string; newSessionUuid: string };

export type LaunchInput = {
  mode: LaunchMode;
  name?: string;
  prompt?: string;
  systemPrompt: string;
  mcpUrl: string;
  token: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  worktree?: string;
  addDirs?: string[];
};

export interface Provider {
  readonly id: 'claude-code' | 'opencode';
  discover(): DiscoveredFile[];
  watch(onChange: (path: string) => void): () => void;
  readEvents(file: string, fromByte: number): { events: TranscriptEvent[]; offset: number; length: number }[];
  liveStatus(): LiveSession[];
  launchCommand(bin: string, input: LaunchInput): string[];
  resumeCommand(bin: string, input: Omit<LaunchInput, 'mode'>, session: { providerSessionId: string }, fork: boolean, newSessionUuid?: string): string[];
}
