import { describe, expect, it } from 'vitest';
import type { LiveAgentDto, LiveDigestDto, TranscriptEvent } from '@agent-hangar/shared';
import { bandOf, bandsOf, presentLivePane, type LiveInput } from './live.ts';

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
  it('裏だけ動いているときは、裏のものと、指揮役が空いていることを出す', () => {
    expect(presentLivePane(input({ aside: { shell: true, agents: 0 } })).lamp).toEqual({ tone: 'aside', head: '裏でシェルが動いている', sub: '指揮役は空いている' });
    expect(presentLivePane(input({ aside: { shell: false, agents: 2 }, digest: digest({ agents: [agent({ agentId: 'a' }), agent({ agentId: 'b' })] }) })).lamp).toEqual({ tone: 'aside', head: '裏で 2 本動いている', sub: '指揮役は空いている' });
    // 入力待ちは裏の印より強い。
    expect(presentLivePane(input({ live: 'waiting', aside: { shell: true, agents: 0 } })).lamp.tone).toBe('wait');
  });
  it('サブエージェントが動いていれば本数と、失敗と済みの数', () => {
    const p = presentLivePane(input({ digest: digest({ agents: [agent({ agentId: 'a' }), agent({ agentId: 'b' }), agent({ agentId: 'c', state: 'error' }), agent({ agentId: 'd', state: 'done' })] }) }));
    expect(p.lamp).toEqual({ tone: 'busy', head: '2 本動いている', sub: '失敗 1、済 1' });
  });
  it('主線だけが作業中ならターンと手の数', () => {
    seq = 0;
    const c1 = call('Read', { file_path: '/w/a.ts' });
    const m1 = call('mcp__hangar__set_turn_intent', { text: 'x' });
    const a1 = call('Agent', { description: '担当' });
    const p = presentLivePane(input({ events: [prompt('x'), c1, res(c1), m1, res(m1), a1, res(a1), call('Bash', { command: 'npm test', description: 'テスト' })], turnNo: 3 }));
    // hangar の MCP は数えず、Agent の起こしは数える。
    expect(p.lamp).toEqual({ tone: 'busy', head: '作業中', sub: 'ターン 3・3 手目' });
  });
  it('サブエージェントの transcript を開いている間は、ターンも手の数も出さない', () => {
    seq = 0;
    const c = call('Read', { file_path: '/w/a.ts' });
    expect(presentLivePane(input({ events: [prompt('x'), c], viewingAgent: true })).lamp).toEqual({ tone: 'busy', head: '作業中', sub: '' });
  });
  it('ターンの番号が信用できなければ、手の数だけを出す', () => {
    seq = 0;
    const c1 = call('Read', { file_path: '/w/a.ts' });
    const p = presentLivePane(input({ events: [prompt('x'), c1, res(c1), call('Bash', { command: 'ls' })], turnNo: null }));
    expect(p.lamp).toEqual({ tone: 'busy', head: '作業中', sub: '2 手目' });
  });
  it('質問の文が無い入力待ちは、活動の要約を出す', () => {
    const p = presentLivePane(input({ live: 'waiting', activity: { tool: 'ExitPlanMode', summary: '計画の承認', question: null } }));
    expect(p.lamp).toEqual({ tone: 'wait', head: '入力待ち', sub: '計画の承認' });
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
      { key: String(e1.seq), text: 'a.ts を書き換えた', mono: false, when: 't4', mark: 'done' },
      { key: String(t1.seq), text: 'テストを走らせる', mono: false, when: 't5', mark: 'fail' },
      { key: String(w1.seq), text: 'd.md を書いた', mono: false, when: 't6', mark: 'done' },
      { key: String(t2.seq), text: 'もう一度走らせる', mono: false, when: 't7', mark: 'now' },
    ]);
    const all = presentLivePane(input({ events: [prompt('x'), r1, res(r1), r2, res(r2), r3, res(r3)] }));
    expect(all.steps).toEqual([{ key: String(r1.seq), text: '読んだ：a.ts ほか 2 件', mono: false, when: 't1', mark: 'done' }]);
  });
  it('手の行は、その行の最初の手の seq を key に持つ（畳んだ読みの行も最初の手）', () => {
    seq = 10;
    const r1 = call('Read', { file_path: '/w/a.ts' }); const r2 = call('Read', { file_path: '/w/b.ts' }); const e1 = call('Edit', { file_path: '/w/a.ts' });
    const steps = presentLivePane(input({ events: [r1, res(r1), r2, res(r2), e1, res(e1)], turnFrom: 0 })).steps;
    expect(steps.map((s) => s.key)).toEqual([String(r1.seq), String(e1.seq)]);
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
    expect(p.lanes[0]).toMatchObject({ line: '終わった（失敗）', quoted: false, tone: 'done' });
  });
  it('知らせの status は英語の値を出さず、知っている値は日本語にし、知らない値はそのまま添える', () => {
    const line = (endNote: string) => presentLivePane(input({ digest: digest({ agents: [agent({ state: 'done', endNote })] }) })).lanes[0]!.line;
    expect(line('failed')).toBe('終わった（失敗）');
    expect(line('killed')).toBe('終わった（止められた）');
    expect(line('weird')).toBe('終わった（weird）');
  });
  it('済みの本は最後の手を使わず、報告、終わりの知らせ、「終わった」の順', () => {
    const last = { text: '最後の手', mono: false, kind: 'run' as const, isError: false };
    const lines = (p: Partial<LiveAgentDto>) => presentLivePane(input({ digest: digest({ agents: [agent({ state: 'done', last, ...p })] }) })).lanes[0]!.line;
    expect(lines({ endNote: 'failed' })).toBe('終わった（失敗）');
    expect(lines({ endNote: null })).toBe('終わった');
    expect(lines({ report: '済：直した', endNote: 'failed' })).toBe('済：直した');
  });
  it('失敗の本は報告、最後の手、「失敗した」の順', () => {
    const last = { text: '最後の手', mono: false, kind: 'run' as const, isError: true };
    const lines = (p: Partial<LiveAgentDto>) => presentLivePane(input({ digest: digest({ agents: [agent({ state: 'error', ...p })] }) })).lanes[0]!;
    expect(lines({ last, report: '落ちた' })).toMatchObject({ line: '落ちた', quoted: true });
    expect(lines({ last })).toMatchObject({ line: '最後の手', quoted: false });
    expect(lines({})).toMatchObject({ line: '失敗した', quoted: false });
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
