import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { deviceOfSession, handoverFacts, projectDeviceCount, resumeCwd, resumeHerePlan } from './handover.ts';

let db: Db;
let here: string;

beforeEach(() => {
  db = openDb(':memory:');
  here = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-handover-')));
  upsertShared(db, 'devices', { id: 'me', name: 'this-mac', platform: 'darwin', last_seen_at: 1 }, 'me');
  upsertShared(db, 'devices', { id: 'win', name: 'work-pc', platform: 'win32', last_seen_at: 1 }, 'win');
  upsertShared(db, 'devices', { id: 'mac2', name: 'old-mac', platform: 'darwin', last_seen_at: 1 }, 'mac2');
  upsertShared(db, 'projects', { id: 'p1', name: 'notes-app', status: 'active', is_scratch: 0 }, 'me');
  upsertShared(db, 'project_roots', { id: 'r-me', project_id: 'p1', device_id: 'me', path: here, resolved: 1 }, 'me');
  upsertShared(db, 'project_roots', { id: 'r-win', project_id: 'p1', device_id: 'win', path: 'D:\\src\\notes-app', resolved: 1 }, 'win');
});
afterEach(() => {
  db.close();
  fs.rmSync(here, { recursive: true, force: true });
});

const session = (o: { id?: string; cwd: string; home?: string; project?: string | null; lastAt?: number }) => {
  const id = o.id ?? 's1';
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: `u-${id}`, cwd: o.cwd, home_device: o.home ?? 'win', project_id: o.project === undefined ? 'p1' : o.project, last_activity_at: o.lastAt ?? null }, 'win');
  return id;
};
const run = (sessionId: string, device: string, startedAt: number) =>
  upsertShared(db, 'runs', { id: `run-${device}-${startedAt}`, session_id: sessionId, device_id: device, kind: 'resume', tmux_name: 'x', pid: null, launch_params: '{}', started_at: startedAt, ended_at: startedAt + 1, end_reason: 'exited', heartbeat_at: startedAt }, device);
let seq = 0;
const edit = (sessionId: string, file: string, tool = 'Edit') =>
  db.prepare('insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref, tool_name, file_path) values (?,?,?,?,?,?,?,?,?)').run(sessionId, ++seq, 'tool_call', 1, 0, 1, 'f', tool, file);

