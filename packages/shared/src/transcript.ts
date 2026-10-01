export type Attachment = { kind: 'image' | 'file'; name?: string };
export type TranscriptEvent =
  | { kind: 'user'; seq: number; ts?: number; text: string; attachments?: Attachment[] }
  | { kind: 'assistant'; seq: number; ts?: number; text: string; model?: string }
  | { kind: 'thinking'; seq: number; ts?: number; text: string }
  | { kind: 'tool_call'; seq: number; ts?: number; toolId: string; name: string; input: unknown; summary: string; filePath?: string }
  // agentLaunch は Agent の結果にだけ付く。サブエージェントの transcript（subagents/agent-<agentId>.jsonl）と結ぶのに使う。
  | { kind: 'tool_result'; seq: number; ts?: number; toolId: string; text: string; isError: boolean; agentLaunch?: { agentId: string; async: boolean } }
  | { kind: 'subagent'; seq: number; ts?: number; agentId: string; label: string }
  // subtype は Claude Code の system 行の種類（turn_duration など）。本文の無い行は text も subtype と同じになる。
  | { kind: 'system'; seq: number; ts?: number; text: string; subtype?: string }
  | { kind: 'meta'; seq: number; ts?: number; name: string; value: unknown };

/**
 * 指示の書き出しの長さ。Claude Code の画面の指示の行と突き合わせるのに使う。
 * 狭い端末でも 1 行目に収まる長さにする。UI とサーバで同じ長さに切らないと突き合わせが外れる。
 */
export const PROMPT_HEAD_LEN = 16;
/** 1 回の「指示へ跳ぶ」で送ってよい書き出しの数。UI は目的の指示から近い端までを切り出して送る。 */
export const MAX_JUMP_HEADS = 1000;

/** 指示の本文から書き出しを作る。空白の並びは 1 つにまとめ、最初の空でない行だけを使う。 */
export function promptHead(text: string): string {
  const first = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return first.replace(/\s+/g, ' ').trim().slice(0, PROMPT_HEAD_LEN);
}
