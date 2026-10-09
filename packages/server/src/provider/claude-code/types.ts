import type { LiveSessionDto } from '@agent-hangar/shared';

/** deviceId が null なら手元（~/.claude）のファイル。文字列ならその端末から降ろした写しである。 */
export type DiscoveredFile = { path: string; sessionId: string; agentId: string | null; deviceId: string | null };
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
  /** MCP の設定を書いた 0600 のファイル。トークンを argv に載せないため、パスだけを渡す。 */
  mcpConfigPath: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  worktree?: string;
  addDirs?: string[];
};
