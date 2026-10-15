import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { folderCandidates, type CandidateEnv } from './candidates.ts';
import { scratchRoot } from './scratch.ts';

// 初日のプロジェクト（2026-10-13）。Claude Code と会話したフォルダを、git の根でまとめて候補にする。
let tmp: string;
let home: string;
let hangar: string;
let db: Db;
const DEV = 'dev-1';
let n = 0;
function talk(cwd: string, count = 1, at = 1000, device = DEV, projectId: string | null = null) {
  for (let i = 0; i < count; i++) {
    const id = `s${++n}`;
    upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: id, cwd, home_device: device, project_id: projectId, last_activity_at: at }, DEV);
  }
}
const mk = (...parts: string[]) => { const d = path.join(...parts); fs.mkdirSync(d, { recursive: true }); return d; };
/** .git をフォルダで持つリポジトリ。 */
const repo = (dir: string) => { mk(dir, '.git'); return dir; };
const env = (over: Partial<CandidateEnv> = {}): CandidateEnv => ({ homeDir: home, hangarHome: hangar, tmpDirs: [path.join(tmp, 'tmpdir')], workspaceRoot: '', ...over });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cand-')));
  home = mk(tmp, 'home');
  hangar = mk(home, '.agent-hangar');
  db = openDb(':memory:');
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('folderCandidates', () => {
  it('git の根でまとめ、worktree は元のリポジトリへ寄せて数え、会話の多い順に並べる', () => {
    const notes = repo(mk(home, 'src', 'notes-app'));
    const gitdir = mk(notes, '.git', 'worktrees', 'wt1');
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    const wt = mk(notes, '.claude', 'worktrees', 'wt1');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
    const api = repo(mk(home, 'src', 'api'));
    talk(notes, 2, 100);
    talk(path.join(notes, 'packages'), 1, 300);
    talk(wt, 2, 200);
    talk(path.join(wt, 'src'), 1, 250);
    talk(api, 2, 900);
    const r = folderCandidates(db, DEV, env());
    expect(r.candidates).toMatchObject([
      { path: notes, sessionCount: 6, lastActivityAt: 300, worktreeCount: 1 },
      { path: api, sessionCount: 2, lastActivityAt: 900, worktreeCount: 0 },
    ]);
  });
  it('git の外のフォルダは、そのフォルダのまま候補にする', () => {
    const plain = mk(home, 'work', 'report');
    talk(plain, 1, 5);
    expect(folderCandidates(db, DEV, env()).candidates).toMatchObject([{ path: plain, sessionCount: 1, lastActivityAt: 5, worktreeCount: 0 }]);
  });
  it('ホームフォルダとその上、一時フォルダ、スクラッチ、隠しの名前を含むもの、無いフォルダは除く', () => {
    talk(home, 3);
    talk(tmp, 3);
    talk(mk(tmp, 'tmpdir', 'x'), 3);
    talk(mk(scratchRoot(hangar), '2026-10-13-1'), 3);
    talk(mk(home, '.config', 'thing'), 3);
    talk(path.join(home, 'gone'), 3);
    const kept = mk(home, 'kept');
    talk(kept, 1);
    expect(folderCandidates(db, DEV, env()).candidates.map((c) => c.path)).toEqual([kept]);
  });
  it('作成場所そのものとその上は、登録できないので候補にしない（2026-10-15）', () => {
    const ws = mk(home, 'ws');
    talk(ws, 3);
    talk(mk(home, 'ws-parent-sibling'), 1);
    const outer = mk(tmp, 'outer');
    const inner = mk(outer, 'root');
    talk(outer, 2);
    expect(folderCandidates(db, DEV, env({ workspaceRoot: ws })).candidates.map((c) => c.path)).toEqual([outer, path.join(home, 'ws-parent-sibling')]);
    expect(folderCandidates(db, DEV, env({ workspaceRoot: inner })).candidates.map((c) => c.path)).not.toContain(outer);
  });
  it('ホームフォルダを git で管理していても、ホームへはまとめない', () => {
    repo(home);
    const a = mk(home, 'a');
    talk(a, 1);
    expect(folderCandidates(db, DEV, env()).candidates.map((c) => c.path)).toEqual([a]);
  });
  it('プロジェクトに入った会話、ほかの PC の会話、登録済みの場所とその下は数えない', () => {
    const done = mk(home, 'done');
    upsertShared(db, 'projects', { id: 'p1', name: 'done', status: 'active', is_scratch: 0 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: DEV, path: done, resolved: 0 }, DEV);
    talk(path.join(done, 'sub'), 2);
    const other = mk(home, 'other');
    talk(other, 2, 1, 'dev-2');
    talk(other, 2, 1, DEV, 'p1');
    expect(folderCandidates(db, DEV, env()).candidates).toEqual([]);
  });
  it('作成場所が空で、過半（2 件以上）が同じ親にあるときだけ、その親を作成場所の候補にする', () => {
    const src = mk(home, 'src');
    for (const name of ['a', 'b', 'c']) talk(mk(src, name), 1);
    talk(mk(home, 'work', 'x'), 1);
    expect(folderCandidates(db, DEV, env()).suggestedRoot).toBe(src);
    expect(folderCandidates(db, DEV, env({ workspaceRoot: path.join(home, 'workspace') })).suggestedRoot).toBeNull();
  });
  it('同じ親が半分以下か 1 件だけ、または親がホームフォルダなら、作成場所の候補を出さない', () => {
    talk(mk(home, 'src', 'a'), 1);
    talk(mk(home, 'work', 'b'), 1);
    expect(folderCandidates(db, DEV, env()).suggestedRoot).toBeNull();
    fs.rmSync(path.join(home, 'work'), { recursive: true });
    expect(folderCandidates(db, DEV, env()).suggestedRoot).toBeNull();
    talk(mk(home, 'p'), 1);
    talk(mk(home, 'q'), 1);
    talk(mk(home, 'r'), 1);
    expect(folderCandidates(db, DEV, env()).suggestedRoot).toBeNull();
  });
});

