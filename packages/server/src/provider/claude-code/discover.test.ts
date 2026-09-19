import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_CLAUDE_DIR, SESSION_ALPHA, SESSION_BETA, SESSION_OTHER } from '../../../test/fixtures.ts';
import type { DiscoveredFile } from '../types.ts';
import { hasTranscriptFile, listRemoteTranscriptFiles, listTranscriptFiles, mangleCwd, readHistoryIndex, selectFilesToIndex } from './discover.ts';

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
      { path: path.join(FIXTURE_CLAUDE_DIR, 'projects/-Users-me-other', `${SESSION_OTHER}.jsonl`), sessionId: SESSION_OTHER, agentId: null, deviceId: null },
      { path: path.join(FIXTURE_CLAUDE_DIR, 'projects/-Users-me-workspace-alpha', `${SESSION_ALPHA}.jsonl`), sessionId: SESSION_ALPHA, agentId: null, deviceId: null },
      { path: path.join(FIXTURE_CLAUDE_DIR, 'projects/-Users-me-workspace-alpha', SESSION_ALPHA, 'subagents/agent-abc123.jsonl'), sessionId: SESSION_ALPHA, agentId: 'abc123', deviceId: null },
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

describe('hasTranscriptFile', () => {
  it('本体でもサブエージェントでも、1 つでもあれば真', () => {
    expect(hasTranscriptFile(FIXTURE_CLAUDE_DIR, SESSION_ALPHA, '/Users/me/workspace/alpha')).toBe(true);
    // cwd が分からなくても、また外れていても、全部のプロジェクトを当たる。
    expect(hasTranscriptFile(FIXTURE_CLAUDE_DIR, SESSION_ALPHA)).toBe(true);
    expect(hasTranscriptFile(FIXTURE_CLAUDE_DIR, SESSION_ALPHA, '/nowhere')).toBe(true);
    expect(hasTranscriptFile(FIXTURE_CLAUDE_DIR, SESSION_OTHER)).toBe(true);
  });
  it('本文の無いセッションと無いディレクトリは偽', () => {
    // SESSION_BETA は history にしか出てこない。jsonl はどこにも無い。
    expect(hasTranscriptFile(FIXTURE_CLAUDE_DIR, SESSION_BETA)).toBe(false);
    expect(hasTranscriptFile(FIXTURE_CLAUDE_DIR, '00000000-0000-0000-0000-000000000000')).toBe(false);
    // projects を読めないのは「観測できない」であって「本文が無い」ではない。
    expect(hasTranscriptFile('/nonexistent/dir', SESSION_ALPHA)).toBeNull();
    expect(hasTranscriptFile(FIXTURE_CLAUDE_DIR, '')).toBe(false);
  });
});

const tmpTree = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-remote-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
};

describe('listRemoteTranscriptFiles', () => {
  it('端末ごとのディレクトリを歩き、deviceId を付ける', () => {
    const u = '11111111-1111-4111-8111-111111111111';
    const root = tmpTree({
      [`dev-b/projects/-w-alpha/${u}.jsonl`]: '{}\n',
      [`dev-b/projects/-w-alpha/${u}/subagents/agent-ab12.jsonl`]: '{}\n',
      [`dev-c/projects/-w-alpha/${u}.jsonl`]: '{}\n',
      'dev-b/notes.txt': 'x',
    });
    expect(listRemoteTranscriptFiles(root)).toEqual([
      { path: path.join(root, 'dev-b/projects/-w-alpha', `${u}.jsonl`), sessionId: u, agentId: null, deviceId: 'dev-b' },
      { path: path.join(root, 'dev-b/projects/-w-alpha', u, 'subagents/agent-ab12.jsonl'), sessionId: u, agentId: 'ab12', deviceId: 'dev-b' },
      { path: path.join(root, 'dev-c/projects/-w-alpha', `${u}.jsonl`), sessionId: u, agentId: null, deviceId: 'dev-c' },
    ]);
    expect(listRemoteTranscriptFiles(path.join(root, 'nope'))).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('selectFilesToIndex', () => {
  const f = (p: string, deviceId: string | null, agentId: string | null = null): DiscoveredFile => ({ path: p, sessionId: 'u1', agentId, deviceId });
  const stat = (m: Record<string, number>) => (p: string) => (m[p] === undefined ? null : { mtimeMs: m[p]! });

  it('手元があれば手元を選び、他は落とす', () => {
    const r = selectFilesToIndex([f('/remote/b/u1.jsonl', 'b'), f('/home/u1.jsonl', null), f('/remote/c/u1.jsonl', 'c')], { statOf: stat({ '/remote/b/u1.jsonl': 300, '/home/u1.jsonl': 100, '/remote/c/u1.jsonl': 200 }) });
    expect(r.index.map((x) => x.path)).toEqual(['/home/u1.jsonl']);
    expect(r.drop.map((x) => x.path)).toEqual(['/remote/b/u1.jsonl', '/remote/c/u1.jsonl']);
  });
  it('手元が無ければ更新時刻が最新の写しを 1 つだけ選ぶ', () => {
    const r = selectFilesToIndex([f('/remote/b/u1.jsonl', 'b'), f('/remote/c/u1.jsonl', 'c')], { statOf: stat({ '/remote/b/u1.jsonl': 100, '/remote/c/u1.jsonl': 200 }) });
    expect(r.index.map((x) => x.path)).toEqual(['/remote/c/u1.jsonl']);
    expect(r.drop.map((x) => x.path)).toEqual(['/remote/b/u1.jsonl']);
  });
  it('譲ったセッションは手元を優先しない', () => {
    const files = [f('/home/u1.jsonl', null), f('/remote/b/u1.jsonl', 'b')];
    const statOf = stat({ '/home/u1.jsonl': 100, '/remote/b/u1.jsonl': 300 });
    expect(selectFilesToIndex(files, { statOf }).index.map((x) => x.path)).toEqual(['/home/u1.jsonl']);
    expect(selectFilesToIndex(files, { statOf, isYielded: () => true }).index.map((x) => x.path)).toEqual(['/remote/b/u1.jsonl']);
  });
  it('主線とサブエージェントは別々に選ぶ', () => {
    const r = selectFilesToIndex([f('/home/u1.jsonl', null), f('/remote/b/agent.jsonl', 'b', 'ab12')], { statOf: stat({ '/home/u1.jsonl': 1, '/remote/b/agent.jsonl': 1 }) });
    expect(r.index).toHaveLength(2);
    expect(r.drop).toEqual([]);
  });
});
