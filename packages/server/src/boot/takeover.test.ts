import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/write.ts';
import { upsertShared } from '../db/shared.ts';
import { recordPeers } from '../sync/peers.ts';
import { answerOf, askOf, writeAnswer, writeAsk } from '../sync/takeoverRows.ts';
import { bootTakeover } from './takeover.ts';

const UUID = '22222222-2222-4222-8222-222222222222';
const SELF = 'pc-b';

describe('引き継ぎの頼みを受ける部品の組み立て', () => {
  let db: Db;
  let sessionId: string;
  let runs: Map<string, RunDto>;
  let calls: string[];
  let applied: Set<() => void>;
  let t: ReturnType<typeof bootTakeover>;
  let sent: unknown[];

  beforeEach(() => {
    db = openDb(':memory:');
    sessionId = ensureSession(db, UUID, '/w', SELF);
    runs = new Map([['r1', { id: 'r1', sessionId, deviceId: SELF, kind: 'resume', tmuxName: 'hangar-r1', pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 } as RunDto]]);
    calls = [];
    applied = new Set();
    sent = [];
    t = bootTakeover({
      home: { db, device: { id: SELF, name: 'self' }, language: () => 'ja' },
      runs: { runs: { getRun: (id) => runs.get(id) ?? null, kill: (id, reason) => { calls.push(`kill:${id}:${reason}`); const r = { ...runs.get(id)!, endedAt: 2 } as RunDto; runs.set(id, r); return r; } } },
      sync: {
        flushSession: async () => {}, pushNow: async () => { calls.push('push'); },
        onTakeoversApplied: (cb) => { applied.add(cb); return () => { applied.delete(cb); }; },
        pullForTakeover: async () => {}, canCarryTakeover: () => true,
      },
      delivery: { hub: { broadcast: (ev) => { sent.push(ev); } } },
      againMs: 0,
    });
  });
  afterEach(() => { t.stop(); db.close(); });

  const ask = () => writeAsk(db, 'pc-a', { sessionId, runId: 'r1', targetDevice: SELF, mode: 'ask', now: 1000 });
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('start は、この PC が出したまま答えの無い ask を取り下げて送る。force、答えのある頼み、ほかの PC の頼みには触らない', async () => {
    // 待つ状態はメモリにしか無いので、再起動のあとに ask が生きていると、利用者が諦めた後で相手の claude が停止される。
    const peer = ensureSession(db, '33333333-3333-4333-8333-333333333333', '/w', 'pc-a');
    const open = writeAsk(db, SELF, { sessionId: peer, runId: 'r9', targetDevice: 'pc-a', mode: 'ask', now: Date.now() });
    const forced = writeAsk(db, SELF, { sessionId: peer, runId: 'r9', targetDevice: 'pc-a', mode: 'force', now: Date.now() });
    const answered = writeAsk(db, SELF, { sessionId: peer, runId: 'r8', targetDevice: 'pc-a', mode: 'ask', now: Date.now() });
    writeAnswer(db, 'pc-a', { askId: answered.id, runId: 'r8', result: 'stopped', answeredAt: Date.now(), transcriptSha256: null, transcriptSize: null });
    const theirs = writeAsk(db, 'pc-c', { sessionId: peer, runId: 'r9', targetDevice: 'pc-a', mode: 'ask', now: Date.now() });
    t.start();
    await settle();
    expect(askOf(db, open.id)?.cancelledAt).not.toBeNull();
    expect(askOf(db, forced.id)?.cancelledAt).toBeNull();
    expect(askOf(db, answered.id)?.cancelledAt).toBeNull();
    expect(askOf(db, theirs.id)?.cancelledAt).toBeNull();
    expect(calls).toContain('push');
  });

  it('取り下げるものが無ければ、start は送らない', async () => {
    t.start();
    await settle();
    expect(calls).not.toContain('push');
  });

  it('起動前に届いていた頼みは start の最初の scan で止める（tmux に残った claude）', async () => {
    const a = ask();
    t.start();
    await settle();
    expect(calls).toContain('kill:r1:taken_over');
    expect(answerOf(db, a.id)?.result).toBe('stopped');
  });

  it('start のあとに頼みの行が届いたら、その合図で止める。stop のあとは受けない', async () => {
    t.start();
    await settle();
    expect(applied.size).toBe(1);
    const a = ask();
    for (const cb of applied) cb();
    await settle();
    expect(answerOf(db, a.id)?.result).toBe('stopped');
    t.stop();
    expect(applied.size).toBe(0);
  });

  it('端末への 1 行は、setNotePane で渡された口へ、頼んだ PC の名前で送る', async () => {
    db.prepare("insert into devices (id, name, platform, updated_at, origin_device) values ('pc-a', 'ノート PC', 'darwin', 1, 'pc-a')").run();
    const notes: [string, string][] = [];
    t.setNotePane((n, text) => { notes.push([n, text]); });
    ask();
    await t.responder.scan();
    expect(notes).toEqual([['hangar-r1', '[hangar] ノート PC に引き継がれたため、この PC の claude を停止しました。']]);
  });

  it('頼む側の service を組み、頼みの行が届くたびに待っている会話を確かめ直し、段を hub へ配る', async () => {
    // 相手（pc-a）で動いている会話を、この PC（pc-b）が引き継ぐ。
    const peer = ensureSession(db, '33333333-3333-4333-8333-333333333333', '/w', 'pc-a');
    upsertShared(db, 'runs', { id: 'r9', session_id: peer, device_id: 'pc-a', kind: 'start', tmux_name: 'hangar-r9', pid: null, launch_params: '{}', started_at: Date.now() - 1000, ended_at: null, end_reason: null, heartbeat_at: Date.now() }, 'pc-a');
    recordPeers(db, { selfDeviceId: SELF, peers: [{ id: 'pc-a', lastSeenAt: Date.now() }], workerNow: Date.now(), localNow: Date.now() });
    t.start();
    expect(t.service.start(peer, { force: false }).stage).toBe('asking');
    await settle();
    expect(t.service.get(peer)?.stage).toBe('waiting');
    const mine = (db.prepare('select id from takeovers where from_device = ?').get(SELF) as { id: string }).id;
    writeAnswer(db, 'pc-a', { askId: mine, runId: 'r9', result: 'stopped', answeredAt: Date.now(), transcriptSha256: null, transcriptSize: null });
    for (const cb of applied) cb();
    expect(t.service.get(peer)?.stage).toBe('ready');
    expect(sent).toContainEqual({ type: 'takeover.update', takeover: expect.objectContaining({ sessionId: peer, stage: 'ready' }) });
    t.stop();
    expect(t.service.get(peer)).toBeNull();
  });
});
