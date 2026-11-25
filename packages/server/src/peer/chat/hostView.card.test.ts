import { describe, expect, it } from 'vitest';
import { parsePeerChatReply, PEER_CHAT_CARD_MAX_BYTES, type LiveDigestDto, type TranscriptEvent } from '@agent-hangar/shared';
import { ChatView, STATE_JSON_MAX, type ViewDeps } from './hostView.ts';
import type { HostSession } from './hostTypes.ts';

const session = (over: Partial<HostSession> = {}): HostSession => ({ provider: 'claude-code', live: 'busy', aside: false, waitingFor: null, permission: null, activity: null, cwd: '/p', lock: false, newerElsewhere: false, remoteOnly: false, takenOver: false, ...over });
const digest = (over: Partial<LiveDigestDto> = {}): LiveDigestDto => ({ sessionId: 's1', turnStartSeq: 10, intent: { text: '意図', at: 1, stepsSince: 0, inThisTurn: true }, agents: [], ...over });
const call = (seq: number, name = 'Read', input: unknown = { file_path: `/a/f${seq}.ts` }): TranscriptEvent => ({ kind: 'tool_call', seq, toolId: `t${seq}`, name, input, summary: '' });
const result = (seq: number, id: number, isError = false): TranscriptEvent => ({ kind: 'tool_result', seq, toolId: `t${id}`, text: 'x'.repeat(5000), isError });

function view(over: Partial<ViewDeps> & { s?: HostSession | null } = {}): ChatView {
  const { s, ...rest } = over;
  const sess = s === undefined ? session() : s;
  let clock = 1000;
  return new ChatView({
    now: () => clock, sleep: async (ms) => { clock += ms; }, recheckMs: 1000,
    session: () => sess, run: () => (sess && sess.live !== null ? { tmuxName: 'x' } : null), pane: () => null,
    tail: { readTranscript: () => null }, queued: () => [], self: () => ({ deviceId: 'a', deviceName: 'A' }), hostId: 'h',
    ...rest,
  });
}

