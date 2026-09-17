import type { LiveSessionDto, TranscriptEvent } from '@agent-hangar/shared';

export type DiscoveredFile = { path: string; sessionId: string; agentId: string | null };
export type LiveSession = LiveSessionDto;

export interface Provider {
  readonly id: 'claude-code' | 'opencode';
  discover(): DiscoveredFile[];
  watch(onChange: (path: string) => void): () => void;
  readEvents(file: string, fromByte: number): { events: TranscriptEvent[]; offset: number; length: number }[];
  liveStatus(): LiveSession[];
  launchCommand(params: unknown): string[];
  resumeCommand(session: unknown, fork: boolean): string[];
}
