import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './open.ts';
import { getSession, listSessions } from './queries.ts';
import { upsertShared } from './shared.ts';

/**
 * SessionDto.lastDevice（最後の run の PC。手元なら null）。新規のダイアログが、止まった会話の PC を既定に選ぶのに使う。
 */
let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: '11111111-1111-4111-8111-111111111111', cwd: '/w', home_device: 'mac' }, 'mac');
});

const run = (device: string, startedAt: number) =>
  upsertShared(db, 'runs', { id: `r-${device}-${startedAt}`, session_id: 's1', device_id: device, kind: 'resume', tmux_name: 't', pid: null, launch_params: '{}', started_at: startedAt, ended_at: startedAt + 1, end_reason: 'exited', heartbeat_at: startedAt }, device);
const last = () => getSession(db, [], 's1', { deviceId: 'mac' })?.lastDevice;

describe('lastDevice（最後に動いた PC）', () => {
  it('run が無ければ null', () => {
    expect(last()).toBeNull();
  });
  it('最後の run がほかの PC ならその PC の id、手元なら null', () => {
    run('mac', 1);
    expect(last()).toBeNull();
    run('win', 2);
    expect(last()).toBe('win');
    expect(listSessions(db, [], { deviceId: 'mac' })[0]?.lastDevice).toBe('win');
    run('mac', 3);
    expect(last()).toBeNull();
  });
  it('PC を渡さないときは null', () => {
    run('win', 1);
    expect(getSession(db, [], 's1')?.lastDevice).toBeNull();
  });
});