describe('ChatView の現在の札の材料', () => {
  it('digest の口が無ければ札を付けない（古い構成）。status は busy のまま', () => {
    const r = view().build('s1', 'pc-b', null);
    expect(r.state.card).toBeUndefined();
    expect(r.state.status).toBe('busy');
  });

  it('材料を付ける。呼び出しは引数の短い形の欄だけに縮め、答えの本文は持たない。頭の発言は付く', () => {
    const events: TranscriptEvent[] = [
      { kind: 'user', seq: 10, ts: 5, text: '直して' }, call(11, 'Bash', { command: 'ls -la\necho hi', description: 'list', secret: 'z' }), result(12, 11), call(13),
    ];
    const v = view({ digest: () => digest(), turnEvents: () => ({ events, dropped: 4 }), artifactCount: () => 2, liveHints: () => false });
    const c = v.build('s1', 'pc-b', null).state.card!;
    expect(c).toMatchObject({ turnFrom: 10, artifacts: 2, hints: false, aside: null, droppedCalls: 4 });
    expect(c.events.map((e) => e.kind)).toEqual(['user', 'tool_call', 'tool_result', 'tool_call']);
    expect(c.events[1]).toMatchObject({ input: { command: 'ls -la', description: 'list' } });
    expect(JSON.stringify(c)).not.toContain('xxxx');
    expect(JSON.stringify(c)).not.toContain('secret');
  });

  it('手は直近 30 回までで、落とした分は droppedCalls に足す', () => {
    const events: TranscriptEvent[] = [{ kind: 'user', seq: 10, text: 'a' }];
    for (let i = 0; i < 40; i++) events.push(call(11 + i * 2), result(12 + i * 2, 11 + i * 2));
    const c = view({ digest: () => digest(), turnEvents: () => ({ events, dropped: 5 }) }).build('s1', 'pc-b', null).state.card!;
    expect(c.events.filter((e) => e.kind === 'tool_call')).toHaveLength(30);
    expect(c.droppedCalls).toBe(15);
  });

  it('裏だけ（登録の aside）のとき、status は busy のまま、札の aside に裏の中身を載せる', () => {
    const v = view({ s: session({ aside: true, liveAside: { shell: true, agents: 2 } }), digest: () => digest() });
    const st = v.build('s1', 'pc-b', null).state;
    expect(st.status).toBe('busy');
    expect(st.card!.aside).toEqual({ shell: true, agents: 2 });
    // 作業中でないときは aside を載せない。
    const idle = view({ s: session({ live: 'idle', aside: true }), digest: () => digest() }).build('s1', 'pc-b', null).state;
    expect(idle.card!.aside).toBeNull();
  });

  it('止まっている会話には札を付けない', () => {
    expect(view({ s: session({ live: null }), digest: () => digest() }).build('s1', 'pc-b', null).state.card).toBeUndefined();
  });

  it('サブエージェントの行は終わった本も残り、大きな文は刈られる。札は自前の上限に収まり、収めきれなければ付けない', () => {
    const agent = (n: number, state: 'running' | 'done') => ({ agentId: `a${n}`, title: 't'.repeat(500), state, startedAt: 1, lastAt: 2, last: { text: 'l'.repeat(5000), mono: false, kind: 'read' as const, isError: false }, report: state === 'done' ? 'r'.repeat(20000) : null, endNote: null, linked: true });
    const many = Array.from({ length: 14 }, (_, i) => agent(i, i % 2 ? 'done' : 'running'));
    const c = view({ digest: () => digest({ agents: many }) }).build('s1', 'pc-b', null).state.card!;
    expect(JSON.stringify(c).length).toBeLessThanOrEqual(PEER_CHAT_CARD_MAX_BYTES);
    expect(c.digest.agents.some((a) => a.state === 'done')).toBe(true);
    const huge = view({ digest: () => digest({ intent: { text: 'i'.repeat(100), at: 1, stepsSince: 0, inThisTurn: true }, agents: Array.from({ length: 3 }, (_, i) => ({ ...agent(i, 'done'), agentId: 'a'.repeat(20000) })) }) });
    expect(huge.build('s1', 'pc-b', null).state.card).toBeUndefined();
  });

  it('札の材料が大きくても、状態全体は STATE_JSON_MAX に収まり、答えの形検査も通る', () => {
    const agent = (n: number) => ({ agentId: `a${n}`, title: 't', state: 'done' as const, startedAt: 1, lastAt: 2, last: null, report: 'r'.repeat(20000), endNote: null, linked: true });
    const v = view({ digest: () => digest({ agents: Array.from({ length: 30 }, (_, i) => agent(i)) }) });
    const st = v.build('s1', 'pc-b', null).state;
    expect(Buffer.byteLength(JSON.stringify(st))).toBeLessThanOrEqual(STATE_JSON_MAX);
    expect(parsePeerChatReply({ ok: true, state: st })).toMatchObject({ ok: true, state: { card: { artifacts: 0 } } });
  });

  it('札の材料が変わると sig が変わり、長いポーリングがすぐ返る（本文が変わらなくても）', async () => {
    let n = 0;
    const v = view({ digest: () => digest({ agents: n === 0 ? [] : [{ agentId: 'a', title: 't', state: 'running', startedAt: 1, lastAt: null, last: null, report: null, endNote: null, linked: true }] }) });
    const first = await v.tail('s1', 'pc-b', null, 0);
    expect(first.card!.digest.agents).toHaveLength(0);
    n = 1;
    const second = await v.tail('s1', 'pc-b', first.cursor, 5000);
    expect(second.card!.digest.agents).toHaveLength(1);
  });

  it('aside に入るだけでも sig が変わる（status は busy のまま）', async () => {
    let s = session();
    let clock = 1000;
    const v = new ChatView({
      now: () => clock, sleep: async (ms) => { clock += ms; }, recheckMs: 1000,
      session: () => s, run: () => ({ tmuxName: 'x' }), pane: () => null, digest: () => digest(),
      tail: { readTranscript: () => null }, queued: () => [], self: () => ({ deviceId: 'a', deviceName: 'A' }), hostId: 'h',
    });
    const first = await v.tail('s1', 'pc-b', null, 0);
    s = session({ aside: true, liveAside: { shell: false, agents: 1 } });
    const second = await v.tail('s1', 'pc-b', first.cursor, 5000);
    expect(second.status).toBe('busy');
    expect(second.card!.aside).toEqual({ shell: false, agents: 1 });
  });
});