describe('resumeCwd（再開とフォークの作業ディレクトリ）', () => {
  it('前の cwd がこの PC にあれば、そのまま使う', () => {
    expect(resumeCwd(db, 'me', { cwd: here, project_id: 'p1' })).toBe(here);
  });
  it('Windows の前の cwd を、この PC のプロジェクトの場所からの相対に読み替える（下位のフォルダも継ぐ）', () => {
    fs.mkdirSync(path.join(here, 'src', 'ui'), { recursive: true });
    expect(resumeCwd(db, 'me', { cwd: 'D:\\src\\notes-app', project_id: 'p1' })).toBe(here);
    expect(resumeCwd(db, 'me', { cwd: 'D:\\src\\notes-app\\src\\ui', project_id: 'p1' })).toBe(path.join(here, 'src', 'ui'));
  });
  it('Windows のパスは大文字と小文字を区別せず、/ の区切りでも読む', () => {
    fs.mkdirSync(path.join(here, 'src'), { recursive: true });
    expect(resumeCwd(db, 'me', { cwd: 'd:/SRC/Notes-App/src', project_id: 'p1' })).toBe(path.join(here, 'src'));
  });
  it('macOS の前の cwd も読み替える。worktree がこの PC に無ければ、いちばん近いある親（場所まで）に倒す', () => {
    upsertShared(db, 'project_roots', { id: 'r-mac2', project_id: 'p1', device_id: 'mac2', path: '/Users/someone/src/notes-app', resolved: 1 }, 'mac2');
    fs.mkdirSync(path.join(here, '.claude', 'worktrees', 'fix'), { recursive: true });
    expect(resumeCwd(db, 'me', { cwd: '/Users/someone/src/notes-app/.claude/worktrees/fix', project_id: 'p1' })).toBe(path.join(here, '.claude', 'worktrees', 'fix'));
    expect(resumeCwd(db, 'me', { cwd: '/Users/someone/src/notes-app/.claude/worktrees/gone', project_id: 'p1' })).toBe(path.join(here, '.claude', 'worktrees'));
  });
  it('前のプロジェクトの場所の外にあった cwd は、この PC のプロジェクトの場所にする', () => {
    expect(resumeCwd(db, 'me', { cwd: 'E:\\elsewhere', project_id: 'p1' })).toBe(here);
  });
  it('この PC に場所が無い、場所が見つからない、プロジェクトに属さない会話は読み替えない（null）', () => {
    expect(resumeCwd(db, 'me', { cwd: 'D:\\src\\notes-app', project_id: null })).toBeNull();
    db.prepare("update project_roots set resolved = 0 where id = 'r-me'").run();
    expect(resumeCwd(db, 'me', { cwd: 'D:\\src\\notes-app', project_id: 'p1' })).toBeNull();
    db.prepare("update project_roots set resolved = 1, deleted_at = 5 where id = 'r-me'").run();
    expect(resumeCwd(db, 'me', { cwd: 'D:\\src\\notes-app', project_id: 'p1' })).toBeNull();
  });
  it('この PC の場所の行があっても、フォルダが消えていれば読み替えない', () => {
    fs.rmSync(here, { recursive: true, force: true });
    expect(resumeCwd(db, 'me', { cwd: 'D:\\src\\notes-app', project_id: 'p1' })).toBeNull();
  });
});

describe('deviceOfSession（会話を最後に動かした PC）', () => {
  it('最後の run の PC、run が無ければ作った PC', () => {
    const id = session({ cwd: 'D:\\src\\notes-app', home: 'mac2' });
    expect(deviceOfSession(db, id)).toEqual({ id: 'mac2', name: 'old-mac', platform: 'darwin' });
    run(id, 'win', 10);
    run(id, 'me', 5);
    expect(deviceOfSession(db, id)).toEqual({ id: 'win', name: 'work-pc', platform: 'win32' });
  });
  it('PC の行が無ければ名前と OS は null', () => {
    const id = session({ cwd: '/x', home: 'ghost' });
    expect(deviceOfSession(db, id)).toEqual({ id: 'ghost', name: null, platform: null });
    expect(deviceOfSession(db, 'nope')).toBeNull();
  });
});

