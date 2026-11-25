import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_SUBAGENT_A, fixtureBytes, makeCodexHome, putRollout, rolloutName } from '../../../../test/codexFixtures.ts';
import { listRolloutFiles } from './discover.ts';

let home: string;
beforeEach(() => { home = makeCodexHome(); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('listRolloutFiles', () => {
  it('先頭の 1 行がまだ書かれていない rollout は、主線にせず、その回は除く', () => {
    putRollout(home, rolloutName(CODEX_SUBAGENT_A.id, '2026-11-25T20-14-35').rel, '');
    expect(listRolloutFiles(home).files).toEqual([]);
  });

  it('先頭が読めれば、子は親の下（sessionId が親、agentId が自分）で返る', () => {
    putRollout(home, rolloutName(CODEX_SUBAGENT_A.id, '2026-11-25T20-14-35').rel, fixtureBytes(CODEX_SUBAGENT_A.file));
    expect(listRolloutFiles(home).files.map((f) => [f.sessionId, f.agentId])).toEqual([['00000000-0000-7000-8000-000000000010', CODEX_SUBAGENT_A.id]]);
  });
});
