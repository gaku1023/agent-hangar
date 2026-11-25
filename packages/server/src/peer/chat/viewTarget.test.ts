import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceStatus } from '@agent-hangar/shared';
import { openDb, type Db } from '../../db/open.ts';
import { upsertShared } from '../../db/shared.ts';
import { ensureSession } from '../../indexer/write.ts';
import { localCursorOf, resolveViewTarget } from './viewTarget.ts';

const ME = 'pc-a';
const PEER = 'pc-b';
const THIRD = 'pc-c';
const NOW = 10_000_000;
const status: DeviceStatus = { accounts: [], agents: ['claude-code'], lan_ips: [], ssh_host_key: null, hangar_version: '1.2.3' };

let db: Db;
let sid: string;
let dir: string;

const run = (id: string, device: string, startedAt: number, ended: boolean) =>
  upsertShared(db, 'runs', { id, session_id: sid, device_id: device, kind: 'start', tmux_name: `t-${id}`, pid: null, launch_params: '{}', started_at: startedAt, ended_at: ended ? startedAt + 1 : null, end_reason: ended ? 'exited' : null, heartbeat_at: NOW }, device);
const file = (p: string, device: string | null, mtime = 1) =>
  db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version, device_id, agent) values (?,?,null,1,?,1,1,?,?)').run(p, sid, mtime, device, 'claude-code');

