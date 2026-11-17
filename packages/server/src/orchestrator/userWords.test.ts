import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { recentUserWords } from './userWords.ts';

const SID = 'cccccccc-0000-4000-8000-000000000001';
const T = (s: number) => new Date(Date.UTC(2026, 10, 17, 1, 0, s)).toISOString();
const base = (s: number) => ({ uuid: `u${s}`, timestamp: T(s), cwd: '/w/orch', sessionId: SID });
const user = (s: number, content: unknown) => ({ type: 'user', message: { role: 'user', content }, ...base(s) });
const say = (s: number, text: string) => ({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] }, ...base(s) });

let dir: string;
let db: Db;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-words-')); db = openDb(':memory:'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

async function seed(rows: unknown[]): Promise<string> {
  const file = path.join(dir, 'projects', '-w-orch', `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await new IndexerService({ db, deviceId: 'd', transcript: claudeTranscriptSource({ claudeDir: dir }), isRunning: () => false }).fullScan();
  return (db.prepare('select id from sessions where provider_session_id = ?').get(SID) as { id: string }).id;
}

describe('recentUserWords', () => {
  it('利用者の入力の末尾から古い順に返し、[hangar] の出来事と道具の結果は除き、声の印は剥がす', async () => {
    const id = await seed([
      user(1, '最初の話'), say(2, 'はい'),
      user(3, '[hangar] 出来事 1 件\n- turn.done s1 「x」'), say(4, 'ok'),
      user(5, '二つ目'), say(6, 'はい'),
      user(7, [{ type: 'tool_result', tool_use_id: 't', content: 'out' }]),
      user(8, '[voice] 三つ目'), say(9, 'はい'),
      user(10, '四つ目'), say(11, 'はい'),
    ]);
    expect(recentUserWords(db, id, 3)).toEqual(['二つ目', '三つ目', '四つ目']);
  });

  it('本文の無い会話は空', () => {
    expect(recentUserWords(db, 'none', 3)).toEqual([]);
  });
});
