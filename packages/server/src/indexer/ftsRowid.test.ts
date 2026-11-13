import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@agent-hangar/shared';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb, type Db } from '../db/open.ts';
import type { IndexBatch, IndexRecord } from '../agent/types.ts';
import { deleteIndexed, writeBatch } from './write.ts';

// 索引の作り直しで event_fts を消すとき、全件をなめずに rowid で引く（2026-11-14、Windows で 30 万行を 1 回 0.3〜1.7 秒なめていた）。
// なめていないことは、消す対象の外にある行（event_index から指されていない行）が残ることで見る。

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });

const DEV = 'dev-1';
const OC = 'ses_0123456789abcdef';
const TS = Date.parse('2026-10-20T10:00:00.000Z');
const stored = (events: TranscriptEvent[]): IndexRecord => ({ events, facts: { isUserTurn: false, ts: TS, cwd: '/w' }, locator: { kind: 'stored' } });
const turn = (text: string): IndexRecord => stored([
  { kind: 'user', seq: 0, ts: TS, text },
  { kind: 'assistant', seq: 1, ts: TS, text: `${text} の返答` },
  { kind: 'meta', seq: 2, ts: TS, name: 'x', value: null },
  { kind: 'tool_call', seq: 3, ts: TS, toolId: 't', name: 'Bash', input: { command: 'ls' }, summary: 'ls' },
]);
const batch = (records: IndexRecord[], reset: boolean, agentId: string | null = null): IndexBatch =>
  ({ agent: 'opencode', providerSessionId: OC, agentId, reset, records });

const ftsTexts = (sid: string) => (db.prepare('select text from event_fts where session_id = ? order by rowid').all(sid) as { text: string }[]).map((r) => r.text);
const plantOrphan = (sid: string, agentId: string | null, text: string) =>
  db.prepare('insert into event_fts (session_id, agent_id, seq, role, text) values (?,?,?,?,?)').run(sid, agentId, 999, 'user', text);

describe('event_fts を rowid で消す', () => {
  it('積むとき event_index に event_fts の rowid を持ち、本文の無いイベントは 0 にする', () => {
    const { sessionId } = writeBatch(db, batch([turn('はじめ')], true), { deviceId: DEV });
    const rows = db.prepare('select seq, kind, fts_rowid from event_index where session_id = ? order by seq').all(sessionId) as { seq: number; kind: string; fts_rowid: number }[];
    expect(rows.map((r) => r.kind)).toEqual(['user', 'assistant', 'meta', 'tool_call']);
    expect(rows[2]!.fts_rowid).toBe(0);
    for (const r of [rows[0]!, rows[1]!, rows[3]!]) {
      const f = db.prepare('select seq, session_id from event_fts where rowid = ?').get(r.fts_rowid) as { seq: number; session_id: string };
      expect(f).toEqual({ seq: r.seq, session_id: sessionId });
    }
  });

  it('作り直しは指している行だけを消し、event_fts をなめない（指されていない行が残る）', () => {
    const { sessionId } = writeBatch(db, batch([turn('はじめ')], true), { deviceId: DEV });
    plantOrphan(sessionId, null, '指されていない行');
    writeBatch(db, batch([turn('作り直し')], true), { deviceId: DEV });
    expect(ftsTexts(sessionId)).toEqual(['指されていない行', '作り直し', '作り直し の返答', 'ls\nls']);
  });

  it('新しい会話の最初の索引は、消す行が無いので event_fts をなめない', () => {
    const { sessionId } = writeBatch(db, batch([], false), { deviceId: DEV });
    plantOrphan(sessionId, null, '指されていない行');
    writeBatch(db, batch([turn('はじめ')], true), { deviceId: DEV });
    expect(ftsTexts(sessionId)).toEqual(['指されていない行', 'はじめ', 'はじめ の返答', 'ls\nls']);
  });

  it('主線の作り直しは、サブエージェントの検索の行を残す', () => {
    const { sessionId } = writeBatch(db, batch([turn('主線')], true), { deviceId: DEV });
    writeBatch(db, batch([turn('子')], true, 'agent-1'), { deviceId: DEV });
    writeBatch(db, batch([turn('主線2')], true), { deviceId: DEV });
    expect(ftsTexts(sessionId).sort()).toEqual(['ls\nls', 'ls\nls', '主線2', '主線2 の返答', '子', '子 の返答'].sort());
  });

  it('rowid を持たない古い行（版 60 より前に積んだ行）があれば、今までどおり位置ごとに消す', () => {
    const { sessionId } = writeBatch(db, batch([], false), { deviceId: DEV });
    // 版を上げる前に積んだ行を真似る。fts_rowid は null のまま。
    db.prepare("insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref, parent_agent) values (?, 0, 'user', ?, 0, 0, 'x', null)").run(sessionId, TS);
    db.prepare("insert into event_fts (session_id, agent_id, seq, role, text) values (?, null, 0, 'user', '古い行')").run(sessionId);
    db.prepare("insert into event_fts (session_id, agent_id, seq, role, text) values (?, 'agent-1', 0, 'user', '子の古い行')").run(sessionId);
    // 古い行に続きを積んでから作り直す。
    writeBatch(db, batch([turn('続き')], false), { deviceId: DEV });
    writeBatch(db, batch([turn('作り直し')], true), { deviceId: DEV });
    expect(ftsTexts(sessionId)).toEqual(['子の古い行', '作り直し', '作り直し の返答', 'ls\nls']);
    expect(db.prepare('select count(*) c from event_index where session_id = ? and fts_rowid is null').get(sessionId)).toEqual({ c: 0 });
  });

  it('会話ごとに消す（agentKey を渡さない）と、主線もサブエージェントも古い行も消える', () => {
    const { sessionId } = writeBatch(db, batch([turn('主線')], true), { deviceId: DEV });
    writeBatch(db, batch([turn('子')], true, 'agent-1'), { deviceId: DEV });
    const other = writeBatch(db, { ...batch([turn('別の会話')], true), providerSessionId: 'ses_other' }, { deviceId: DEV }).sessionId;
    deleteIndexed(db, sessionId);
    expect(ftsTexts(sessionId)).toEqual([]);
    expect(db.prepare('select count(*) c from event_index where session_id = ?').get(sessionId)).toEqual({ c: 0 });
    expect(ftsTexts(other)).toEqual(['別の会話', '別の会話 の返答', 'ls\nls']);
  });

  it('rowid で消す delete の計画は event_fts を rowid で引く', () => {
    const plan = (db.prepare("explain query plan delete from event_fts where rowid in (select fts_rowid from event_index where session_id = ? and ifnull(parent_agent, '') = ? and fts_rowid > 0)").all('s', '') as { detail: string }[]).map((r) => r.detail);
    expect(plan.join('\n')).toMatch(/event_index USING INDEX event_index_pos/);
    expect(plan.join('\n')).not.toMatch(/SCAN event_index/);
  });
});

describe('版 60：event_index.fts_rowid', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-fts-rowid-migration-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('版 59 の DB を開くと、今ある行は fts_rowid が null のまま列が足される', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 59, (d) => {
      d.prepare("insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref) values ('s1', 0, 'user', 1, 0, 0, 'x')").run();
    });
    const d = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(60);
    expect(d.prepare('select seq, fts_rowid from event_index').all()).toEqual([{ seq: 0, fts_rowid: null }]);
    d.close();
  });
});
