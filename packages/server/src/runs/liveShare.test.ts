import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { LiveShare } from './liveShare.ts';

/** その run の PC の状態を共有の行へ載せる。変わったときだけ書き、idle と busy は短い往復を保留する。 */

let db: Db;
let now: number;
let share: LiveShare;
const HOLD = 3000;

const run = (id: string, extra: Record<string, unknown> = {}) =>
  upsertShared(db, 'runs', { id, session_id: 's1', device_id: 'd', kind: 'start', tmux_name: `t-${id}`, pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1, ...extra }, 'd');
const live = (id = 'r1') => db.prepare('select live_status, live_reason, live_at from runs where id = ?').get(id) as { live_status: string | null; live_reason: string | null; live_at: number | null };
const writes = () => (db.prepare("select count(*) c from changes where table_name = 'runs'").get() as { c: number }).c;

beforeEach(() => {
  vi.useFakeTimers();
  db = openDb(':memory:');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'd' }, 'd');
  run('r1');
  now = 1000;
  share = new LiveShare({ db, deviceId: 'd', holdMs: HOLD, now: () => now });
});
afterEach(() => {
  share.dispose();
  vi.useRealTimers();
});

describe('LiveShare', () => {
  it('idle と busy は保留の後に書く。状態になった時刻は変わった瞬間', () => {
    share.observe('r1', 'busy', null);
    expect(live().live_status).toBeNull();
    now = 1000 + HOLD;
    vi.advanceTimersByTime(HOLD);
    expect(live()).toEqual({ live_status: 'busy', live_reason: null, live_at: 1000 });
  });

  it('保留の間に元へ戻ったら書かない', () => {
    share.observe('r1', 'idle', null);
    vi.advanceTimersByTime(HOLD);
    expect(live().live_status).toBe('idle');
    const before = writes();
    share.observe('r1', 'busy', null);
    vi.advanceTimersByTime(HOLD - 1);
    share.observe('r1', 'idle', null);
    vi.advanceTimersByTime(HOLD * 2);
    expect(live().live_status).toBe('idle');
    expect(writes()).toBe(before);
  });

  it('waiting は保留せずすぐ書く。保留中の別の状態は取り消す', () => {
    share.observe('r1', 'busy', null);
    now = 1500;
    share.observe('r1', 'waiting', null);
    expect(live()).toEqual({ live_status: 'waiting', live_reason: null, live_at: 1500 });
    vi.advanceTimersByTime(HOLD * 2);
    expect(live().live_status).toBe('waiting');
  });

  it('同じ状態の再観測は書かない', () => {
    share.observe('r1', 'waiting', null);
    const before = writes();
    now = 2000;
    share.observe('r1', 'waiting', null);
    share.observe('r1', 'waiting', null);
    expect(writes()).toBe(before);
    expect(live().live_at).toBe(1000);
  });

  it('理由だけが変わったときも書く（waiting は即時）', () => {
    share.observe('r1', 'waiting', null);
    now = 1200;
    share.observe('r1', 'waiting', 'permission');
    expect(live()).toEqual({ live_status: 'waiting', live_reason: 'permission', live_at: 1000 });
  });

  it('idle の理由の変化は保留してから書く', () => {
    share.observe('r1', 'idle', null);
    vi.advanceTimersByTime(HOLD);
    share.observe('r1', 'idle', 'limit');
    expect(live().live_reason).toBeNull();
    vi.advanceTimersByTime(HOLD);
    expect(live().live_reason).toBe('limit');
  });

  it('保留の間に run が終わったら書かない', () => {
    share.observe('r1', 'busy', null);
    run('r1', { ended_at: 1100, end_reason: 'exit' });
    vi.advanceTimersByTime(HOLD);
    expect(live().live_status).toBeNull();
  });
});
