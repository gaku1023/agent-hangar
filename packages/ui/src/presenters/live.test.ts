import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@agent-hangar/shared';
import { bandOf, bandsOf } from './live.ts';

let seq = 0;
const call = (name: string, input: unknown, ts = 0): TranscriptEvent => ({ kind: 'tool_call', seq: seq++, ts, toolId: `t${seq}`, name, input, summary: name });
const res = (c: TranscriptEvent, isError = false): TranscriptEvent => ({ kind: 'tool_result', seq: seq++, toolId: (c as { toolId: string }).toolId, text: '', isError });
const prompt = (text: string): TranscriptEvent => ({ kind: 'user', seq: seq++, text });

describe('bandOf', () => {
  it('ターンの手の種類を並べ、失敗を優先し、最新の 40 手に切る', () => {
    seq = 0;
    const a = call('Read', { file_path: '/w/a' }); const b = call('Bash', { command: 'npx vitest' }); const g = call('Bash', { command: 'git commit -m x' });
    const events = [prompt('x'), a, res(a), b, res(b, true), g, res(g)];
    expect(bandOf(events, 0, Infinity)).toEqual(['read', 'fail', 'git']);
    const many = Array.from({ length: 45 }, () => call('Read', { file_path: '/w/x' }));
    expect(bandOf(many, 0, Infinity)).toHaveLength(40);
  });
  it('bandsOf は、数ターンを 1 度の走査で求めても、ターンごとの bandOf と同じ', () => {
    seq = 0;
    const p1 = prompt('1'); const a = call('Read', { file_path: '/w/a' }); const ra = res(a);
    const p2 = prompt('2'); const b = call('Bash', { command: 'npx vitest' }); const rb = res(b, true);
    const p3 = prompt('3'); const g = call('Bash', { command: 'git commit -m x' }); const rg = res(g);
    const events = [p1, a, ra, p2, b, rb, p3, g, rg, ...Array.from({ length: 45 }, () => call('Read', { file_path: '/w/x' }))];
    const turns = [{ from: p1.seq, to: p2.seq }, { from: p2.seq, to: p3.seq }, { from: p3.seq, to: Infinity }];
    const batch = bandsOf(events, turns);
    expect(batch).toEqual(turns.map((t) => bandOf(events, t.from, t.to)));
    expect(batch.slice(0, 2)).toEqual([['read'], ['fail']]);
    expect(batch[2]).toHaveLength(40);
  });
});
