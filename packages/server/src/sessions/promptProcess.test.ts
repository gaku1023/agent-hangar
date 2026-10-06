import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import type { LiveSession } from '../provider/types.ts';
import { processStartOfPrompt } from './promptProcess.ts';

const T = (iso: string) => Date.parse(iso);
const PROMPT = T('2026-10-02T02:35:10.000Z');

function seed() {
  const db = openDb(':memory:');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'd' }, 'd');
  return db;
}
type Db = ReturnType<typeof seed>;
let n = 0;
const run = (db: Db, startedAt: number, o: { device?: string; deleted?: boolean } = {}) => {
  const id = `r${++n}`;
  upsertShared(db, 'runs', { id, session_id: 's1', device_id: o.device ?? 'd', kind: 'resume', tmux_name: `hangar-${id}`, pid: null, launch_params: '{}', started_at: startedAt, ended_at: null, end_reason: null, heartbeat_at: startedAt, deleted_at: o.deleted ? startedAt : null }, o.device ?? 'd');
};
const live = (procStart?: string, sessionId = 'u1'): LiveSession => ({ sessionId, status: 'idle', name: null, nameSource: null, cwd: '/w', pid: 42, ...(procStart ? { procStart } : {}) });
const q = { sessionId: 's1', providerSessionId: 'u1', promptTs: PROMPT };

describe('発言を出したプロセスの起動時刻', () => {
  it('登録にそのセッションの生きた項目があれば、その起動時刻（UTC の lstart）を使う', () => {
    const db = seed();
    run(db, T('2026-10-02T01:00:00.000Z'));
    expect(processStartOfPrompt(db, 'd', [live('Thu Oct  2 02:30:05 2026', 'other'), live('Thu Oct  2 02:20:00 2026')], q)).toBe(T('2026-10-02T02:20:00.000Z'));
  });
  it('登録に無ければ、runs のこの端末の最新の started_at（発言以前のもの）を使う', () => {
    const db = seed();
    run(db, T('2026-10-02T01:00:00.000Z'));
    run(db, T('2026-10-02T02:00:00.000Z'));
    run(db, T('2026-10-02T03:00:00.000Z'));
    run(db, T('2026-10-02T02:10:00.000Z'), { device: 'other' });
    run(db, T('2026-10-02T02:20:00.000Z'), { deleted: true });
    expect(processStartOfPrompt(db, 'd', [live('Thu Oct  2 02:30:05 2026', 'other')], q)).toBe(T('2026-10-02T02:00:00.000Z'));
  });
  it('登録の項目に起動時刻が無いか読めないか、発言より後に起動したものなら、runs に回る', () => {
    const db = seed();
    run(db, T('2026-10-02T02:00:00.000Z'));
    for (const l of [live(), live('garbage'), live('Thu Oct  2 02:40:00 2026')]) expect(processStartOfPrompt(db, 'd', [l], q), l.procStart).toBe(T('2026-10-02T02:00:00.000Z'));
  });
  it('どちらも取れなければ null', () => {
    const db = seed();
    expect(processStartOfPrompt(db, 'd', [], q)).toBeNull();
    run(db, T('2026-10-02T03:00:00.000Z'));
    expect(processStartOfPrompt(db, 'd', [live('Thu Oct  2 02:40:00 2026')], q)).toBeNull();
  });
});
