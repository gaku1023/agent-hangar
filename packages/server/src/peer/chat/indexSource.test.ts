import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentKind, TranscriptEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../../db/open.ts';
import { ensureSession } from '../../indexer/write.ts';
import { ChatView } from './hostView.ts';
import type { HostSession } from './hostTypes.ts';
import { createTailCache, transcriptOlder, transcriptTail, transcriptTurns, type TailDeps } from './tail.ts';
import { claudeTailSource, indexTailSource, routedTailSource } from './tailSource.ts';

let db: Db;
let sid: string;
let n = 0;

const user = (seq: number, text: string): TranscriptEvent => ({ kind: 'user', seq, ts: seq, text });
const asst = (seq: number, text: string): TranscriptEvent => ({ kind: 'assistant', seq, ts: seq, text });
const think = (seq: number, text: string): TranscriptEvent => ({ kind: 'thinking', seq, ts: seq, text });
const call = (seq: number, toolId: string): TranscriptEvent => ({ kind: 'tool_call', seq, ts: seq, toolId, name: 'exec_command', input: { cmd: 'ls' }, summary: 'ls' });
const result = (seq: number, toolId: string, isError = false): TranscriptEvent => ({ kind: 'tool_result', seq, ts: seq, toolId, text: 'out', isError });

/** opencode の会話と同じ置き方（event_index の主線の行と、本文の agent_events）で書く。 */
function put(sessionId: string, events: TranscriptEvent[]): void {
  for (const e of events) {
    db.prepare("insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref) values (?,?,?,?,0,0,'')").run(sessionId, e.seq, e.kind, e.ts ?? null);
    db.prepare("insert into agent_events (session_id, agent_key, seq, body) values (?,'',?,?)").run(sessionId, e.seq, JSON.stringify(e));
  }
}
const deps = (): TailDeps => ({ source: indexTailSource(db), cache: createTailCache(), pendingAsk: () => null });
const mk = (provider: AgentKind = 'opencode'): string => ensureSession(db, `p-${(n += 1)}`, '/w', 'pc-a', provider);

beforeEach(() => { db = openDb(':memory:'); sid = mk(); });
afterEach(() => { db.close(); });

