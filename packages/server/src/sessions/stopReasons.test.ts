import { describe, expect, it } from 'vitest';
import { LIMIT_RESET_AUTO_GRACE_MS, LIMIT_RESET_GRACE_MS, type LiveSessionDto } from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import { ensureSession } from '../indexer/write.ts';
import { stopReasonsOf } from './stopReasons.ts';

const entry = (sessionId: string, status: LiveSessionDto['status'], over: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId, status, name: null, nameSource: null, cwd: '/w', pid: 1, ...over });

describe('stopReasonsOf', () => {
  it('登録と手元の表から、許可待ち・使用制限・リセット済みを引く', () => {
    const db = openDb(':memory:');
    const a = ensureSession(db, 'u1', '/w', 'd');
    const b = ensureSession(db, 'u2', '/w', 'd');
    ensureSession(db, 'u3', '/w', 'd');
    db.prepare('insert into session_limits (session_id, kind, resets_at, auto, hit_at) values (?,?,?,?,?)').run(b, 'five_hour', 1000, 1, 1);
    db.prepare('insert into session_activity (session_id, tool, summary, tool_id, question, updated_at) values (?,?,?,?,?,?)').run(a, 'Bash', 'Bash', 't', null, 1);
    const live = [entry('u1', 'waiting', { waitingFor: 'permission' }), entry('u2', 'idle'), entry('u3', 'busy')];
    const before = stopReasonsOf(db, live, 500);
    expect([before.reason('u1'), before.reason('u2'), before.reason('u3'), before.reason('u9')]).toEqual(['permission', 'limit', null, null]);
    // 自動で続く予約があるので、ふだんの猶予ではまだ使用制限のまま。
    expect(stopReasonsOf(db, live, 1000 + LIMIT_RESET_GRACE_MS).reason('u2')).toBe('limit');
    const after = stopReasonsOf(db, live, 1000 + LIMIT_RESET_AUTO_GRACE_MS);
    expect(after.reason('u2')).toBe('reset');
    expect(after.limit('u2')).toEqual({ kind: 'five_hour', resetsAt: 1000, auto: true, reset: true });
    // 実行中でなければ使用制限は載せない。
    expect(stopReasonsOf(db, [], 500).limit('u2')).toBeNull();
    db.close();
  });
});
