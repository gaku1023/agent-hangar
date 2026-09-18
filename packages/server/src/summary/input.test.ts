import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { buildSummaryInput, CANNED_INPUT, compressEvents } from './input.ts';
import { parseSummaryOutput, SUMMARY_SCHEMA } from './types.ts';

const ev = (kind: TranscriptEvent['kind'], text: string, seq: number): TranscriptEvent => {
  switch (kind) {
    case 'user': return { kind, seq, text };
    case 'assistant': return { kind, seq, text };
    case 'thinking': return { kind, seq, text };
    case 'system': return { kind, seq, text };
    case 'tool_call': return { kind, seq, toolId: 't' + seq, name: 'Edit', input: {}, summary: text };
    case 'tool_result': return { kind, seq, toolId: 't', text, isError: false };
    default: return { kind: 'meta', seq, name: 'x', value: text };
  }
};

describe('compressEvents', () => {
  it('役割ごとの上限で切り、thinking と tool_result と meta を捨てる', () => {
    const text = compressEvents([ev('user', 'あ'.repeat(2500), 0), ev('thinking', '考え', 1), ev('assistant', 'い'.repeat(700), 2), ev('tool_call', 'Edit src/a.ts', 3), ev('tool_result', 'ok', 4), ev('meta', 'm', 5), ev('system', 's', 6)]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('[user] ' + 'あ'.repeat(2000));
    expect(lines[1]).toBe('[assistant] ' + 'い'.repeat(600));
    expect(lines[2]).toBe('[tool] Edit src/a.ts');
  });
  it('全体が上限を超えたら中盤を間引き、最初と最後を残す', () => {
    const events: TranscriptEvent[] = [];
    for (let i = 0; i < 100; i++) events.push(ev('user', `発言${i} ` + 'x'.repeat(200), i));
    const text = compressEvents(events, { totalMax: 5000 });
    expect(text.length).toBeLessThanOrEqual(5000);
    expect(text).toContain('[user] 発言0 ');
    expect(text).toContain('発言99 ');
    expect(text).toMatch(/\[\.\.\. \d+ 件を省略 \.\.\.\]/);
    expect(text).not.toContain('発言50 ');
  });
});

describe('buildSummaryInput', () => {
  let dir: string; let db: Db;
  beforeEach(async () => { dir = copyFixtureClaudeDir(); db = openDb(':memory:'); await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  it('主線から入力を組み立てる', () => {
    const id = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
    const input = buildSummaryInput(db, id, true)!;
    expect(input).toMatchObject({ sessionId: id, turns: 2, running: true, titleHint: '動画チャンネルの整理' });
    expect(input.text).toContain('[user] 動画チャンネルの整理をしたい');
    expect(input.text).toContain('[tool] Bash ls channels/');
    expect(input.text).not.toContain('a.md\nb.md');
    expect(buildSummaryInput(db, 'nope', false)).toBeNull();
  });
});

describe('types', () => {
  it('スキーマの形と parseSummaryOutput', () => {
    expect(SUMMARY_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false, required: ['title', 'one_liner', 'body', 'state', 'next_steps'] });
    expect(parseSummaryOutput({ title: 'T', one_liner: 'O', body: 'B', state: 'done', next_steps: ['a', 1] })).toEqual({ title: 'T', oneLiner: 'O', body: 'B', state: 'done', nextSteps: ['a'] });
    expect(parseSummaryOutput({ title: '', one_liner: 'O', body: 'B', state: 'done', next_steps: [] })).toBeNull();
    expect(parseSummaryOutput({ title: 'T', one_liner: 'O', body: 'B', state: 'weird', next_steps: [] })).toBeNull();
    expect(parseSummaryOutput('x')).toBeNull();
    expect(CANNED_INPUT.text.length).toBeGreaterThan(100);
  });
});