describe('indexTailSource', () => {
  it('user、assistant、thinking、tool を項目にし、id は s<seq>', () => {
    put(sid, [user(0, 'q'), think(1, 'hmm'), asst(2, 'a'), call(3, 't1'), result(4, 't1')]);
    const r = transcriptTail(sid, null, undefined, deps());
    expect(r.items.map((i) => [i.uuid, i.kind])).toEqual([['s0', 'user'], ['s1', 'thinking'], ['s2', 'assistant'], ['s3', 'tool']]);
    expect(r.items[3]!.tool?.ok).toBe(true);
    expect(r.cursor).toBe('s3');
  });

  it('結果が来るまで道具は出ない。利用者の行が続くと中断（ok: false）で出る', () => {
    put(sid, [user(0, 'q'), call(1, 't1')]);
    expect(transcriptTail(sid, null, undefined, deps()).items.map((i) => i.uuid)).toEqual(['s0']);
    put(sid, [user(2, 'stop')]);
    const items = transcriptTail(sid, null, undefined, deps()).items;
    expect(items.map((i) => [i.uuid, i.tool?.ok])).toEqual([['s0', undefined], ['s1', false], ['s2', undefined]]);
  });

  it('after に s<seq> を渡すと続きだけを返す。見つからない after は末尾から truncated', () => {
    put(sid, [user(0, 'q'), asst(1, 'a'), user(2, 'q2'), asst(3, 'b')]);
    const d = deps();
    const next = transcriptTail(sid, 's1', undefined, d);
    expect(next.items.map((i) => i.uuid)).toEqual(['s2', 's3']);
    expect(next.truncated).toBe(false);
    const lost = transcriptTail(sid, 's99', 2, d);
    expect(lost.truncated).toBe(true);
    expect(lost.items.map((i) => i.uuid)).toEqual(['s2', 's3']);
  });

  it('older と turns が動く', () => {
    put(sid, [user(0, 'q1'), asst(1, 'a'), user(2, 'q2'), asst(3, 'b')]);
    const d = deps();
    expect(transcriptOlder(sid, { before: 's2' }, d).items.map((i) => i.uuid)).toEqual(['s0', 's1']);
    expect(transcriptTurns(sid, {}, d)).toMatchObject({ total: 2, rows: [{ uuid: 's0' }, { uuid: 's2' }] });
  });

  it('鍵は主線の max(seq) と件数。会話が無ければ null。サブエージェントの行は数えない', () => {
    const src = indexTailSource(db);
    expect(src.key(sid)).toBeNull();
    put(sid, [user(0, 'q')]);
    const k1 = src.key(sid);
    put(sid, [asst(1, 'a')]);
    expect(src.key(sid)).not.toBe(k1);
    const k2 = src.key(sid);
    db.prepare("insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref, parent_agent) values (?,?,?,?,0,0,'','ag')").run(sid, 0, 'user', 1);
    expect(src.key(sid)).toBe(k2);
  });

  it('大きな会話は末尾の上限だけを読み、手前の項目は after から届かない（truncated）', () => {
    const events: TranscriptEvent[] = [];
    for (let i = 0; i < 30; i += 1) events.push(i % 2 === 0 ? user(i, `q${i}`) : asst(i, `a${i}`));
    put(sid, events);
    const d: TailDeps = { source: indexTailSource(db, { maxEvents: 10 }), pendingAsk: () => null };
    const r = transcriptTail(sid, null, 100, d);
    expect(r.items.map((i) => i.uuid)).toEqual(Array.from({ length: 10 }, (_, k) => `s${20 + k}`));
    expect(transcriptTail(sid, 's3', 100, d).truncated).toBe(true);
  });

  it('seq が飛んでいても末尾の窓の頭を正しく決める', () => {
    put(sid, [user(0, 'a'), asst(5, 'b'), user(10, 'c'), asst(20, 'd')]);
    const d: TailDeps = { source: indexTailSource(db, { maxEvents: 2 }), pendingAsk: () => null };
    expect(transcriptTail(sid, null, 100, d).items.map((i) => i.uuid)).toEqual(['s10', 's20']);
  });
});

describe('routedTailSource', () => {
  it('claude-code は Claude の読み口、それ以外は索引', () => {
    const claude = claudeTailSource(() => ({ key: 'k', read: () => Buffer.from('') }));
    const routed = routedTailSource(db, claude, indexTailSource(db));
    const cc = mk('claude-code');
    expect(routed.key(sid)).toBeNull();
    put(sid, [user(0, 'q')]);
    expect(routed.key(sid)).not.toBeNull();
    expect(routed.key(cc)).toBe('k');
  });
});

describe('poke で待っている tail が返る', () => {
  it('索引に書いて poke すると、待ちが時計の経過なしで返る', async () => {
    put(sid, [user(0, 'q')]);
    const sleeps: (() => void)[] = [];
    let t = 0;
    const view = new ChatView({
      now: () => t, sleep: () => new Promise<void>((res) => { sleeps.push(res); }), recheckMs: 1000,
      session: (): HostSession => ({ provider: 'opencode', live: 'busy', aside: false, waitingFor: null, permission: null, activity: null, cwd: '/w', lock: false, newerElsewhere: false, remoteOnly: false, takenOver: false }),
      run: () => null, pane: () => null,
      tail: { source: indexTailSource(db), cache: createTailCache() },
      queued: () => [], self: () => ({ deviceId: 'pc-a', deviceName: 'A' }), hostId: 'h',
    });
    expect((await view.tail(sid, 'pc-b', null, 0)).items.map((i) => i.uuid)).toEqual(['s0']);
    const waiting = view.tail(sid, 'pc-b', 's0', 20_000);
    let done = false;
    void waiting.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    put(sid, [asst(1, 'a')]);
    t += 500;
    view.poke(sid);
    const st = await waiting;
    expect(st.items.map((i) => i.uuid)).toEqual(['s1']);
  });
});
