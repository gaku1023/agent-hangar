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
    expect(r.candidates).toEqual([
      { path: notes, sessionCount: 6, lastActivityAt: 300, worktreeCount: 1 },
      { path: api, sessionCount: 2, lastActivityAt: 900, worktreeCount: 0 },
    ]);
  });
  it('git の外のフォルダは、そのフォルダのまま候補にする', () => {
    const plain = mk(home, 'work', 'report');
    talk(plain, 1, 5);
    expect(folderCandidates(db, DEV, env()).candidates).toEqual([{ path: plain, sessionCount: 1, lastActivityAt: 5, worktreeCount: 0 }]);
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
