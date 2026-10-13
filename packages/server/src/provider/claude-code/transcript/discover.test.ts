import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_CLAUDE_DIR, SESSION_ALPHA, SESSION_BETA, SESSION_OTHER } from '../../../../test/fixtures.ts';
import type { DiscoveredFile } from '../types.ts';
import { classifyProjectsEntry, classifyRemoteEntry, hasTranscriptFile, HistoryIndexReader, listRemoteTranscriptFiles, listTranscriptFiles, mangleCwd, readHistoryIndex, selectFilesToIndex } from './discover.ts';

describe('mangleCwd', () => {
  it('英数字以外を 1 文字ずつ - にする', () => {
    expect(mangleCwd('/Users/me/workspace/alpha')).toBe('-Users-me-workspace-alpha');
    expect(mangleCwd('/Users/me/workspace/町内-夏祭り資料2025-09')).toBe('-Users-me-workspace---------2025-09');
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

describe('監視の名前の振り分け', () => {
  const root = path.join(os.tmpdir(), 'hangar-projects');
  const u = '11111111-1111-4111-8111-111111111111';

  it('主線とサブエージェントの jsonl は、そのファイルとして受ける', () => {
    expect(classifyProjectsEntry(root, `-w-alpha/${u}.jsonl`, null)).toEqual({ kind: 'file', file: { path: path.join(root, '-w-alpha', `${u}.jsonl`), sessionId: u, agentId: null, deviceId: null } });
    expect(classifyProjectsEntry(root, `-w-alpha/${u}/subagents/agent-ab12.jsonl`, null)).toEqual({ kind: 'file', file: { path: path.join(root, '-w-alpha', u, 'subagents', 'agent-ab12.jsonl'), sessionId: u, agentId: 'ab12', deviceId: null } });
    // Windows の fs.watch は区切りに \ を使う。
    expect(classifyProjectsEntry(root, `-w-alpha\\${u}.jsonl`, null)).toEqual({ kind: 'file', file: { path: path.join(root, '-w-alpha', `${u}.jsonl`), sessionId: u, agentId: null, deviceId: null } });
  });

  it('本文の入れ物になるディレクトリと置き場の外は、全件走査に回す', () => {
    for (const rel of ['', '-w-alpha', `-w-alpha/${u}`, `-w-alpha/${u}/subagents`, `../${u}.jsonl`, path.resolve('/abs', `${u}.jsonl`)]) {
      expect(classifyProjectsEntry(root, rel, null), rel).toEqual({ kind: 'rescan' });
    }
  });

  it('本文に関わらない名前は見ない', () => {
    for (const rel of ['-w-alpha/memory', '-w-alpha/memory/MEMORY.md', `-w-alpha/${u}/tool-results/x.txt`, `-w-alpha/${u}/tool-results`, '-w-alpha/not-a-session.jsonl', `-w-alpha/${u}/subagents/other.jsonl`]) {
      expect(classifyProjectsEntry(root, rel, null), rel).toEqual({ kind: 'ignore' });
    }
  });

  it('他端末の置き場は、端末の名前を deviceId にして同じ規則で振り分ける', () => {
    const rr = path.join(os.tmpdir(), 'hangar-remote');
    expect(classifyRemoteEntry(rr, `dev-b/projects/-w-alpha/${u}.jsonl`)).toEqual({ kind: 'file', file: { path: path.join(rr, 'dev-b', 'projects', '-w-alpha', `${u}.jsonl`), sessionId: u, agentId: null, deviceId: 'dev-b' } });
    expect(classifyRemoteEntry(rr, 'dev-b')).toEqual({ kind: 'rescan' });
    expect(classifyRemoteEntry(rr, 'dev-b/projects')).toEqual({ kind: 'rescan' });
    expect(classifyRemoteEntry(rr, 'dev-b/projects/-w-alpha')).toEqual({ kind: 'rescan' });
    expect(classifyRemoteEntry(rr, 'dev-b/notes.txt')).toEqual({ kind: 'ignore' });
  });
});

describe('HistoryIndexReader', () => {
  const rec = (sessionId: string, ts: number, display: string, project = '/w/a') => JSON.stringify({ display, timestamp: ts, project, sessionId }) + '\n';
  let dir: string;
  const file = () => path.join(dir, 'history.jsonl');
  const fresh = () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-history-')); };
  afterEach(() => { vi.restoreAllMocks(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  /** 次の書き込みが別の更新時刻になるよう、時刻を明示して進める。 */
  let clock = Date.parse('2026-09-01T00:00:00Z') / 1000;
  const bump = () => { clock += 10; fs.utimesSync(file(), clock, clock); };

  it('初回は全部読み、readHistoryIndex と同じ結果を返す', () => {
    fresh();
    fs.writeFileSync(file(), rec('s1', 1, 'a') + rec('s2', 2, 'b') + rec('s1', 3, 'c', '/w/b'));
    const r = new HistoryIndexReader(dir);
    expect(r.read().index).toEqual(readHistoryIndex(dir));
  });

  it('大きさも更新時刻も変わらなければ読まず、版も変えない', () => {
    fresh();
    fs.writeFileSync(file(), rec('s1', 1, 'a'));
    const r = new HistoryIndexReader(dir);
    const first = r.read();
    const readFile = vi.spyOn(fs, 'readFileSync');
    const open = vi.spyOn(fs, 'openSync');
    const second = r.read();
    expect(readFile).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(second.version).toBe(first.version);
    expect(second.index).toBe(first.index);
  });

  it('追記なら増えた分だけ読む', () => {
    fresh();
    const head = rec('s1', 1, 'a').repeat(200);
    fs.writeFileSync(file(), head);
    const r = new HistoryIndexReader(dir);
    const first = r.read();
    const added = rec('s2', 5, 'b') + rec('s1', 6, 'c');
    fs.appendFileSync(file(), added);
    bump();
    const readFile = vi.spyOn(fs, 'readFileSync');
    const readSync = vi.spyOn(fs, 'readSync');
    const next = r.read();
    expect(readFile).not.toHaveBeenCalled();
    const bytes = readSync.mock.results.reduce((n, x) => n + (x.value as number), 0);
    // 継ぎ目の確かめに前の末尾を少しだけ読み直す。それでも頭からは読まない。
    expect(bytes).toBeLessThan(Buffer.byteLength(added) + 100);
    expect(next.version).not.toBe(first.version);
    expect(next.index).toEqual(readHistoryIndex(dir));
    expect(next.index.get('s1')?.count).toBe(201);
  });

  it('末尾の行が書きかけなら、続きが来たときに 1 度だけ数える', () => {
    fresh();
    fs.writeFileSync(file(), rec('s1', 1, 'a'));
    const r = new HistoryIndexReader(dir);
    r.read();
    const line = rec('s1', 2, 'b');
    fs.appendFileSync(file(), line.slice(0, 20));
    bump();
    expect(r.read().index).toEqual(readHistoryIndex(dir));
    fs.appendFileSync(file(), line.slice(20));
    bump();
    const done = r.read().index;
    expect(done).toEqual(readHistoryIndex(dir));
    expect(done.get('s1')?.count).toBe(2);
  });

  it('改行の無い最後の行も readHistoryIndex と同じく数え、続きの行と二重にしない', () => {
    fresh();
    fs.writeFileSync(file(), rec('s1', 1, 'a') + rec('s1', 2, 'b').trimEnd());
    const r = new HistoryIndexReader(dir);
    expect(r.read().index).toEqual(readHistoryIndex(dir));
    fs.appendFileSync(file(), '\n' + rec('s1', 3, 'c'));
    bump();
    const next = r.read().index;
    expect(next).toEqual(readHistoryIndex(dir));
    expect(next.get('s1')?.count).toBe(3);
  });

  it('切り詰められたら全部読み直す', () => {
    fresh();
    fs.writeFileSync(file(), rec('s1', 1, 'a') + rec('s2', 2, 'b'));
    const r = new HistoryIndexReader(dir);
    const first = r.read();
    fs.writeFileSync(file(), rec('s3', 3, 'c'));
    bump();
    const next = r.read();
    expect(next.version).not.toBe(first.version);
    expect(next.index).toEqual(readHistoryIndex(dir));
    expect([...next.index.keys()]).toEqual(['s3']);
  });

  it('同じ場所で書き直されて大きくなったら、追記と取り違えずに全部読み直す', () => {
    fresh();
    fs.writeFileSync(file(), rec('s1', 1, 'a') + rec('s2', 2, 'b'));
    const r = new HistoryIndexReader(dir);
    r.read();
    // 頭の行が変わり、全体は大きくなる。
    fs.writeFileSync(file(), rec('s9', 9, 'zzzz') + rec('s2', 2, 'b') + rec('s4', 4, 'd'));
    bump();
    const next = r.read();
    expect(next.index).toEqual(readHistoryIndex(dir));
    expect(next.index.has('s1')).toBe(false);
  });

  it('同じ大きさで差し替えられても読み直す', () => {
    fresh();
    fs.writeFileSync(file(), rec('s1', 1, 'a'));
    const r = new HistoryIndexReader(dir);
    r.read();
    const other = path.join(dir, 'history.tmp');
    fs.writeFileSync(other, rec('s2', 1, 'a'));
    fs.renameSync(other, file());
    bump();
    expect([...r.read().index.keys()]).toEqual(['s2']);
  });

  it('ファイルが消えたら空になる', () => {
    fresh();
    fs.writeFileSync(file(), rec('s1', 1, 'a'));
    const r = new HistoryIndexReader(dir);
    const first = r.read();
    fs.rmSync(file());
    const next = r.read();
    expect(next.index.size).toBe(0);
    expect(next.version).not.toBe(first.version);
    expect(r.read().version).toBe(next.version);
  });
});
