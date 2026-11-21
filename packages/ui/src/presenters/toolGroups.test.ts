import { describe, expect, it } from 'vitest';
import { translator } from '@agent-hangar/shared';
import { toolItem } from '../test/items.ts';
import type { TranscriptItem } from './session.ts';
import { groupRows, toolGroupHead } from './toolGroups.ts';

const ja = translator('ja');
const en = translator('en');
const user = (seq: number): TranscriptItem => ({ kind: 'user', seq, text: 'u', when: '10:00' });
const said = (seq: number): TranscriptItem => ({ kind: 'assistant', seq, text: 'a', when: '10:00' });
const bash = (seq: number, description?: string, isError = false) => toolItem(seq, 'Bash', { command: `ls ${seq}`, ...(description ? { description } : {}) }, { text: 'ok', isError }, { when: `10:0${seq}` });
const tools = (r: ReturnType<typeof groupRows>[number]) => r.items.map((it) => it.seq);

describe('本文の行のまとめ（T1）', () => {
  it('続けて並ぶツールの呼び出しを 1 つの行にまとめ、利用者や Claude の文で区切る', () => {
    const rows = groupRows([user(0), bash(1), bash(2), bash(3), said(4), bash(5), user(6)], true);
    expect(rows.map((r) => [r.key, r.tools, tools(r)])).toEqual([
      [0, false, [0]],
      [1, true, [1, 2, 3]],
      [4, false, [4]],
      [5, true, [5]],
      [6, false, [6]],
    ]);
  });
  it('思考と知らせの行も区切りにする', () => {
    const think: TranscriptItem = { kind: 'thinking', seq: 2, text: 't', when: '' };
    const sys: TranscriptItem = { kind: 'system', seq: 4, text: 's', when: '' };
    expect(groupRows([bash(1), think, bash(3), sys, bash(5)], true).map(tools)).toEqual([[1], [2], [3], [4], [5]]);
  });
  it('サブエージェントを起こした呼び出しは、まとめずに 1 つで置く（「見る」のボタンを常に出すため）', () => {
    const agent = toolItem(2, 'Agent', { description: 'x' }, null, { subagent: { agentId: 'abc', label: 'x' } });
    expect(groupRows([bash(1), agent, bash(3), bash(4)], true).map(tools)).toEqual([[1], [2], [3, 4]]);
  });
  it('まとめないとき（詳細表示）は、1 件ずつの行にし、ツールの行もまとめの形にしない', () => {
    const rows = groupRows([bash(1), bash(2)], false);
    expect(rows.map((r) => [r.key, r.tools, tools(r)])).toEqual([[1, false, [1]], [2, false, [2]]]);
  });
});

describe('まとめの行の見出し', () => {
  const head = (items: TranscriptItem[], t = ja) => toolGroupHead(items as Extract<TranscriptItem, { kind: 'tool' }>[], t);
  it('札は呼んだ数だけ（ツールの名前、説明、時刻は出さない）', () => {
    expect(head([bash(1), bash(2), bash(3)]).label).toBe('ツール呼び出し 3 回');
    expect(head([bash(1), toolItem(2, 'Read', { file_path: '/w/app/a.ts' }, null)]).label).toBe('ツール呼び出し 2 回');
    expect(head([bash(1), bash(2)], en).label).toBe('2 tool calls');
    expect(head([bash(1)])).toEqual({ label: 'ツール呼び出し 1 回', failed: 0, failedLabel: null });
  });
  it('失敗した呼び出しの数を持ち、その語を添える', () => {
    expect(head([bash(1), bash(2, undefined, true), bash(3, undefined, true)])).toMatchObject({ failed: 2, failedLabel: '失敗 2' });
    expect(head([bash(1, undefined, true)], en).failedLabel).toBe('1 failed');
  });
});

describe('質問は会話の一部', () => {
  it('AskUserQuestion の呼び出しはまとめず、前後のツールの間で 1 つの行にする', () => {
    const ask = toolItem(3, 'AskUserQuestion', { questions: [] }, null);
    expect(groupRows([bash(1), bash(2), ask, bash(4)], true).map((r) => [r.tools, tools(r)])).toEqual([[true, [1, 2]], [false, [3]], [true, [4]]]);
  });
  it('本文を持つ行（要約の頭とエージェントの報告）は、続くツールのまとめに入れず 1 つで置く', () => {
    const b = bash(3);
    const note = { ...b, name: 'compact', view: { ...b.view, body: { kind: 'note' as const, text: 'x', tools: [] } } };
    expect(groupRows([bash(1), bash(2), note, bash(4)], true).map((r) => [r.tools, tools(r)])).toEqual([[true, [1, 2]], [false, [3]], [true, [4]]]);
  });
});
