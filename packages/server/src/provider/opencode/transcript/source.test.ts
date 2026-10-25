import { afterEach, describe, expect, it } from 'vitest';
import type { IndexBatch, TranscriptSink } from '../../../agent/types.ts';
import { fixtureMessages, startFakeEventsServe, until, type FakeEventsServe } from '../../../../test/fake-opencode-events.ts';
import { convertMessages } from './convert.ts';
import { OpencodeTranscript } from './source.ts';

// 記録した 2.1.4 の本文（test/fixtures/opencode/2.1.4/README.md の「本文」）。
const SID = 'ses_e8eb096a3ffekAvQlPtKFewFB4';
const CWD = '/work/repo';
const ALL = [...fixtureMessages('messages.json').data].reverse();
const WHILE_FORM = [...fixtureMessages('messages-while-form.json').data].reverse();
/** 最初のターンの終わり（idle）までの数。 */
const FIRST_TURN = ALL.findIndex((m) => (m as { type?: string }).type === 'idle') + 1;

const servers: FakeEventsServe[] = [];
const sources: OpencodeTranscript[] = [];
afterEach(async () => {
  for (const s of sources.splice(0)) s.stop();
  for (const s of servers.splice(0)) await s.close();
});

type Hook = (providerSessionId: string, type: string) => void;

async function setup(o: { pageSize?: number; debounceMs?: number } = {}) {
  const serve = await startFakeEventsServe();
  servers.push(serve);
  const hooks = new Set<Hook>();
  const source = new OpencodeTranscript({
    events: (cb) => { hooks.add(cb); return () => { hooks.delete(cb); }; },
    pageSize: o.pageSize ?? 100, debounceMs: o.debounceMs ?? 0, log: () => {},
  });
  sources.push(source);
  const batches: IndexBatch[] = [];
  const sink: TranscriptSink = { batch: (b) => batches.push(b), named: () => {}, rescan: () => {}, historyChanged: () => {}, error: () => {} };
  const emit = (type: string, id = SID) => { for (const h of hooks) h(id, type); };
  const messageReads = () => serve.requests.filter((r) => r.startsWith(`/api/session/${SID}/message`)).length;
  return { serve, source, sink, batches, emit, hooks, messageReads };
}

const brief = (b: IndexBatch) => ({ agent: b.agent, providerSessionId: b.providerSessionId, agentId: b.agentId, cwd: b.cwd, reset: b.reset, records: b.records.length });

describe('記録したページ（2.1.4）と偽の serve のページ', () => {
  it('次のページの印は、そのページのいちばん古いメッセージの ID を包んだもので、最後のページの後は空の data と null の印になる', () => {
    const pages = fixtureMessages<{ query: string; body: { data: { id: string }[]; cursor: { next: string | null } } }[]>('messages-pages.json');
    expect(pages.flatMap((p) => p.body.data.map((m) => m.id))).toEqual([...ALL].reverse().map((m) => (m as { id: string }).id));
    for (const p of pages.slice(0, -1)) {
      expect(JSON.parse(Buffer.from(p.body.cursor.next!, 'base64url').toString('utf8'))).toEqual({ id: p.body.data.at(-1)!.id, order: 'desc', direction: 'next' });
    }
    expect(pages.at(-1)!.body).toEqual({ data: [], cursor: { previous: null, next: null } });
  });
});

