import type { TranscriptItem } from '../presenters/session.ts';
import { presentTool } from '../presenters/tools.ts';

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

/** 試験の本文に置くツールの行。見せ方は本物の presentTool で作る。 */
export function toolItem(seq: number, name: string, input: unknown, result: { text: string; isError: boolean } | null, over: Partial<ToolItem> = {}): ToolItem {
  const summary = `${name} ${typeof input === 'object' && input && 'command' in input ? String((input as { command: unknown }).command) : ''}`.trim();
  return { kind: 'tool', seq, summary, name, view: presentTool({ kind: 'tool_call', seq, toolId: `t${seq}`, name, input, summary }, result, '/w/app'), raw: null, result, when: '12:00', subagent: null, ...over };
}
