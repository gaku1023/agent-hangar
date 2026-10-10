import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { logQueries } from '../../test/queryLog.ts';
import { readEvents, subagentIds } from './read.ts';

let dir: string;
let db: Db;
let alphaId: string;
beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readEvents', () => {
  it('主線を seq 順に返す', () => {
    const page = readEvents(db, alphaId, {});
    expect(page.total).toBe(17);
    expect(page.nextSeq).toBeNull();
    expect(page.events.map((e) => e.seq)).toEqual([...Array(17).keys()]);
    expect(page.events[0]).toMatchObject({ kind: 'user', text: '動画チャンネルの整理をしたい。まず現状を見て' });
    expect(page.events[6]).toMatchObject({ kind: 'tool_result', isError: true, text: 'File not found' });
    expect(page.events[13]).toMatchObject({ kind: 'meta', name: 'ai-title' });
  });
  it('fromSeq と limit でページを切る', () => {
    const p1 = readEvents(db, alphaId, { fromSeq: 0, limit: 5 });
    expect(p1.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(p1.nextSeq).toBe(5);
    const p2 = readEvents(db, alphaId, { fromSeq: p1.nextSeq!, limit: 100 });
    expect(p2.events[0]!.seq).toBe(5);
    expect(p2.nextSeq).toBeNull();
  });
  it('latest は末尾から limit 件を返し、nextSeq は付けない', () => {
    const p = readEvents(db, alphaId, { latest: true, limit: 5 });
    expect(p.events.map((e) => e.seq)).toEqual([12, 13, 14, 15, 16]);
    expect(p.total).toBe(17);
    // 末尾から読んだページに「次の前向きのページ」は無い。
    expect(p.nextSeq).toBeNull();
  });
  it('latest は件数が足りなければ全件を返す', () => {
    const p = readEvents(db, alphaId, { latest: true, limit: 100 });
    expect(p.events.map((e) => e.seq)).toEqual([...Array(17).keys()]);
    expect(p.nextSeq).toBeNull();
  });
  it('beforeSeq はその手前の limit 件を返す', () => {
    const p = readEvents(db, alphaId, { beforeSeq: 12, limit: 5 });
    expect(p.events.map((e) => e.seq)).toEqual([7, 8, 9, 10, 11]);
    expect(p.nextSeq).toBeNull();
  });
  it('beforeSeq が先頭に届いたら残りだけを返す', () => {
    expect(readEvents(db, alphaId, { beforeSeq: 3, limit: 10 }).events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
  it('beforeSeq より古い行が無ければ空', () => {
    const p = readEvents(db, alphaId, { beforeSeq: 0, limit: 10 });
    expect(p.events).toEqual([]);
    expect(p.total).toBe(17);
  });
  it('末尾から読む道でもサブエージェントを読める', () => {
    expect(readEvents(db, alphaId, { agentId: 'abc123', latest: true, limit: 1 }).events.map((e) => e.kind)).toEqual(['assistant']);
  });
  it('サブエージェントの本文を agentId で読む', () => {
    expect(subagentIds(db, alphaId)).toEqual(['abc123']);
    const page = readEvents(db, alphaId, { agentId: 'abc123' });
    expect(page.events.map((e) => e.kind)).toEqual(['user', 'assistant']);
  });
  it('サブエージェントは名前順ではなく始まった順に並ぶ', async () => {
    // 名前の順と時刻の順が逆になるように、2 つのサブエージェントを足す。
    const sub = path.join(dir, 'projects', '-Users-me-workspace-alpha', SESSION_ALPHA, 'subagents');
    const line = (agentId: string, ts: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' }, uuid: 'x-' + agentId, parentUuid: null, isSidechain: true, agentId, timestamp: ts, cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA }) + '\n';
    fs.writeFileSync(path.join(sub, 'agent-aaa999.jsonl'), line('aaa999', '2026-09-01T10:05:00.000Z'));
    fs.writeFileSync(path.join(sub, 'agent-zzz111.jsonl'), line('zzz111', '2026-09-01T10:01:00.000Z'));
    await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
    expect(subagentIds(db, alphaId)).toEqual(['abc123', 'zzz111', 'aaa999']);
  });
  it('知らないセッションは空', () => {
    expect(readEvents(db, 'nope', {})).toEqual({ sessionId: 'nope', events: [], total: 0, nextSeq: null });
  });
});

describe('1 つの記録から何行も出る本文', () => {
  // 考えと発言と 2 つの手を 1 つの記録に持つ返答と、2 つの結果を 1 つの記録に持つ利用者の行を繰り返す。
  // ページの切れ目が記録の途中に来るのは、このような記録があるときだけである。
  const SID = 'dddddddd-0000-4000-8000-000000000001';
  const ts = (n: number) => new Date(Date.UTC(2026, 9, 10, 1, 0, n)).toISOString();
  const base = (n: number) => ({ uuid: `w${n}`, timestamp: ts(n), cwd: '/Users/me/workspace/alpha', sessionId: SID });
  const round = (n: number) => [
    { type: 'assistant', message: { role: 'assistant', model: 'm', content: [
      { type: 'thinking', thinking: `考え ${n}` },
      { type: 'text', text: `読みます ${n}` },
      { type: 'tool_use', id: `t${n}a`, name: 'Read', input: { file_path: `/a${n}.ts` } },
      { type: 'tool_use', id: `t${n}b`, name: 'Read', input: { file_path: `/b${n}.ts` } },
    ] }, ...base(2 * n) },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: `t${n}a`, content: `a${n}` },
      { type: 'tool_result', tool_use_id: `t${n}b`, content: `b${n}` },
    ] }, ...base(2 * n + 1) },
  ];
  let wideId: string;
  beforeEach(async () => {
    const rows = [{ type: 'user', message: { role: 'user', content: '読んで' }, ...base(0) }, ...[1, 2, 3, 4].flatMap(round)];
    fs.writeFileSync(path.join(dir, 'projects', '-Users-me-workspace-alpha', `${SID}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
    wideId = (db.prepare('select id from sessions where provider_session_id = ?').get(SID) as { id: string }).id;
  });

  it('どこからページを切っても、通しで読んだものと同じ行を返す（記録の途中から始まるページを含む）', () => {
    // 1 つの記録から 3 行以上が出ていることを先に確かめる。無ければ途中から始まるページを試せていない。
    const widest = (db.prepare("select max(c) m from (select count(*) c from event_index where session_id = ? and ifnull(parent_agent, '') = '' group by file_path_ref, byte_offset)").get(wideId) as { m: number }).m;
    expect(widest).toBeGreaterThanOrEqual(3);
    const all = readEvents(db, wideId, {}).events;
    expect(all.map((e) => e.seq)).toEqual([...Array(all.length).keys()]);
    for (let from = 0; from < all.length; from++) {
      for (const limit of [1, 2, 3, 5]) {
        expect(readEvents(db, wideId, { fromSeq: from, limit }).events).toEqual(all.slice(from, from + limit));
        expect(readEvents(db, wideId, { beforeSeq: from + 1, limit }).events).toEqual(all.slice(Math.max(0, from + 1 - limit), from + 1));
      }
    }
  });
  it('1 ページで DB を引く回数は、読む記録の数によらない', () => {
    // 記録ごとに引くと、長いセッションでは 1 回ごとにそのセッションの全行を見に行き、500 件のページで数百 ms かかっていた。
    const total = readEvents(db, wideId, {}).total;
    const few = logQueries(db);
    readEvents(few.db, wideId, { fromSeq: 0, limit: 2 });
    const many = logQueries(db);
    readEvents(many.db, wideId, { fromSeq: 0, limit: total });
    expect(many.ran.length).toBe(few.ran.length);
  });
});
