import fs from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { getSession } from '../db/queries.ts';
import { IndexerService } from '../indexer/service.ts';
import { codexTranscriptSource } from '../provider/codex/transcript/source.ts';
import { CODEX_ONE_TURN, fixtureBytes, makeCodexHome, putRollout, rolloutName } from '../../test/codexFixtures.ts';
import { turnStrengthOf } from './turnMark.ts';

// Codex の統括でも、ターンの強さ（turnMark）と太りの手当て（contextTokens）が索引から読めるか。
// 索引は provider によらず session_stats の turns・last_prompt と session_live_stats の context_used を埋める。
let home: string;
let db: Db;
beforeEach(() => { home = makeCodexHome(); db = openDb(':memory:'); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const index = async (prompt: string) => {
  const body = fixtureBytes(CODEX_ONE_TURN.file).toString('utf8').replaceAll('List the files please', prompt);
  putRollout(home, rolloutName(CODEX_ONE_TURN.id, '2026-10-26T09-00-00').rel, body);
  await new IndexerService({ db, deviceId: 'd', transcripts: [codexTranscriptSource({ codexHome: () => home, enabled: () => true })], isRunning: () => false }).fullScan();
  return (db.prepare("select id from sessions where provider = 'codex' and provider_session_id = ?").get(CODEX_ONE_TURN.id) as { id: string }).id;
};

it('Codex の会話でも、[hangar] で始まる最後の入力は hangar のターン（fed）、利用者の入力は user になる', async () => {
  const fed = await index('[hangar] turn.done alpha');
  expect(db.prepare('select turns, last_prompt from session_stats where session_id = ?').get(fed)).toEqual({ turns: 1, last_prompt: '[hangar] turn.done alpha' });
  expect(turnStrengthOf(db, fed)).toBe('fed');
});

it('Codex の会話でも、利用者の入力は user', async () => {
  const id = await index('please check the build');
  expect(turnStrengthOf(db, id)).toBe('user');
});

it('Codex の会話でも、文脈の量（contextTokens）が会話の統計に入る', async () => {
  const id = await index('please check the build');
  expect(getSession(db, [], id, { deviceId: 'd' })?.stats.contextTokens).toBeGreaterThan(0);
});
