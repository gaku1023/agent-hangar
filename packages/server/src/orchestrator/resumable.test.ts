import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { orchestratorResumable } from './resumable.ts';

const make = () => {
  const db = openDb(':memory:');
  const row = (id: string, provider: string, psid: string) => upsertShared(db, 'sessions', { id, provider, provider_session_id: psid, cwd: '/o', home_device: 'd', project_id: null }, 'd');
  const body = (sid: string) => db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version, device_id, agent) values (?,?,null,1,1,1,1,?,?)').run(`/t/${sid}.jsonl`, sid, 'd', 'claude-code');
  return { db, row, body };
};

describe('orchestratorResumable', () => {
  it('Claude Code の会話は、本文があるときだけ再開できる', () => {
    const { db, row, body } = make();
    row('c1', 'claude-code', 'u1');
    expect(orchestratorResumable(db, 'c1')).toBe(false);
    body('c1');
    expect(orchestratorResumable(db, 'c1')).toBe(true);
  });

  it('Codex と opencode の会話は、hangar の本文の写しが無くても、相手の会話の id があれば再開できる', () => {
    const { db, row } = make();
    row('x1', 'codex', 'thread-1');
    row('o1', 'opencode', 'ses_1');
    expect(orchestratorResumable(db, 'x1')).toBe(true);
    expect(orchestratorResumable(db, 'o1')).toBe(true);
  });

  it('行が無い、または消した会話は再開できない', () => {
    const { db, row } = make();
    expect(orchestratorResumable(db, 'none')).toBe(false);
    row('o2', 'opencode', 'ses_2');
    db.prepare('update sessions set deleted_at = 1 where id = ?').run('o2');
    expect(orchestratorResumable(db, 'o2')).toBe(false);
  });
});
