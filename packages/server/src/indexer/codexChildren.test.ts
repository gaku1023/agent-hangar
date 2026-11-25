import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { codexTranscriptSource } from '../provider/codex/transcript/source.ts';
import { openDb, type Db } from '../db/open.ts';
import { copyFixtureClaudeDir } from '../../test/fixtures.ts';
import { CODEX_SUBAGENT_A, CODEX_SUBAGENT_B, CODEX_SUBAGENT_PARENT, fixtureBytes, makeCodexHome, putRollout, rolloutName } from '../../test/codexFixtures.ts';
import { indexFile } from './indexFile.ts';
import { IndexerService } from './service.ts';

// 前の版は、子（サブエージェント）の rollout を独立した会話として索引した。その行を、起動時に親の下へ付け替える。
// 前の版の索引は、子の rollout を sessionId が自分、agentId が null のファイルとして indexFile に通した形で作る。
let claudeDir: string;
let home: string;
let db: Db;
beforeEach(() => { claudeDir = copyFixtureClaudeDir(); home = makeCodexHome(); db = openDb(':memory:'); });
afterEach(() => { fs.rmSync(claudeDir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

const P = CODEX_SUBAGENT_PARENT.id;
const A = CODEX_SUBAGENT_A.id;
const B = CODEX_SUBAGENT_B.id;
const put = (f: { file: string; id: string }, when: string) => putRollout(home, rolloutName(f.id, when).rel, fixtureBytes(f.file));
const source = () => codexTranscriptSource({ codexHome: () => home, enabled: () => true });
const svc = () => new IndexerService({ db, deviceId: 'd', transcripts: [claudeTranscriptSource({ claudeDir }), source()], isRunning: () => false });
const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;
const rows = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];

/** 前の版の索引：親と子を、どれも独立した会話（sessionId が自分、agentId が null）として入れる。 */
function indexLikeOldVersion(ids: string[]): void {
  const reader = source();
  const when: Record<string, string> = { [P]: '2026-11-25T20-14-16', [A]: '2026-11-25T20-14-35', [B]: '2026-11-25T20-14-36' };
  for (const id of ids) {
    const p = `${home}/${rolloutName(id, when[id]).rel}`;
    indexFile(db, { path: p, sessionId: id, agentId: null, deviceId: null }, { deviceId: 'd', reader });
  }
}
const sessionIds = () => rows<{ provider_session_id: string; deleted_at: number | null }>("select provider_session_id, deleted_at from sessions where provider = 'codex' order by provider_session_id");

describe('前の版が独立した会話として索引した子を、起動時に親の下へ付け替える', () => {
  beforeEach(() => {
    put(CODEX_SUBAGENT_PARENT, '2026-11-25T20-14-16');
    put(CODEX_SUBAGENT_A, '2026-11-25T20-14-35');
    put(CODEX_SUBAGENT_B, '2026-11-25T20-14-36');
  });

  it('子の独立した会話は論理削除し、子の rollout は親のサブエージェントとして読み直す', async () => {
    indexLikeOldVersion([P, A, B]);
    expect(sessionIds()).toHaveLength(3);
    const parentRow = one<{ id: string }>("select id from sessions where provider_session_id = ?", P);
    const s = svc();
    await s.start();
    s.stop();
    expect(sessionIds().filter((r) => r.deleted_at === null).map((r) => r.provider_session_id)).toEqual([P]);
    expect(rows<{ session_id: string; agent_id: string | null }>("select session_id, agent_id from transcript_files where agent = 'codex' order by agent_id").map((r) => [r.session_id === parentRow.id, r.agent_id])).toEqual([[true, null], [true, A], [true, B]]);
    // 子の事象は親の会話の下（parent_agent が子）に積まれ、独立した会話の分は残らない。
    const childSession = one<{ id: string }>("select id from sessions where provider_session_id = ?", A);
    expect(one<{ n: number }>('select count(*) n from event_index where session_id = ?', childSession.id).n).toBe(0);
    expect(one<{ n: number }>('select count(*) n from event_index where session_id = ? and parent_agent = ?', parentRow.id, A).n).toBeGreaterThan(0);
    expect(one<{ n: number }>('select count(*) n from usage_daily where session_id = ?', childSession.id).n).toBe(0);
  });

  it('この PC が上げた子の台帳の鍵（独立した会話の形）は、親の下の鍵に付け替え、上げ直さない', async () => {
    indexLikeOldVersion([P, A]);
    const ins = db.prepare("insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?, 'transcript', ?, ?, 'x', 1, 1, 1, 1)");
    const rel = `codex/sessions/2026/11/25/${rolloutName(A, '2026-11-25T20-14-35').name}`;
    ins.run(`codex/d/${A}.jsonl.gz`, rel, 'd');
    ins.run(`codex/other/${A}.jsonl.gz`, rel, 'other');
    db.prepare("insert into blob_uploads (ledger_key, epoch) values (?, 1)").run(`codex/d/${A}.jsonl.gz`);
    const s = svc();
    await s.start();
    s.stop();
    expect(rows<{ key: string }>('select key from file_sync order by key').map((r) => r.key)).toEqual([`codex/d/${P}/subagents/${A}.jsonl.gz`, `codex/other/${A}.jsonl.gz`]);
    expect(rows<{ ledger_key: string }>('select ledger_key from blob_uploads').map((r) => r.ledger_key)).toEqual([`codex/d/${P}/subagents/${A}.jsonl.gz`]);
  });

  it('親が手元の索引に無い子は、独立した会話のまま残す（行を消さない）', async () => {
    fs.rmSync(`${home}/${rolloutName(P, '2026-11-25T20-14-16').rel}`);
    indexLikeOldVersion([A]);
    const s = svc();
    await s.start();
    s.stop();
    expect(sessionIds()).toEqual([{ provider_session_id: A, deleted_at: null }]);
    expect(one<{ agent_id: string | null }>('select agent_id from transcript_files where agent = ?', 'codex').agent_id).toBeNull();
  });

  it('付け替えは起動のたびにやり直さない（済みの印を置く）。親の子として索引し直したあとの起動は何も変えない', async () => {
    indexLikeOldVersion([P, A]);
    const a = svc();
    await a.start();
    a.stop();
    const before = rows('select * from transcript_files order by path');
    const b = svc();
    await b.start();
    b.stop();
    expect(rows('select * from transcript_files order by path')).toEqual(before);
    expect(sessionIds().filter((r) => r.deleted_at === null)).toHaveLength(1);
  });

  it('前の版の PC が子の行に論理削除を書いて流した後でも、子の索引は親の下へ付け替わる（子が消えない）', async () => {
    indexLikeOldVersion([P, A]);
    db.prepare("update sessions set deleted_at = 5 where provider_session_id = ?").run(A);
    const parentRow = one<{ id: string }>("select id from sessions where provider_session_id = ?", P);
    const s = svc();
    await s.start();
    s.stop();
    expect(rows<{ session_id: string; agent_id: string | null }>("select session_id, agent_id from transcript_files where agent = 'codex' order by agent_id").map((r) => [r.session_id === parentRow.id, r.agent_id])).toEqual([[true, null], [true, A], [true, B]]);
    expect(one<{ n: number }>('select count(*) n from event_index where session_id = ? and parent_agent = ?', parentRow.id, A).n).toBeGreaterThan(0);
  });

  it('付け替えの印を立てたあとに親が入った子も、親の下で読み直される', async () => {
    fs.rmSync(`${home}/${rolloutName(P, '2026-11-25T20-14-16').rel}`);
    indexLikeOldVersion([A]);
    const a = svc();
    await a.start();
    a.stop();
    put(CODEX_SUBAGENT_PARENT, '2026-11-25T20-14-16');
    const b = svc();
    await b.start();
    b.stop();
    const parentRow = one<{ id: string }>("select id from sessions where provider_session_id = ?", P);
    expect(rows<{ session_id: string; agent_id: string | null }>("select session_id, agent_id from transcript_files where agent = 'codex' order by agent_id").map((r) => [r.session_id === parentRow.id, r.agent_id])).toEqual([[true, null], [true, A], [true, B]]);
  });

  it('手元のファイルが消えた行が 1 本あっても、済みの印は立つ', async () => {
    indexLikeOldVersion([P, A, B]);
    fs.rmSync(`${home}/${rolloutName(B, '2026-11-25T20-14-36').rel}`);
    const s = svc();
    await s.start();
    s.stop();
    expect(one<{ n: number }>("select count(*) n from settings_local where key = 'codexChildrenReparented'").n).toBe(1);
  });
});
