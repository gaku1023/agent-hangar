import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './open.ts';
import { getSession, listSessions } from './queries.ts';
import { upsertShared } from './shared.ts';

/**
 * SessionDto.newerElsewhere（A → B → A）。
 * 最後の run がほかの PC のもので、ほかの PC の写しが手元のトランスクリプトより大きいときだけ真にする。
 */
let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: '11111111-1111-4111-8111-111111111111', cwd: '/w', home_device: 'mac' }, 'mac');
});

const run = (device: string, startedAt: number, ended = true) =>
  upsertShared(db, 'runs', { id: `r-${device}-${startedAt}`, session_id: 's1', device_id: device, kind: 'resume', tmux_name: 't', pid: null, launch_params: '{}', started_at: startedAt, ended_at: ended ? startedAt + 1 : null, end_reason: ended ? 'exited' : null, heartbeat_at: startedAt }, device);
const file = (p: string, size: number, device: string | null, agent: string | null = null) =>
  db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version, device_id) values (?,?,?,?,?,?,?,?)').run(p, 's1', agent, size, 1, size, 1, device);
const newer = (device = 'mac') => getSession(db, [], 's1', { deviceId: device })?.newerElsewhere;

describe('newerElsewhere（ほかの PC にこの PC より新しい続きがある）', () => {
  it('最後の run がほかの PC で、その写しが手元より大きいときだけ真', () => {
    file('/local.jsonl', 100, null);
    run('mac', 1);
    file('/remote/win.jsonl', 300, 'win');
    expect(newer()).toBe(false);
    run('win', 2);
    expect(newer()).toBe(true);
    expect(listSessions(db, [], { deviceId: 'mac' })[0]?.newerElsewhere).toBe(true);
  });
  it('この PC で後から動かしたら偽', () => {
    file('/local.jsonl', 100, null);
    file('/remote/win.jsonl', 300, 'win');
    run('win', 1);
    run('mac', 2);
    expect(newer()).toBe(false);
  });
  it('写しが手元より大きくない、手元が無い（remoteOnly の側で扱う）、写しが無いときは偽', () => {
    run('win', 1);
    file('/remote/win.jsonl', 300, 'win');
    expect(newer()).toBe(false);
    file('/local.jsonl', 300, null);
    expect(newer()).toBe(false);
    db.prepare('delete from transcript_files where device_id is not null').run();
    expect(newer()).toBe(false);
  });
  it('サブエージェントのトランスクリプトは比べない', () => {
    run('win', 1);
    file('/local.jsonl', 100, null);
    file('/remote/agent.jsonl', 900, 'win', 'agent-1');
    expect(newer()).toBe(false);
  });
  it('PC を渡さないときは偽', () => {
    run('win', 1);
    file('/local.jsonl', 100, null);
    file('/remote/win.jsonl', 300, 'win');
    expect(getSession(db, [], 's1')?.newerElsewhere).toBe(false);
  });
});
