import { describe, expect, it } from 'vitest';
import type { LiveAgentDto, LiveDigestDto, TranscriptEvent } from '@agent-hangar/shared';
import { bandOf, presentLivePane, type LiveInput } from './live.ts';

let seq = 0;
const call = (name: string, input: unknown, ts = 0): TranscriptEvent => ({ kind: 'tool_call', seq: seq++, ts, toolId: `t${seq}`, name, input, summary: name });
const res = (c: TranscriptEvent, isError = false): TranscriptEvent => ({ kind: 'tool_result', seq: seq++, toolId: (c as { toolId: string }).toolId, text: '', isError });
const prompt = (text: string): TranscriptEvent => ({ kind: 'user', seq: seq++, text });
const clock = (ts: number) => `t${ts}`;
const digest = (p: Partial<LiveDigestDto> = {}): LiveDigestDto => ({ sessionId: 's1', turnStartSeq: 0, intent: null, agents: [], ...p });
const agent = (p: Partial<LiveAgentDto>): LiveAgentDto => ({ agentId: 'a', title: '担当', state: 'running', startedAt: 0, lastAt: 60_000, last: null, report: null, endNote: null, linked: true, ...p });
const input = (p: Partial<LiveInput> = {}): LiveInput => ({ digest: digest(), events: [], turnFrom: 0, turnNo: 1, live: 'busy', activity: null, now: 120_000, viewingAgent: false, clock, idleFor: '3 分', ...p });

describe('状態の灯', () => {
  it('質問を待っていれば、動いている本があっても答え待ちを出す', () => {
    const p = presentLivePane(input({ live: 'waiting', activity: { tool: 'AskUserQuestion', summary: 'q', question: 'tmux の既定を変えてよいか' }, digest: digest({ agents: [agent({})] }) }));
    expect(p.lamp).toEqual({ tone: 'wait', head: 'あなたの答え待ち', sub: 'tmux の既定を変えてよいか' });
  });
  it('サブエージェントが動いていれば本数と、失敗と済みの数', () => {
    const p = presentLivePane(input({ digest: digest({ agents: [agent({ agentId: 'a' }), agent({ agentId: 'b' }), agent({ agentId: 'c', state: 'error' }), agent({ agentId: 'd', state: 'done' })] }) }));
    expect(p.lamp).toEqual({ tone: 'busy', head: '2 本動いている', sub: '失敗 1、済 1' });
  });
  it('主線だけが作業中ならターンと手の数', () => {
    seq = 0;
    const c1 = call('Read', { file_path: '/w/a.ts' });
    const p = presentLivePane(input({ events: [prompt('x'), c1, res(c1), call('Bash', { command: 'npm test', description: 'テスト' })], turnNo: 3 }));
    expect(p.lamp).toEqual({ tone: 'busy', head: '作業中', sub: 'ターン 3・2 手目' });
  });
  it('休みは最後の手からの経過', () => {
    expect(presentLivePane(input({ live: 'idle' })).lamp).toEqual({ tone: 'idle', head: '休み', sub: '3 分' });
  });
});

describe('意図', () => {
  it('今のターンの意図は引用符で出し、30 手を超えたら薄くする', () => {
    const at = 0;
    expect(presentLivePane(input({ digest: digest({ intent: { text: '答え終えた会話だけ止める', at, stepsSince: 30, inThisTurn: true } }) })).intent)
      .toEqual({ kind: 'said', text: '答え終えた会話だけ止める', meta: 'Claude いわく・t0・その後 30 手', stale: false });
    expect(presentLivePane(input({ digest: digest({ intent: { text: 'x', at, stepsSince: 31, inThisTurn: true } }) })).intent).toMatchObject({ stale: true });
  });
  it('前のターンの意図は出さず、まだ書かれていないと言う', () => {
    expect(presentLivePane(input({ digest: digest({ intent: { text: '古い', at: 0, stepsSince: 3, inThisTurn: false } }) })).intent).toEqual({ kind: 'none', text: 'このターンの意図はまだ書かれていない' });
  });
  it('一度も書かれていなければそう言う（外で起動したセッションもここに来る）', () => {
    expect(presentLivePane(input()).intent).toEqual({ kind: 'none', text: '意図は書かれていない' });
    expect(presentLivePane(input({ digest: null })).intent).toEqual({ kind: 'none', text: '意図は書かれていない' });
  });
});

