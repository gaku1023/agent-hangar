import type { TranscriptEvent } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { buildScan, olderIn, onlyRepliesIn, positionIn, settle, turnsIn, type TailRow } from './items.ts';

const user = (seq: number, text: string): TranscriptEvent => ({ kind: 'user', seq, ts: seq, text });
const asst = (seq: number, text: string): TranscriptEvent => ({ kind: 'assistant', seq, ts: seq, text });
const call = (seq: number, toolId: string): TranscriptEvent => ({ kind: 'tool_call', seq, ts: seq, toolId, name: 'Read', input: { file_path: '/a' }, summary: '' });
const result = (seq: number, toolId: string, isError = false): TranscriptEvent => ({ kind: 'tool_result', seq, ts: seq, toolId, text: 'x', isError });
const row = (id: string, events: TranscriptEvent[], isUserLine = false): TailRow => ({ id, isUserLine, events });

const itemsOf = (rows: TailRow[]) => settle(buildScan(rows)).items;

describe('items', () => {
  it('2 つ目の項目から id に :n を付ける（索引の読み口も同じ規則）', () => {
    const items = itemsOf([row('s1', [asst(1, 'a'), call(2, 't1'), asst(3, 'b')]), row('s4', [result(4, 't1')])]);
    expect(items.map((i) => i.uuid)).toEqual(['s1', 's1:1', 's1:2']);
  });

  it('結果の来ていない道具とその後ろは出さず、waiting に残す', () => {
    const { items, waiting } = settle(buildScan([row('s1', [asst(1, 'a')]), row('s2', [call(2, 't1')]), row('s3', [asst(3, 'later')])]));
    expect(items.map((i) => i.uuid)).toEqual(['s1']);
    expect(waiting.map((w) => w.toolId)).toEqual(['t1']);
  });

  it('利用者の行が続くと、開いた道具を ok:false で閉じる', () => {
    const items = itemsOf([row('s1', [call(1, 't1')]), row('s2', [user(2, 'stop')], true)]);
    expect(items.map((i) => [i.kind, i.tool?.ok])).toEqual([['tool', false], ['user', undefined]]);
  });

  it('中断の印の行（空の user）でも isUserLine なら閉じる', () => {
    const items = itemsOf([row('s1', [call(1, 't1')]), row('s2', [user(2, '[Request interrupted by user]')], true)]);
    expect(items).toHaveLength(1);
    expect(items[0]!.tool?.ok).toBe(false);
  });

  it('位置、返答だけの間、古い分、目次が項目の並びの上で動く', () => {
    const items = itemsOf([row('s1', [user(1, 'q1')], true), row('s2', [asst(2, 'r'), call(3, 't1')]), row('s4', [result(4, 't1')]), row('s5', [user(5, 'q2')], true)]);
    expect(positionIn(items, 's2:1')).toBe(2);
    expect(positionIn(items, '')).toBe(-1);
    expect(onlyRepliesIn(items, 's1', 's2')).toBe(true);
    expect(onlyRepliesIn(items, 's1', 's2:1')).toBe(false);
    expect(olderIn(items, { before: 's5' }).items.map((i) => i.uuid)).toEqual(['s1', 's2', 's2:1']);
    expect(turnsIn(items, {})).toMatchObject({ total: 2, rows: [{ uuid: 's1', tools: 1 }, { uuid: 's5', tools: 0 }] });
  });
});
