import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@agent-hangar/shared';
import { buildTurns, jumpWindow } from './turns.ts';

const u = (seq: number, text: string): TranscriptEvent => ({ kind: 'user', seq, ts: 1, text });
const a = (seq: number, text: string): TranscriptEvent => ({ kind: 'assistant', seq, ts: 1, text });
const call = (seq: number, toolId: string): TranscriptEvent => ({ kind: 'tool_call', seq, ts: 1, toolId, name: 'Bash', input: {}, summary: `Bash ${toolId}` });
const res = (seq: number, toolId: string): TranscriptEvent => ({ kind: 'tool_result', seq, ts: 1, toolId, text: 'ok', isError: false });
const sys = (seq: number, text: string): TranscriptEvent => ({ kind: 'system', seq, ts: 1, text });

describe('buildTurns', () => {
  const events = [
    sys(0, '<local-command-caveat>Caveat</local-command-caveat>'),
    u(1, '最初の指示です\n2 行目'),
    a(2, 'はい'), call(3, 't1'), res(4, 't1'), call(5, 't2'), res(6, 't2'),
    sys(7, '<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>'),
    sys(8, '<local-command-stdout>Set model to opus</local-command-stdout>'),
    u(9, '[Request interrupted by user]'),
    u(10, '次の指示'), a(11, 'どうぞ'),
  ];
  it('利用者の指示とスラッシュコマンドで区切り、ツールの数を数える', () => {
    const t = buildTurns(events);
    expect(t.map((x) => x.text)).toEqual(['最初の指示です\n2 行目', '/model opus', '次の指示']);
    expect(t.map((x) => x.tools)).toEqual([2, 0, 0]);
    expect(t.map((x) => x.head)).toEqual(['最初の指示です', '/model opus', '次の指示']);
  });
  it('各ターンは次のターンの手前までの行を持つ。中断の知らせは区切りにしない', () => {
    const t = buildTurns(events);
    expect(t.map((x) => [x.from, x.to])).toEqual([[1, 7], [7, 10], [10, Infinity]]);
  });
  it('最初の指示より前の行はターンにしない', () => {
    expect(buildTurns([a(0, '前置き'), u(1, 'はじめ')]).map((x) => x.seq)).toEqual([1]);
  });
});

describe('jumpWindow', () => {
  const heads = Array.from({ length: 20 }, (_, i) => `h${i}`);
  it('新しい側の指示は末尾から数え、目的より少し古い側まで添える', () => {
    expect(jumpWindow(heads, 17, true)).toEqual({ heads: heads.slice(12), index: 5, from: 'bottom' });
  });
  it('古い側の指示は、会話の最初まで読み込んでいれば先頭から数える', () => {
    expect(jumpWindow(heads, 2, true)).toEqual({ heads: heads.slice(0, 8), index: 2, from: 'top' });
  });
  it('会話の最初を読み込んでいなければ、古い側でも末尾から数える', () => {
    expect(jumpWindow(heads, 2, false)).toEqual({ heads, index: 2, from: 'bottom' });
  });
  it('送れる数を超えるときは null', () => {
    const many = Array.from({ length: 3000 }, (_, i) => `h${i}`);
    expect(jumpWindow(many, 1500, true)).toBeNull();
    expect(jumpWindow(many, 2990, true)?.from).toBe('bottom');
  });
});