describe('handoverFacts（引き継ぎの事実）', () => {
  it('直前の run がほかの PC なら、前と今の PC、パス、時刻、編集したファイルのうち無いものを集める', () => {
    fs.mkdirSync(path.join(here, 'src'), { recursive: true });
    fs.writeFileSync(path.join(here, 'src', 'kept.ts'), '');
    const id = session({ cwd: 'D:\\src\\notes-app', lastAt: 1234 });
    run(id, 'me', 1);
    run(id, 'win', 2);
    edit(id, 'D:\\src\\notes-app\\src\\kept.ts');
    edit(id, 'D:\\src\\notes-app\\src\\new.ts', 'Write');
    edit(id, 'D:\\src\\notes-app\\src\\new.ts');
    edit(id, 'C:\\Users\\x\\notes.md');
    edit(id, 'D:\\src\\notes-app\\README.md', 'Read');
    const f = handoverFacts(db, { sessionId: id, selfDeviceId: 'me', cwd: here });
    expect(f).toEqual({
      prevDevice: 'work-pc', prevPlatform: 'win32', prevPath: 'D:\\src\\notes-app',
      device: 'this-mac', platform: 'darwin', path: here,
      lastAt: 1234, branch: null,
      editedCount: 3, missing: ['src/new.ts'], missingCount: 1,
    });
  });
  it('run が無ければ作った PC で決める', () => {
    const id = session({ cwd: 'D:\\src\\notes-app', home: 'win' });
    expect(handoverFacts(db, { sessionId: id, selfDeviceId: 'me', cwd: here })?.prevDevice).toBe('work-pc');
    const mine = session({ id: 's2', cwd: here, home: 'me' });
    expect(handoverFacts(db, { sessionId: mine, selfDeviceId: 'me', cwd: here })).toBeNull();
  });
  it('この PC で 1 度動いた後は出さない', () => {
    const id = session({ cwd: 'D:\\src\\notes-app', home: 'win' });
    run(id, 'win', 1);
    run(id, 'me', 2);
    expect(handoverFacts(db, { sessionId: id, selfDeviceId: 'me', cwd: here })).toBeNull();
  });
  it('無いファイルは 10 件までにし、件数は全部を数える', () => {
    const id = session({ cwd: 'D:\\src\\notes-app' });
    for (let i = 0; i < 12; i++) edit(id, `D:\\src\\notes-app\\f${i}.ts`);
    const f = handoverFacts(db, { sessionId: id, selfDeviceId: 'me', cwd: here })!;
    expect(f.editedCount).toBe(12);
    expect(f.missing).toEqual(Array.from({ length: 10 }, (_, i) => `f${i}.ts`));
    expect(f.missingCount).toBe(12);
  });
  it('会話の終わりのブランチを本文の末尾から読む', () => {
    const id = session({ cwd: 'D:\\src\\notes-app' });
    const file = path.join(here, 'u-s1.jsonl');
    fs.writeFileSync(file, [JSON.stringify({ type: 'user', gitBranch: 'main', cwd: 'D:\\src\\notes-app' }), JSON.stringify({ type: 'assistant', gitBranch: 'feature/x', cwd: 'D:\\src\\notes-app' })].join('\n') + '\n');
    db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version, device_id) values (?,?,?,?,?,?,?,?)').run(file, id, null, 1, 1, 1, 1, 'win');
    expect(handoverFacts(db, { sessionId: id, selfDeviceId: 'me', cwd: here })?.branch).toBe('feature/x');
  });
});

describe('projectDeviceCount（プロジェクトを使っている PC の数）', () => {
  it('消していない場所の行を PC ごとに数え、抜けた PC は数えない', () => {
    expect(projectDeviceCount(db, 'p1')).toBe(2);
    upsertShared(db, 'project_roots', { id: 'r-mac2', project_id: 'p1', device_id: 'mac2', path: '/a', resolved: 1 }, 'mac2');
    expect(projectDeviceCount(db, 'p1')).toBe(3);
    db.prepare("update devices set deleted_at = 9 where id = 'mac2'").run();
    expect(projectDeviceCount(db, 'p1')).toBe(2);
    db.prepare("update project_roots set deleted_at = 9 where id = 'r-win'").run();
    expect(projectDeviceCount(db, 'p1')).toBe(1);
  });
});

describe('resumeHerePlan（この PC で再開の確認に出すもの）', () => {
  it('前の PC と最後に使った日時、この PC と読み替えた作業ディレクトリを返す', () => {
    const id = session({ cwd: 'D:\\src\\notes-app', lastAt: 99 });
    run(id, 'win', 3);
    expect(resumeHerePlan(db, 'me', id)).toEqual({
      sessionId: id,
      from: { deviceName: 'work-pc', platform: 'win32', path: 'D:\\src\\notes-app', lastAt: 99 },
      to: { deviceName: 'this-mac', platform: 'darwin', path: here },
    });
  });
  it('この PC で場所が決まらなければ、この PC のパスは null', () => {
    db.prepare("update project_roots set deleted_at = 5 where id = 'r-me'").run();
    const id = session({ cwd: 'D:\\src\\notes-app' });
    expect(resumeHerePlan(db, 'me', id)?.to.path).toBeNull();
    expect(resumeHerePlan(db, 'me', 'nope')).toBeNull();
  });
});