describe('OpencodeTranscript', () => {
  it('会話を載せると、本文を新しい方から全部読み、作り直しの束として渡す', async () => {
    const { serve, source, sink, batches } = await setup();
    serve.state.messages.set(SID, ALL);
    source.start(sink);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => batches.length === 1);
    expect(brief(batches[0]!)).toEqual({ agent: 'opencode', providerSessionId: SID, agentId: null, cwd: CWD, reset: true, records: ALL.length });
    expect(batches[0]!.records).toEqual(convertMessages(ALL));
    expect(batches[0]!.records.every((r) => r.locator.kind === 'stored')).toBe(true);
  });

  it('二度読んでも、写した所から先が無ければ束を渡さない', async () => {
    const { serve, source, sink, batches } = await setup();
    serve.state.messages.set(SID, ALL);
    source.start(sink);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => batches.length === 1);
    await source.sync(SID);
    await source.sync(SID);
    expect(batches).toHaveLength(1);
  });

  it('伸びた分だけを、続きの束（seq は束の中で 0 から）として渡す', async () => {
    const { serve, source, sink, batches } = await setup();
    serve.state.messages.set(SID, ALL.slice(0, FIRST_TURN));
    source.start(sink);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => batches.length === 1);
    expect(batches[0]!.records).toHaveLength(FIRST_TURN);
    serve.state.messages.set(SID, ALL);
    await source.sync(SID);
    expect(batches).toHaveLength(2);
    expect(brief(batches[1]!)).toMatchObject({ reset: false, records: ALL.length - FIRST_TURN });
    expect(batches[1]!.records).toEqual(convertMessages(ALL.slice(FIRST_TURN)));
  });

  it('まだ終わっていない返答は写さず、終わってから続きとして写す', async () => {
    const { serve, source, sink, batches } = await setup();
    serve.state.messages.set(SID, WHILE_FORM);
    source.start(sink);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => batches.length === 1);
    expect(batches[0]!.records).toHaveLength(WHILE_FORM.length - 1);
    await source.sync(SID);
    expect(batches).toHaveLength(1);
    serve.state.messages.set(SID, ALL);
    await source.sync(SID);
    expect(batches).toHaveLength(2);
    expect(batches[1]!.reset).toBe(false);
    expect(batches[1]!.records).toEqual(convertMessages(ALL.slice(WHILE_FORM.length - 1)));
  });

  it('写した最後のメッセージが消えていたら（巻き戻し）、全部を読み直して作り直しの束にする', async () => {
    const { serve, source, sink, batches } = await setup();
    serve.state.messages.set(SID, ALL);
    source.start(sink);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => batches.length === 1);
    serve.state.messages.set(SID, ALL.slice(0, FIRST_TURN));
    await source.sync(SID);
    expect(batches).toHaveLength(2);
    expect(brief(batches[1]!)).toMatchObject({ reset: true, records: FIRST_TURN });
  });

  it('ページを送って読み、写した所に着いたらそれより古いページは読まない', async () => {
    const { serve, source, sink, batches, messageReads } = await setup({ pageSize: 4 });
    serve.state.messages.set(SID, ALL.slice(0, ALL.length - 1));
    source.start(sink);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => batches.length === 1);
    expect(batches[0]!.records).toHaveLength(ALL.length - 1);
    const before = messageReads();
    serve.state.messages.set(SID, ALL);
    await source.sync(SID);
    expect(messageReads() - before).toBe(1);
    expect(batches[1]!.records).toHaveLength(1);
  });

  it('本文の出来事（手順の終わり、文の終わり、使用量、作業の終わり、モデルの切り替え、つないだとき）で読み直し、ほかの出来事では読まない', async () => {
    const { serve, source, sink, batches, emit, messageReads } = await setup();
    serve.state.messages.set(SID, ALL.slice(0, FIRST_TURN));
    source.start(sink);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => batches.length === 1);
    const before = messageReads();
    emit('session.text.delta');
    emit('session.tool.input.started');
    emit('permission.asked');
    await new Promise((r) => setTimeout(r, 30));
    expect(messageReads()).toBe(before);
    for (const type of ['session.step.ended', 'session.text.ended', 'session.usage.updated', 'session.execution.succeeded', 'session.execution.interrupted', 'session.inbox.delivered', 'session.model.selected', 'server.connected']) {
      const n = messageReads();
      emit(type);
      await until(() => messageReads() > n);
    }
    serve.state.messages.set(SID, ALL);
    emit('session.step.ended');
    await until(() => batches.length === 2);
    expect(batches[1]!.reset).toBe(false);
  });

  it('続けて届いた出来事は、間をおいて 1 回の読み直しにまとめる', async () => {
    const { serve, source, sink, batches, emit, messageReads } = await setup({ debounceMs: 40 });
    serve.state.messages.set(SID, ALL);
    source.start(sink);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => batches.length === 1);
    const before = messageReads();
    emit('session.step.ended');
    emit('session.usage.updated');
    emit('session.text.ended');
    await new Promise((r) => setTimeout(r, 120));
    expect(messageReads() - before).toBe(1);
  });

  it('載せていない会話の出来事と、外した会話の出来事では読まない', async () => {
    const { serve, source, sink, batches, emit, messageReads } = await setup();
    serve.state.messages.set(SID, ALL);
    source.start(sink);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => batches.length === 1);
    const before = messageReads();
    emit('session.step.ended', 'ses_other');
    source.untrack(SID);
    emit('session.step.ended');
    await new Promise((r) => setTimeout(r, 30));
    expect(messageReads()).toBe(before);
  });

  it('始める前に載せた会話は、始めたときに読む。止めた後は読まない', async () => {
    const { serve, source, sink, batches, emit, messageReads } = await setup();
    serve.state.messages.set(SID, ALL);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await new Promise((r) => setTimeout(r, 20));
    expect(messageReads()).toBe(0);
    source.start(sink);
    await until(() => batches.length === 1);
    source.stop();
    const n = messageReads();
    emit('session.step.ended');
    await new Promise((r) => setTimeout(r, 20));
    expect(messageReads()).toBe(n);
  });

  it('読めなかったら束を渡さず、次の読み直しで最初から読む', async () => {
    const { serve, source, sink, batches } = await setup();
    source.start(sink);
    source.track({ providerSessionId: SID, cwd: CWD, serve: { ...serve, password: 'wrong' } });
    await source.sync(SID);
    expect(batches).toEqual([]);
    serve.state.messages.set(SID, ALL);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => batches.length === 1);
    expect(batches[0]!.reset).toBe(true);
  });

  it('いまの手（最後の道具）を畳む口を束に持たせる。使用制限は持たない', async () => {
    const { serve, source, sink, batches } = await setup();
    serve.state.messages.set(SID, ALL);
    source.start(sink);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => batches.length === 1);
    const fold = batches[0]!.fold!;
    expect(fold.activity(null).next).toMatchObject({ tool: 'Bash', summary: 'Bash sleep 20', toolId: 'call_shell_10', question: null });
    expect(fold.limit(null)).toBeNull();
  });
});
