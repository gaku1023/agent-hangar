export type Attachment = { kind: 'image' | 'file'; name?: string };
export type TranscriptEvent =
  | { kind: 'user'; seq: number; ts?: number; text: string; attachments?: Attachment[] }
  | { kind: 'assistant'; seq: number; ts?: number; text: string; model?: string }
  | { kind: 'thinking'; seq: number; ts?: number; text: string }
  | { kind: 'tool_call'; seq: number; ts?: number; toolId: string; name: string; input: unknown; summary: string; filePath?: string }
  | { kind: 'tool_result'; seq: number; ts?: number; toolId: string; text: string; isError: boolean }
  | { kind: 'subagent'; seq: number; ts?: number; agentId: string; label: string }
  // subtype は Claude Code の system 行の種類（turn_duration など）。本文の無い行は text も subtype と同じになる。
  | { kind: 'system'; seq: number; ts?: number; text: string; subtype?: string }
  | { kind: 'meta'; seq: number; ts?: number; name: string; value: unknown };
