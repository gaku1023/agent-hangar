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
  it('同じツールなら「Bash ×5」、混ざれば「ツール ×N」。1 回だけなら名前だけ', () => {
    expect(head([bash(1), bash(2), bash(3)]).label).toBe('Bash ×3');
    expect(head([bash(1), toolItem(2, 'Read', { file_path: '/w/app/a.ts' }, null)]).label).toBe('ツール ×2');
    expect(head([bash(1), toolItem(2, 'Read', { file_path: '/w/app/a.ts' }, null)], en).label).toBe('Tools ×2');
    expect(head([bash(1)]).label).toBe('Bash');
  });
  it('説明は最後の呼び出しのもの（Bash は description、無ければコマンド。ほかは要約の文）。時刻も最後の呼び出し', () => {
    expect(head([bash(1, '一覧を出す'), bash(2, '型を調べる')])).toMatchObject({ desc: '型を調べる', when: '10:02' });
    expect(head([bash(1, '一覧を出す'), bash(2)]).desc).toBe('ls 2');
    expect(head([bash(1), toolItem(2, 'Read', { file_path: '/w/app/src/a.ts' }, null)]).desc).toBe('src/a.ts');
  });
  it('失敗した呼び出しの数を持ち、その語を添える', () => {
    expect(head([bash(1), bash(2, undefined, true), bash(3, undefined, true)])).toMatchObject({ failed: 2, failedLabel: '失敗 2' });
    expect(head([bash(1)])).toMatchObject({ failed: 0, failedLabel: null });
    expect(head([bash(1, undefined, true)], en).failedLabel).toBe('1 failed');
  });
});
