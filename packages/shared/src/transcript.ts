export type Attachment = { kind: 'image' | 'file'; name?: string };
export type TranscriptEvent =
  | { kind: 'user'; seq: number; ts?: number; text: string; attachments?: Attachment[] }
  | { kind: 'assistant'; seq: number; ts?: number; text: string; model?: string }
  | { kind: 'thinking'; seq: number; ts?: number; text: string }
  | { kind: 'tool_call'; seq: number; ts?: number; toolId: string; name: string; input: unknown; summary: string; filePath?: string }
  | { kind: 'tool_result'; seq: number; ts?: number; toolId: string; text: string; isError: boolean }
  | { kind: 'subagent'; seq: number; ts?: number; agentId: string; label: string }
  | { kind: 'system'; seq: number; ts?: number; text: string }
  | { kind: 'meta'; seq: number; ts?: number; name: string; value: unknown };