beforeEach(() => {
  db = openDb(':memory:');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewtarget-'));
  upsertShared(db, 'devices', { id: ME, name: 'Win', platform: 'win32', last_seen_at: NOW }, ME);
  upsertShared(db, 'devices', { id: PEER, name: 'Mac', platform: 'darwin', last_seen_at: NOW, status: JSON.stringify(status) }, PEER);
  upsertShared(db, 'devices', { id: THIRD, name: 'Old', platform: 'linux', last_seen_at: NOW }, THIRD);
  sid = ensureSession(db, 'u1', '/w', PEER);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('resolveViewTarget', () => {
  it('ほかの PC で動いている会話は、その PC を相手にする。版と名前を様子の欄から引く', () => {
    run('r1', PEER, 1_000, false);
    expect(resolveViewTarget(db, ME, sid, NOW)).toEqual({ ok: true, target: { deviceId: PEER, deviceName: 'Mac', hangarVersion: '1.2.3', outdated: false } });
  });

  it('この PC で動いている会話は not-remote', () => {
    run('r1', ME, 1_000, false);
    expect(resolveViewTarget(db, ME, sid, NOW)).toEqual({ ok: false, reason: 'not-remote' });
  });

  it('動いていなければ、最後の run の PC を相手にする。最後がこの PC なら not-remote', () => {
    run('r1', PEER, 1_000, true);
    expect(resolveViewTarget(db, ME, sid, NOW)).toMatchObject({ ok: true, target: { deviceId: PEER } });
    run('r2', ME, 2_000, true);
    expect(resolveViewTarget(db, ME, sid, NOW)).toEqual({ ok: false, reason: 'not-remote' });
  });

  it('run が無くても、ほかの PC から降ろした本文の写しがあれば、その PC を相手にする。自分の本文だけなら not-remote', () => {
    expect(resolveViewTarget(db, ME, sid, NOW)).toEqual({ ok: false, reason: 'not-remote' });
    file('/own.jsonl', null);
    expect(resolveViewTarget(db, ME, sid, NOW)).toEqual({ ok: false, reason: 'not-remote' });
    file('/copy.jsonl', PEER, 5);
    expect(resolveViewTarget(db, ME, sid, NOW)).toMatchObject({ ok: true, target: { deviceId: PEER } });
  });

  it('様子の欄が無い PC は outdated、名簿に無い PC は device-unknown', () => {
    run('r1', THIRD, 1_000, false);
    expect(resolveViewTarget(db, ME, sid, NOW)).toEqual({ ok: true, target: { deviceId: THIRD, deviceName: 'Old', hangarVersion: null, outdated: true } });
    run('r2', 'pc-gone', 2_000, false);
    expect(resolveViewTarget(db, ME, sid, NOW)).toEqual({ ok: false, reason: 'device-unknown' });
  });

  it('無い会話は session-unknown、host が受けない provider は not-claude', () => {
    const odd = ensureSession(db, 'x1', '/w', PEER, 'gemini' as never);
    expect(resolveViewTarget(db, ME, odd, NOW)).toEqual({ ok: false, reason: 'not-claude' });
    expect(resolveViewTarget(db, ME, 'nope', NOW)).toEqual({ ok: false, reason: 'session-unknown' });
  });

  it.each(['codex', 'opencode'] as const)('%s の会話は、相手が peer_chat_agents にその provider を載せているときだけ peer chat に入る。欄が無い古い相手は not-remote', (provider) => {
    const other = ensureSession(db, `x-${provider}`, '/w', PEER, provider);
    upsertShared(db, 'runs', { id: `rr-${provider}`, session_id: other, device_id: PEER, kind: 'start', tmux_name: 't', pid: null, launch_params: '{}', started_at: 1_000, ended_at: null, end_reason: null, heartbeat_at: NOW }, PEER);
    // 欄が無い相手（今の status）
    expect(resolveViewTarget(db, ME, other, NOW)).toEqual({ ok: false, reason: 'not-remote' });
    // 別の provider だけを名乗る相手
    upsertShared(db, 'devices', { id: PEER, name: 'Mac', platform: 'darwin', last_seen_at: NOW, status: JSON.stringify({ ...status, peer_chat_agents: ['claude-code', provider === 'codex' ? 'opencode' : 'codex'] }) }, PEER);
    expect(resolveViewTarget(db, ME, other, NOW)).toEqual({ ok: false, reason: 'not-remote' });
    upsertShared(db, 'devices', { id: PEER, name: 'Mac', platform: 'darwin', last_seen_at: NOW, status: JSON.stringify({ ...status, peer_chat_agents: ['claude-code', 'codex', 'opencode'] }) }, PEER);
    expect(resolveViewTarget(db, ME, other, NOW)).toMatchObject({ ok: true, target: { deviceId: PEER } });
  });

  it('Claude の会話は、peer_chat_agents が無い相手でも peer chat に入る', () => {
    run('r1', PEER, 1_000, false);
    expect(resolveViewTarget(db, ME, sid, NOW)).toMatchObject({ ok: true });
  });
});

describe('localCursorOf', () => {
  const line = (uuid: string, text: string) => JSON.stringify({ uuid, type: 'user', isSidechain: false, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: text } });

  it('降ろした写しの最後の項目の uuid を返す（自分の本文より新しい写しも使う）', () => {
    const p = path.join(dir, 'copy.jsonl');
    fs.writeFileSync(p, `${line('11111111-1111-4111-8111-111111111111', 'a')}\n${line('22222222-2222-4222-8222-222222222222', 'b')}\n`);
    file(p, PEER, 5);
    expect(localCursorOf(db, sid)).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('codex と opencode は null（項目の id が索引の seq で、元の PC と同じとは限らない）', () => {
    for (const provider of ['codex', 'opencode'] as const) {
      const other = ensureSession(db, `x-${provider}`, '/w', PEER, provider);
      const p = path.join(dir, `${provider}.jsonl`);
      fs.writeFileSync(p, `${line('11111111-1111-4111-8111-111111111111', 'a')}\n`);
      db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version, device_id, agent) values (?,?,null,1,5,1,1,?,?)').run(p, other, PEER, 'claude-code');
      expect(localCursorOf(db, other)).toBeNull();
    }
  });

  it('写しが無い、読めない、空なら null', () => {
    expect(localCursorOf(db, sid)).toBeNull();
    file(path.join(dir, 'missing.jsonl'), PEER, 5);
    expect(localCursorOf(db, sid)).toBeNull();
  });
});