// セットアップのすゝめ（2026-10-15）。
// hangar project candidates が読む項目。
// 初日の画面の項目は変えずに足す。
describe('folderCandidates の足した項目', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1000 * DAY;
  const noCloud = { platform: 'linux' as NodeJS.Platform, homeDir: '', env: {}, exists: () => false, realpath: (p: string) => p };
  const env2 = (over: Partial<CandidateEnv> = {}) => env({ now: NOW, cloud: noCloud, ...over });
  const titled = (cwd: string, id: string, at: number, cols: Record<string, unknown>) =>
    upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: id, cwd, home_device: DEV, project_id: null, last_activity_at: at, ...cols }, DEV);
  const summary = (sessionId: string, oneLiner: string) => upsertShared(db, 'session_summaries', {
    session_id: sessionId, title: 'x', one_liner: oneLiner, body: '', state: 'done', next_steps: '[]', source: 'post_hoc', based_on_turns: 1,
  }, DEV, 'session_id');

  it('最近の会話の題を新しい順に 3 件まで添える。題が無ければ要約の 1 文、無ければ最初の発言の冒頭', () => {
    const app = mk(home, 'src', 'app');
    titled(app, 'a1', NOW - 5, { custom_title: '題名の付いた会話' });
    titled(app, 'a2', NOW - 4, { first_prompt: '最初の発言\nの冒頭がここに入る。とても長い発言は四十字で切られることになっていて、その先は出さない' });
    titled(app, 'a3', NOW - 3, { ai_title: 'AI の題' });
    titled(app, 'a4', NOW - 2, {});
    summary('a4', '要約の 1 文');
    titled(app, 'a5', NOW - 9, { custom_title: '古いので出ない' });
    const [c] = folderCandidates(db, DEV, env2()).candidates;
    expect(c!.recentTitles).toEqual(['要約の 1 文', 'AI の題', '最初の発言 の冒頭がここに入る。とても長い発言は四十字で切られることになっていて']);
  });
  it('題の無い会話は飛ばし、本文の題は hangar で付けた名前より先に採る', () => {
    const app = mk(home, 'src', 'app');
    titled(app, 'b1', NOW - 1, {});
    titled(app, 'b2', NOW - 2, { custom_title: '本文の題' });
    upsertShared(db, 'session_notes', { session_id: 'b2', name: 'hangar の名前' }, DEV, 'session_id');
    titled(app, 'b3', NOW - 3, {});
    upsertShared(db, 'session_notes', { session_id: 'b3', name: 'hangar の名前' }, DEV, 'session_id');
    expect(folderCandidates(db, DEV, env2()).candidates[0]!.recentTitles).toEqual(['本文の題', 'hangar の名前']);
  });
  it('リポジトリかと remote を添える。リポジトリでなければ not-git の注記が付く', () => {
    const r = repo(mk(home, 'src', 'r'));
    fs.writeFileSync(path.join(r, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:someone/example.git\n');
    const plain = mk(home, 'src', 'plain');
    talk(r, 2, NOW - 1);
    talk(plain, 2, NOW - 2);
    const out = folderCandidates(db, DEV, env2()).candidates;
    expect(out.find((c) => c.path === r)).toMatchObject({ isGit: true, gitRemote: 'github.com/someone/example', notes: [] });
    expect(out.find((c) => c.path === plain)).toMatchObject({ isGit: false, gitRemote: null, notes: ['not-git'] });
  });
  it('ほかの候補の下にあれば enclosedBy にいちばん深い候補を入れる', () => {
    const work = mk(home, 'work');
    const mid = mk(work, 'mid');
    const leaf = mk(mid, 'leaf');
    talk(work, 2, NOW - 1);
    talk(mid, 2, NOW - 1);
    talk(leaf, 2, NOW - 1);
    const out = folderCandidates(db, DEV, env2()).candidates;
    expect(out.find((c) => c.path === work)!.enclosedBy).toBeNull();
    expect(out.find((c) => c.path === mid)!.enclosedBy).toEqual({ kind: 'candidate', path: work });
    expect(out.find((c) => c.path === leaf)!.enclosedBy).toEqual({ kind: 'candidate', path: mid });
  });
  it('クラウドの同期と、デスクトップの直下、古さ、会話 1 件の注記を添える', () => {
    const desk = repo(mk(home, 'Desktop', 'thing'));
    talk(desk, 1, NOW - 31 * DAY);
    const cloud = { platform: 'darwin' as NodeJS.Platform, homeDir: home, env: {}, exists: (p: string) => p === path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Desktop'), realpath: (p: string) => p };
    const [c] = folderCandidates(db, DEV, env2({ cloud })).candidates;
    expect(c).toMatchObject({ path: desk, cloudSynced: 'icloud', notes: ['desktop-direct', 'stale-30d', 'single-session'] });
  });
  it('上の段に、この PC の未分類の会話の総数と、いまの作成場所を添える', () => {
    talk(mk(home, 'a'), 2);
    talk(home, 3);
    talk(mk(home, 'b'), 1, 1, 'dev-2');
    upsertShared(db, 'projects', { id: 'p1', name: 'p', status: 'active', is_scratch: 0 }, DEV);
    talk(mk(home, 'c'), 4, 1, DEV, 'p1');
    expect(folderCandidates(db, DEV, env2())).toMatchObject({ unassignedTotal: 5, workspaceRoot: null });
    expect(folderCandidates(db, DEV, env2({ workspaceRoot: path.join(home, 'ws') })).workspaceRoot).toBe(path.join(home, 'ws'));
  });
});
