import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { codexTranscriptSource } from '../provider/codex/transcript/source.ts';
import { subagentIds } from '../transcript/read.ts';
import { copyFixtureClaudeDir } from '../../test/fixtures.ts';
import { CODEX_SUBAGENT_A, CODEX_SUBAGENT_B, CODEX_SUBAGENT_PARENT, fixtureBytes, makeCodexHome, putRollout, rolloutName } from '../../test/codexFixtures.ts';
import { buildLiveDigest } from './digest.ts';
import { parseSubagentNotification } from './codexAgents.ts';

let claudeDir: string;
let home: string;
let db: Db;
beforeEach(() => { claudeDir = copyFixtureClaudeDir(); home = makeCodexHome(); db = openDb(':memory:'); });
afterEach(() => { fs.rmSync(claudeDir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

const lines = (f: { file: string }) => fixtureBytes(f.file).toString('utf8').split('\n').filter(Boolean);
/** 親の rollout を、知らせの行を差し替えて置く。edit は知らせの行（JSON の文字列）を受けて、置き換える行を返す（null で消す）。 */
function putParent(edit: (line: string, agent: string) => string | null = (l) => l): void {
  const out = lines(CODEX_SUBAGENT_PARENT).flatMap((l) => {
    const agent = /subagent_notification[^]*?agent_path[^]*?(0{8}-0000-7000-8000-0000000000\d\d)/.exec(l)?.[1];
    if (agent === undefined) return [l];
    const r = edit(l, agent);
    return r === null ? [] : [r];
  });
  putRollout(home, rolloutName(CODEX_SUBAGENT_PARENT.id, '2026-11-25T20-14-16').rel, out.join('\n') + '\n');
}
const putChildren = () => {
  putRollout(home, rolloutName(CODEX_SUBAGENT_A.id, '2026-11-25T20-14-35').rel, fixtureBytes(CODEX_SUBAGENT_A.file));
  putRollout(home, rolloutName(CODEX_SUBAGENT_B.id, '2026-11-25T20-14-36').rel, fixtureBytes(CODEX_SUBAGENT_B.file));
};
async function index(): Promise<string> {
  const codex = codexTranscriptSource({ codexHome: () => home, enabled: () => true });
  await new IndexerService({ db, deviceId: 'd', transcripts: [claudeTranscriptSource({ claudeDir }), codex], isRunning: () => false }).fullScan();
  return (db.prepare("select id from sessions where provider = 'codex' and provider_session_id = ?").get(CODEX_SUBAGENT_PARENT.id) as { id: string }).id;
}
const status = (agent: string, st: unknown) => `<subagent_notification>\n${JSON.stringify({ agent_path: agent, status: st })}\n</subagent_notification>`;
const withStatus = (id: string, st: unknown) => (l: string, agent: string): string | null => {
  if (agent !== id) return l;
  const r = JSON.parse(l) as { payload: { content: { text: string }[] } };
  r.payload.content[0]!.text = status(id, st);
  return JSON.stringify(r);
};

describe('子の rollout の索引', () => {
  it('子は一覧の独立した会話にならず、親の会話のサブエージェントとして入る（event_index の parent_agent）', async () => {
    putParent(); putChildren();
    const sid = await index();
    const rows = db.prepare("select provider_session_id p from sessions where provider = 'codex'").all() as { p: string }[];
    expect(rows.map((r) => r.p)).toEqual([CODEX_SUBAGENT_PARENT.id]);
    expect(subagentIds(db, sid).sort()).toEqual([CODEX_SUBAGENT_A.id, CODEX_SUBAGENT_B.id]);
    const files = db.prepare("select agent_id a from transcript_files where agent = 'codex' and session_id = ? order by agent_id").all(sid) as { a: string | null }[];
    expect(files.map((f) => f.a)).toEqual([null, CODEX_SUBAGENT_A.id, CODEX_SUBAGENT_B.id]);
  });
});

describe('Codex の会話のサブエージェントの行（digest の agents）', () => {
  it('知らせ（completed）が届いた子は done。題は子の最初の指示、時刻は子の rollout の最初と最後、報告は知らせの本文、last は子の最後の手', async () => {
    putParent(); putChildren();
    const sid = await index();
    const d = buildLiveDigest(db, sid);
    expect(d.agents.map((a) => a.agentId)).toEqual([CODEX_SUBAGENT_A.id, CODEX_SUBAGENT_B.id]);
    const a = d.agents[0]!;
    expect(a).toMatchObject({ title: 'Read a.txt and report its exact content.', state: 'done', endNote: null, report: 'The exact content of `a.txt` is:', linked: true });
    expect(a.startedAt).toBe(Date.parse('2026-11-25T11:14:35.328Z'));
    expect(a.lastAt).toBe(Date.parse('2026-11-25T11:14:44.793Z'));
    expect(a.last).toMatchObject({ kind: expect.any(String), isError: false });
    expect(a.last?.text).toBeTruthy();
    expect(d.agents[1]).toMatchObject({ title: 'Read b.txt and report its exact content.', state: 'done', report: 'The exact content of `b.txt` is:' });
  });

  it('知らせがまだ届かない子は running で、報告は無い', async () => {
    putParent((l, agent) => (agent === CODEX_SUBAGENT_B.id ? null : l)); putChildren();
    const d = buildLiveDigest(db, await index());
    expect(d.agents.map((a) => [a.agentId, a.state, a.report])).toEqual([[CODEX_SUBAGENT_A.id, 'done', 'The exact content of `a.txt` is:'], [CODEX_SUBAGENT_B.id, 'running', null]]);
  });

  it('errored は error、interrupted など分からない終わりは done にして endNote に status を残す（error にしない）', async () => {
    putParent((l, agent) => (agent === CODEX_SUBAGENT_A.id ? withStatus(agent, { errored: 'boom\nmore' })(l, agent) : withStatus(agent, 'interrupted')(l, agent)));
    putChildren();
    const d = buildLiveDigest(db, await index());
    expect(d.agents[0]).toMatchObject({ state: 'error', endNote: null, report: 'boom' });
    expect(d.agents[1]).toMatchObject({ state: 'done', endNote: 'interrupted' });
  });

  it('子が無い会話は空', async () => {
    putRollout(home, rolloutName(CODEX_SUBAGENT_PARENT.id, '2026-11-25T20-14-16').rel, lines(CODEX_SUBAGENT_PARENT).filter((l) => !l.includes('subagent_notification')).join('\n') + '\n');
    expect(buildLiveDigest(db, await index()).agents).toEqual([]);
  });
});

describe('終わりの知らせの読み', () => {
  it('JSON として読める知らせ、切れた知らせ、文字列の status を読む', () => {
    const full = status('x1', { completed: 'done\nthen more' });
    expect(parseSubagentNotification(full)).toEqual({ agent: 'x1', status: 'completed', body: 'done\nthen more' });
    expect(parseSubagentNotification(full.slice(0, 80))).toMatchObject({ agent: 'x1', status: 'completed' });
    expect(parseSubagentNotification(status('x2', 'shutdown'))).toEqual({ agent: 'x2', status: 'shutdown', body: null });
    expect(parseSubagentNotification('<subagent_notification>\nnot json\n</subagent_notification>')).toBeNull();
  });
});
