import { describe, expect, it } from 'vitest';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import { ensureSession } from '../indexer/write.ts';
import { applyPermissionHook, PERMISSION_ASK_TTL_MS, PermissionAsks } from './permissionAsks.ts';

const ask = { tool: 'Bash', input: 'npm test', description: null };
const live = (status: LiveSessionDto['status'], over: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId: 'u1', status, name: null, nameSource: null, cwd: '/w', pid: 1, ...over });

describe('PermissionAsks', () => {
  it('許可を待っている間、その会話の登録に中身を足す', () => {
    const a = new PermissionAsks();
    a.put('u1', ask, 0);
    expect(a.apply([live('waiting', { waitingFor: 'permission' })], 100)[0]?.permission).toEqual(ask);
    // ほかの会話には足さない。
    expect(a.apply([live('waiting', { sessionId: 'u2' })], 100)[0]?.permission).toBeUndefined();
  });

  it('hook が登録より先に届いても、待ちに入るまで残す', () => {
    const a = new PermissionAsks();
    a.put('u1', ask, 0);
    expect(a.apply([live('busy')], 100)[0]?.permission).toBeUndefined();
    expect(a.apply([live('waiting', { waitingFor: 'permission' })], 400)[0]?.permission).toEqual(ask);
  });

  it('待ちを抜けたら忘れる。次の待ちに前の中身を出さない', () => {
    const a = new PermissionAsks();
    a.put('u1', ask, 0);
    a.apply([live('waiting')], 100);
    expect(a.apply([live('busy')], 200)[0]?.permission).toBeUndefined();
    expect(a.apply([live('waiting')], 300)[0]?.permission).toBeUndefined();
  });

  it('許可の待ちから、許可でない待ち（ダイアログ）へ移ったら忘れる。待ちのまま続いても前の命令を出さない', () => {
    const a = new PermissionAsks();
    a.put('u1', ask, 0);
    expect(a.apply([live('waiting', { waitingFor: 'permission' })], 100)[0]?.permission).toEqual(ask);
    // 許可した直後に Claude Code が別のダイアログを出す（status は waiting のまま、waitingFor が dialog open → other）。
    expect(a.apply([live('waiting', { waitingFor: 'other' })], 200)[0]?.permission).toBeUndefined();
    expect(a.apply([live('waiting', { waitingFor: 'permission' })], 300)[0]?.permission).toBeUndefined();
  });

  it('許可でない待ちには、預かった中身を足さない', () => {
    const a = new PermissionAsks();
    a.put('u1', ask, 0);
    expect(a.apply([live('waiting', { waitingFor: 'other' })], 100)[0]?.permission).toBeUndefined();
    // 後から許可の待ちに入れば足す（hook が先に届いていた）。
    expect(a.apply([live('waiting', { waitingFor: 'permission' })], 200)[0]?.permission).toEqual(ask);
  });

  it('AskUserQuestion の確認は、問いの待ち（input needed）でも足す', () => {
    const a = new PermissionAsks();
    const q = { tool: 'AskUserQuestion', input: '続けますか', description: null };
    a.put('u1', q, 0);
    expect(a.apply([live('waiting', { waitingFor: 'question' })], 100)[0]?.permission).toEqual(q);
  });

  it('待ちに入らないまま古くなった中身は捨てる', () => {
    const a = new PermissionAsks();
    a.put('u1', ask, 0);
    a.apply([live('busy')], PERMISSION_ASK_TTL_MS + 1);
    expect(a.apply([live('waiting')], PERMISSION_ASK_TTL_MS + 2)[0]?.permission).toBeUndefined();
  });

  it('新しい許可は前のものを置き換える', () => {
    const a = new PermissionAsks();
    a.put('u1', ask, 0);
    a.apply([live('waiting')], 100);
    a.put('u1', { tool: 'Write', input: '/w/a.ts', description: null }, 150);
    expect(a.apply([live('waiting')], 200)[0]?.permission?.tool).toBe('Write');
  });

  it('預けたら onPut を呼ぶ。登録の読み直しを待たずに、許可の中身を足させるためである', () => {
    let puts = 0;
    const a = new PermissionAsks(() => { puts++; });
    a.put('u1', ask, 0);
    expect(puts).toBe(1);
  });
});

describe('applyPermissionHook', () => {
  it('受け口のセッションの会話のものだけを預ける', () => {
    const db = openDb(':memory:');
    const sid = ensureSession(db, 'u1', '/w', 'd');
    const a = new PermissionAsks();
    expect(applyPermissionHook(db, sid, { providerSessionId: 'u9', ask }, a, 0)).toBe(false);
    expect(a.apply([live('waiting', { sessionId: 'u9' })], 1)[0]?.permission).toBeUndefined();
    expect(applyPermissionHook(db, sid, { providerSessionId: 'u1', ask }, a, 0)).toBe(true);
    expect(a.apply([live('waiting')], 1)[0]?.permission).toEqual(ask);
    db.close();
  });
});