describe('指揮役の手', () => {
  it('続けて読んだ手は 1 行に畳み、最後の 4 行を出し、結果の無い最後の手をいまにする', () => {
    seq = 0;
    const r1 = call('Read', { file_path: '/w/a.ts' }, 1); const r2 = call('Read', { file_path: '/w/b.ts' }, 2); const r3 = call('Bash', { command: 'cat c', description: 'c を読む' }, 3);
    const e1 = call('Edit', { file_path: '/w/a.ts' }, 4); const t1 = call('Bash', { command: 'npx vitest', description: 'テストを走らせる' }, 5);
    const w1 = call('Write', { file_path: '/w/d.md' }, 6); const t2 = call('Bash', { command: 'npx vitest', description: 'もう一度走らせる' }, 7);
    const ag = call('Agent', { description: '担当' }, 8); const mcp = call('mcp__hangar__set_turn_intent', { text: 'x' }, 9);
    const events = [prompt('x'), r1, res(r1), r2, res(r2), r3, res(r3), e1, res(e1), t1, res(t1, true), w1, res(w1), ag, res(ag), mcp, res(mcp), t2];
    const p = presentLivePane(input({ events }));
    expect(p.steps).toEqual([
      { text: 'a.ts を書き換えた', mono: false, when: 't4', mark: 'done' },
      { text: 'テストを走らせる', mono: false, when: 't5', mark: 'fail' },
      { text: 'd.md を書いた', mono: false, when: 't6', mark: 'done' },
      { text: 'もう一度走らせる', mono: false, when: 't7', mark: 'now' },
    ]);
    const all = presentLivePane(input({ events: [prompt('x'), r1, res(r1), r2, res(r2), r3, res(r3)] }));
    expect(all.steps).toEqual([{ text: '読んだ：a.ts ほか 2 件', mono: false, when: 't1', mark: 'done' }]);
  });
  it('サブエージェントの transcript を開いている間は、指揮役の手を出さない', () => {
    seq = 0;
    const c = call('Read', { file_path: '/w/a.ts' });
    expect(presentLivePane(input({ events: [prompt('x'), c], viewingAgent: true })).steps).toEqual([]);
  });
});

describe('サブエージェントのレーン', () => {
  it('失敗、動いている、済みの順に 6 本まで並べ、あふれた済みは畳む', () => {
    const agents = [
      agent({ agentId: 'd1', state: 'done', report: '済：直した' }),
      agent({ agentId: 'r1', last: { text: 'テストを走らせる', mono: false, kind: 'run', isError: false } }),
      agent({ agentId: 'tool:t9', state: 'error', linked: false }),
      ...['d2', 'd3', 'd4', 'd5', 'd6'].map((id) => agent({ agentId: id, state: 'done' })),
    ];
    const p = presentLivePane(input({ digest: digest({ agents }) }));
    expect(p.lanes.map((l) => [l.agentId, l.tone])).toEqual([['tool:t9', 'error'], ['r1', 'running'], ['d1', 'done'], ['d2', 'done'], ['d3', 'done'], ['d4', 'done']]);
    expect(p.doneFolded).toBe(2);
    expect(p.lanes[0]).toMatchObject({ selectable: false, line: '失敗した', quoted: false });
    expect(p.lanes[1]).toMatchObject({ line: 'テストを走らせる', quoted: false, elapsed: '2 分' });
    expect(p.lanes[2]).toMatchObject({ line: '済：直した', quoted: true, elapsed: '1 分' });
  });
  it('報告の無い済みの本は、終わりの知らせの status を添える', () => {
    const p = presentLivePane(input({ digest: digest({ agents: [agent({ state: 'done', endNote: 'failed' })] }) }));
    expect(p.lanes[0]).toMatchObject({ line: '終わった（failed）', quoted: false, tone: 'done' });
  });
  it('起こしたばかりで手の無い本は「始めたところ」', () => {
    expect(presentLivePane(input({ digest: digest({ agents: [agent({})] }) })).lanes[0]!.line).toBe('始めたところ');
  });
});

describe('bandOf', () => {
  it('ターンの手の種類を並べ、失敗を優先し、最新の 40 手に切る', () => {
    seq = 0;
    const a = call('Read', { file_path: '/w/a' }); const b = call('Bash', { command: 'npx vitest' }); const g = call('Bash', { command: 'git commit -m x' });
    const events = [prompt('x'), a, res(a), b, res(b, true), g, res(g)];
    expect(bandOf(events, 0, Infinity)).toEqual(['read', 'fail', 'git']);
    const many = Array.from({ length: 45 }, () => call('Read', { file_path: '/w/x' }));
    expect(bandOf(many, 0, Infinity)).toHaveLength(40);
  });
});
