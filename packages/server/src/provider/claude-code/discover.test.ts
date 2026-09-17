import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_CLAUDE_DIR, SESSION_ALPHA, SESSION_BETA, SESSION_OTHER } from '../../../test/fixtures.ts';
import { listTranscriptFiles, mangleCwd, readHistoryIndex } from './discover.ts';

describe('mangleCwd', () => {
  it('英数字以外を 1 文字ずつ - にする', () => {
    expect(mangleCwd('/Users/me/workspace/alpha')).toBe('-Users-me-workspace-alpha');
    expect(mangleCwd('/Users/me/workspace/父店-誕生日制作2025-09')).toBe('-Users-me-workspace---------2025-09');
  });
});

describe('listTranscriptFiles', () => {
  it('本体とサブエージェントの jsonl を列挙する', () => {
    const files = listTranscriptFiles(FIXTURE_CLAUDE_DIR);
    // パスの文字列順で並ぶ。
    // '.' は '/' より小さいので、本体の <sid>.jsonl が <sid>/subagents/ より先に来る。
    expect(files).toEqual([
      { path: path.join(FIXTURE_CLAUDE_DIR, 'projects/-Users-me-other', `${SESSION_OTHER}.jsonl`), sessionId: SESSION_OTHER, agentId: null },
      { path: path.join(FIXTURE_CLAUDE_DIR, 'projects/-Users-me-workspace-alpha', `${SESSION_ALPHA}.jsonl`), sessionId: SESSION_ALPHA, agentId: null },
      { path: path.join(FIXTURE_CLAUDE_DIR, 'projects/-Users-me-workspace-alpha', SESSION_ALPHA, 'subagents/agent-abc123.jsonl'), sessionId: SESSION_ALPHA, agentId: 'abc123' },
    ]);
  });
  it('projects が無ければ空', () => {
    expect(listTranscriptFiles('/nonexistent/dir')).toEqual([]);
  });
});

describe('readHistoryIndex', () => {
  it('セッションごとに cwd、最初と最後の時刻、件数をまとめる', () => {
    const idx = readHistoryIndex(FIXTURE_CLAUDE_DIR);
    expect(idx.size).toBe(3);
    expect(idx.get(SESSION_ALPHA)).toEqual({ cwd: '/Users/me/workspace/alpha', firstTs: 1788256800000, lastTs: 1788256980000, firstDisplay: '動画チャンネルの整理をしたい。まず現状を見て', count: 2 });
    expect(idx.get(SESSION_BETA)?.cwd).toBe('/Users/me/workspace/beta');
  });
  it('history.jsonl が無ければ空の Map', () => {
    expect(readHistoryIndex('/nonexistent/dir').size).toBe(0);
  });
});
