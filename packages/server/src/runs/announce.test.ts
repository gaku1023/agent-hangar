import type { RunDto, ServerEvent, TabDto } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { Publisher } from '../events/publisher.ts';
import { ensureSession } from '../indexer/write.ts';
import { runAnnouncer, sessionRunsAnywhere } from './announce.ts';
import { PEERS_FRESH_MS, recordPeers } from '../sync/peers.ts';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('run の出来事を画面へ配る', () => {
  let db: Db;
  let s1: string;
  let sent: ServerEvent[];
  let publisher: Publisher;
  beforeEach(() => {
    db = openDb(':memory:');
    s1 = ensureSession(db, UUID, '/w', 'd');
    sent = [];
    publisher = new Publisher({ db, deviceId: 'd', live: () => [], hub: { broadcast: (ev) => { sent.push(ev); } } });
    publisher.flush();
    sent.length = 0;
  });
  afterEach(() => { publisher.stop(); db.close(); });
  const run = (): RunDto => ({ id: 'r1', sessionId: s1, deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 });
  const tab = (): TabDto => ({ id: 'r1', runId: 'r1', sessionId: s1, kind: 'agent', title: 'Claude', tmuxName: 'hangar-r1', createdAt: 1, closedAt: null });

  it('run が付いたセッションは、run.started の後に行ごと配り直す', () => {
    const l = runAnnouncer({ db, hub: publisher, onEnded: () => {} });
    l.runStarted({ run: run(), sessionId: s1, tabs: [tab()] });
    publisher.flush();
    expect(sent.map((e) => e.type)).toEqual(['run.started', 'session.upsert']);
    expect(sent[0]).toMatchObject({ run: { id: 'r1' }, tabs: [{ id: 'r1' }] });
  });

  it('run の更新とタブの変化は、そのまま配る', () => {
    const l = runAnnouncer({ db, hub: publisher, onEnded: () => {} });
    l.runUpdated(run());
    l.tabChanged(tab());
    publisher.flush();
    expect(sent.map((e) => e.type)).toEqual(['run.upsert', 'tab.upsert']);
  });

  it('run が終わったら配り、事後要約の契機を渡す', () => {
    const ended: string[] = [];
    const l = runAnnouncer({ db, hub: publisher, onEnded: (r) => { ended.push(r.sessionId); } });
    l.runEnded({ ...run(), endedAt: 9, endReason: 'exited' });
    publisher.flush();
    expect(sent.map((e) => e.type)).toEqual(['run.ended']);
    expect(ended).toEqual([s1]);
  });

  it('lost で終わった run は、中断の印が変わるのでセッションも配り直す', () => {
    const l = runAnnouncer({ db, hub: publisher, onEnded: () => {} });
    l.runEnded({ ...run(), endedAt: 9, endReason: 'lost' });
    publisher.flush();
    expect(sent.map((e) => e.type)).toEqual(['run.ended', 'session.upsert']);
  });

  it('中断の群が変わったら、群ごと配る', () => {
    const l = runAnnouncer({ db, hub: publisher, onEnded: () => {} });
    l.interrupted({ at: 5, cause: 'mux', items: [] });
    l.interrupted(null);
    publisher.flush();
    expect(sent).toEqual([{ type: 'interrupted.update', interrupted: { at: 5, cause: 'mux', items: [] } }, { type: 'interrupted.update', interrupted: null }]);
  });
});

describe('セッションがいま動いているか', () => {
  let db: Db;
  let s1: string;
  beforeEach(() => {
    db = openDb(':memory:');
    s1 = ensureSession(db, UUID, '/w', 'd');
  });
  afterEach(() => { db.close(); });

  it('hangar の run が生きていれば動いている', () => {
    upsertShared(db, 'runs', { id: 'r1', session_id: s1, device_id: 'd', kind: 'start', tmux_name: 't', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, 'd');
    expect(sessionRunsAnywhere({ db, deviceId: 'd', live: () => [] }, s1)).toBe(true);
  });

  it('他の PC の run は、その PC が古ければ動いていると見なさない', () => {
    upsertShared(db, 'runs', { id: 'r1', session_id: s1, device_id: 'other', kind: 'start', tmux_name: 't', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, 'other');
    const t = 1_000_000;
    const runs = () => sessionRunsAnywhere({ db, deviceId: 'd', live: () => [], now: () => t }, s1);
    // peers を受け取ったばかりで、その PC が居なければ古い。
    recordPeers(db, { selfDeviceId: 'd', peers: [], workerNow: 1_000, localNow: t });
    expect(runs()).toBe(false);
    recordPeers(db, { selfDeviceId: 'd', peers: [{ id: 'other', lastSeenAt: 500 }], workerNow: 1_000, localNow: t });
    expect(runs()).toBe(true);
  });

  it('peers を受け取っていないか覚えが古ければ、他の PC の生死は分からないので動いているとみなす', () => {
    upsertShared(db, 'runs', { id: 'r1', session_id: s1, device_id: 'other', kind: 'start', tmux_name: 't', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, 'other');
    const t = 1_000_000;
    const runs = () => sessionRunsAnywhere({ db, deviceId: 'd', live: () => [], now: () => t }, s1);
    expect(runs()).toBe(true);
    recordPeers(db, { selfDeviceId: 'd', peers: [], workerNow: 1_000, localNow: t - PEERS_FRESH_MS - 1 });
    expect(runs()).toBe(true);
  });

  it('hangar の外で動いている Claude も動いていると見なす', () => {
    expect(sessionRunsAnywhere({ db, deviceId: 'd', live: () => [] }, s1)).toBe(false);
    expect(sessionRunsAnywhere({ db, deviceId: 'd', live: () => [{ sessionId: UUID }] }, s1)).toBe(true);
    expect(sessionRunsAnywhere({ db, deviceId: 'd', live: () => [{ sessionId: 'other' }] }, s1)).toBe(false);
  });

  it('行の無いセッションは動いていない', () => {
    expect(sessionRunsAnywhere({ db, deviceId: 'd', live: () => [{ sessionId: UUID }] }, 'nope')).toBe(false);
  });
});
