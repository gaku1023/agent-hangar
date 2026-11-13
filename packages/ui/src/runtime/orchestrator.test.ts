import { describe, expect, it, vi } from 'vitest';
import type { AutoApprovalDto, TranscriptEvent } from '@agent-hangar/shared';
import { emptyOrchestrator, type OrchestratorSlice } from '../store/orchestrator.ts';
import { createOrchestratorRunner } from './orchestrator.ts';

const ev = (seq: number): TranscriptEvent => ({ kind: 'assistant', seq, text: `t${seq}` });
const appr = (id: string): AutoApprovalDto => ({ id, at: 1, sessionId: 's', title: 'x', tool: 'Read', input: '/a', label: 'Yes', reason: 'r', policyText: null });

function setup(over: { sessionId?: string | null; send?: (t: string) => Promise<unknown> } = {}) {
  let slice: OrchestratorSlice = emptyOrchestrator();
  const events = vi.fn(async () => ({ sessionId: 'o1', events: [ev(1), ev(2)], total: 2, nextSeq: null }));
  const approvals = vi.fn(async () => ({ approvals: [appr('a1')] }));
  const send = vi.fn(over.send ?? (async () => ({ ok: true })));
  const fail = vi.fn();
  const r = createOrchestratorRunner({ sessionId: () => (over.sessionId === undefined ? 'o1' : over.sessionId), events, approvals, send, get: () => slice, set: (s) => { slice = s; }, fail });
  return { r, events, approvals, send, fail, slice: () => slice };
}

describe('createOrchestratorRunner', () => {
  it('load は最新の頁と記録を読んで置き換える', async () => {
    const w = setup();
    await w.r.run({ op: 'load' });
    expect(w.events).toHaveBeenCalledWith('o1', { agentId: null, latest: true });
    expect(w.slice().events.map((e) => e.seq)).toEqual([1, 2]);
    expect(w.slice().approvals.map((a) => a.id)).toEqual(['a1']);
    expect(w.slice().loaded).toBe(true);
  });
  it('統括の会話が無ければ何も読まない', async () => {
    const w = setup({ sessionId: null });
    await w.r.run({ op: 'load' });
    expect(w.events).not.toHaveBeenCalled();
  });
  it('send は文を渡し、終わるまで sending を立てる', async () => {
    let release!: () => void;
    const w = setup({ send: () => new Promise((r) => { release = () => r({ ok: true }); }) });
    const p = w.r.run({ op: 'send', text: '[voice] こんにちは' });
    expect(w.slice().sending).toBe(true);
    release();
    await p;
    expect(w.send).toHaveBeenCalledWith('[voice] こんにちは');
    expect(w.slice().sending).toBe(false);
  });
  it('send が失敗したら sending を戻して失敗を知らせる', async () => {
    const w = setup({ send: async () => { throw new Error('統括が動いていません'); } });
    await w.r.run({ op: 'send', text: 'a' });
    expect(w.slice().sending).toBe(false);
    expect(w.fail).toHaveBeenCalled();
  });
});
