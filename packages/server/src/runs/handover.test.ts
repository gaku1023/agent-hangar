import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { deviceOfSession, handoverFacts, projectDeviceCount, resumeCwd, resumeHerePlan, resumeTarget, scratchFolderName } from './handover.ts';

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
  it('移した会話は、移した先ではなく、cwd を含む場所を持つプロジェクトの場所で読み替える', () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-handover-moved-')));
    try {
      fs.mkdirSync(path.join(here, 'src'), { recursive: true });
      upsertShared(db, 'projects', { id: 'p2', name: 'docs', status: 'active', is_scratch: 0 }, 'me');
      upsertShared(db, 'project_roots', { id: 'r2-me', project_id: 'p2', device_id: 'me', path: other, resolved: 1 }, 'me');
      const id = session({ cwd: 'D:\\src\\notes-app\\src', project: 'p2' });
      upsertShared(db, 'session_states', { session_id: id, project_id: 'p2' }, 'me', 'session_id');
      expect(resumeCwd(db, 'me', { id, cwd: 'D:\\src\\notes-app\\src', project_id: 'p2' })).toBe(path.join(here, 'src'));
      // cwd を含む場所を持つプロジェクトが無ければ、移した先の場所には倒さない。
      expect(resumeCwd(db, 'me', { id, cwd: 'E:\\elsewhere', project_id: 'p2' })).toBeNull();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
  it('移していない会話は、cwd を含む別のプロジェクトにこの PC の場所が無ければ、所属するプロジェクトの場所で起こす', () => {
    // 所属（p1）の場所は cwd を含まない。cwd を含む H には、この PC の場所が無い。
    upsertShared(db, 'projects', { id: 'h', name: 'work', status: 'active', is_scratch: 0 }, 'win');
    upsertShared(db, 'project_roots', { id: 'rh-win', project_id: 'h', device_id: 'win', path: 'E:\\work', resolved: 1 }, 'win');
    const id = session({ cwd: 'E:\\work\\x', project: 'p1' });
    expect(resumeCwd(db, 'me', { id, cwd: 'E:\\work\\x', project_id: 'p1' })).toBe(here);
    expect(resumeCwd(db, 'me', { cwd: 'E:\\work\\x', project_id: 'p1' })).toBe(here);
  });
  it('移した先のプロジェクトが一覧から消えていれば、移した印は無いものとして読む（移していない会話と同じに倒す）', () => {
    upsertShared(db, 'projects', { id: 'gone', name: 'gone', status: 'active', is_scratch: 0 }, 'me');
    db.prepare("update projects set deleted_at = 9 where id = 'gone'").run();
    const id = session({ cwd: 'E:\\elsewhere', project: 'p1' });
    upsertShared(db, 'session_states', { session_id: id, project_id: 'gone' }, 'me', 'session_id');
    expect(resumeCwd(db, 'me', { id, cwd: 'E:\\elsewhere', project_id: 'p1' })).toBe(here);
  });
  it('移した先が親のワークスペースでも、cwd を含む場所のうちいちばん深いプロジェクトで読み替える', () => {
    // p2 は親のワークスペースで、どの PC の場所も cwd を含む。本来のプロジェクト p1 の場所のほうが深い。
    fs.mkdirSync(path.join(here, 'src'), { recursive: true });
    upsertShared(db, 'projects', { id: 'p2', name: 'workspace', status: 'active', is_scratch: 0 }, 'me');
    upsertShared(db, 'project_roots', { id: 'r2-me', project_id: 'p2', device_id: 'me', path: path.dirname(here), resolved: 1 }, 'me');
    upsertShared(db, 'project_roots', { id: 'r2-win', project_id: 'p2', device_id: 'win', path: 'D:\\src', resolved: 1 }, 'win');
    const id = session({ cwd: 'D:\\src\\notes-app\\src', project: 'p2' });
    upsertShared(db, 'session_states', { session_id: id, project_id: 'p2' }, 'me', 'session_id');
    expect(resumeCwd(db, 'me', { id, cwd: 'D:\\src\\notes-app\\src', project_id: 'p2' })).toBe(path.join(here, 'src'));
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

describe('前の PC の作業ディレクトリ（A → B → A）', () => {
  it('この PC で作った会話をほかの PC で進めて戻ったとき、前の PC のパスはその PC のプロジェクトの場所にする（sessions.cwd はこの PC のもの）', () => {
    const id = session({ cwd: here, home: 'me', lastAt: 50 });
    run(id, 'me', 1);
    run(id, 'win', 2);
    expect(handoverFacts(db, { sessionId: id, selfDeviceId: 'me', cwd: here })?.prevPath).toBe('D:\\src\\notes-app');
    expect(resumeHerePlan(db, 'me', id)?.from.path).toBe('D:\\src\\notes-app');
  });
  it('前の PC の写しの末尾の cwd が、その PC のプロジェクトの場所の下にあれば、それを使う（worktree も）', () => {
    const id = session({ cwd: here, home: 'me' });
    run(id, 'me', 1);
    run(id, 'win', 2);
    const wt = 'D:\\src\\notes-app\\.claude\\worktrees\\fix';
    const file = path.join(here, 'win-copy.jsonl');
    fs.writeFileSync(file, [JSON.stringify({ type: 'user', cwd: here }), JSON.stringify({ type: 'assistant', cwd: wt })].join('\n') + '\n');
    db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version, device_id) values (?,?,?,?,?,?,?,?)').run(file, id, null, 1, 1, 1, 1, 'win');
    expect(handoverFacts(db, { sessionId: id, selfDeviceId: 'me', cwd: here })?.prevPath).toBe(wt);
    expect(resumeHerePlan(db, 'me', id)?.from.path).toBe(wt);
    // 末尾の cwd がその PC の場所の外（ほかの PC のパス）なら、使わずに場所に倒す。
    fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: here }) + '\n');
    expect(handoverFacts(db, { sessionId: id, selfDeviceId: 'me', cwd: here })?.prevPath).toBe('D:\\src\\notes-app');
  });
  it('前の PC が会話を作った PC なら、run が作業ディレクトリを持たなくても sessions.cwd を使う', () => {
    const id = session({ cwd: 'D:\\src\\notes-app\\sub', home: 'win' });
    run(id, 'win', 1);
    expect(handoverFacts(db, { sessionId: id, selfDeviceId: 'me', cwd: here })?.prevPath).toBe('D:\\src\\notes-app\\sub');
  });
  it('前の PC の場所も run の作業ディレクトリも分からなければ、sessions.cwd に倒す', () => {
    const id = session({ cwd: here, home: 'me' });
    run(id, 'mac2', 2);
    expect(handoverFacts(db, { sessionId: id, selfDeviceId: 'me', cwd: here })?.prevPath).toBe(here);
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
      to: { deviceName: 'this-mac', platform: 'darwin', path: here, createsFolder: false },
      replace: null,
    });
  });
  it('手元のトランスクリプトを置き換えるときは、その種類と大きさを添える', () => {
    const id = session({ cwd: 'D:\\src\\notes-app', lastAt: 99 });
    run(id, 'win', 3);
    const replace = { kind: 'diverged' as const, localSize: 5, remoteSize: 9 };
    expect(resumeHerePlan(db, 'me', id, { replace: () => replace })?.replace).toEqual(replace);
  });
  it('この PC で場所が決まらなければ、この PC のパスは null', () => {
    db.prepare("update project_roots set deleted_at = 5 where id = 'r-me'").run();
    const id = session({ cwd: 'D:\\src\\notes-app' });
    expect(resumeHerePlan(db, 'me', id)?.to.path).toBeNull();
    expect(resumeHerePlan(db, 'me', 'nope')).toBeNull();
  });
});

describe('ほかの PC のクイックセッションの再開', () => {
  let quick: string;
  beforeEach(() => {
    quick = path.join(here, 'quick-sessions');
    fs.mkdirSync(quick);
    upsertShared(db, 'projects', { id: 'q', name: 'スクラッチ', status: 'active', is_scratch: 1 }, 'me');
    upsertShared(db, 'project_roots', { id: 'rq-me', project_id: 'q', device_id: 'me', path: quick, resolved: 1 }, 'me');
    upsertShared(db, 'project_roots', { id: 'rq-win', project_id: 'q', device_id: 'win', path: 'C:\\Users\\x\\.agent-hangar\\quick-sessions', resolved: 1 }, 'win');
    upsertShared(db, 'project_roots', { id: 'rq-mac2', project_id: 'q', device_id: 'mac2', path: '/Users/o/.agent-hangar/scratch', resolved: 1 }, 'mac2');
  });

  it('cwd がこの PC に無ければ、この PC の quick-sessions/<元のフォルダ名> を作る先にする（Windows の区切りも）', () => {
    expect(resumeTarget(db, 'me', { cwd: 'C:\\Users\\x\\.agent-hangar\\quick-sessions\\20261016-101010', project_id: 'q' })).toEqual({ path: path.join(quick, '20261016-101010'), createsFolder: true });
    expect(resumeTarget(db, 'me', { cwd: '/Users/o/.agent-hangar/scratch/20260901-090000', project_id: 'q' })).toEqual({ path: path.join(quick, '20260901-090000'), createsFolder: true });
    // 下位のフォルダで動いていた会話も、元のクイックセッションのフォルダの名前を使う。
    expect(resumeTarget(db, 'me', { cwd: 'C:\\Users\\x\\.agent-hangar\\quick-sessions\\20261016-101010\\sub', project_id: 'q' })?.path).toBe(path.join(quick, '20261016-101010'));
    // 前の置き場（scratch）の下でも、その PC の場所が quick-sessions に替わった後でも読める。
    expect(resumeTarget(db, 'me', { cwd: 'C:\\Users\\x\\.agent-hangar\\scratch\\20250101-000000', project_id: 'q' })?.path).toBe(path.join(quick, '20250101-000000'));
    // 見積もりだけで、フォルダは作らない。
    expect(fs.readdirSync(quick)).toEqual([]);
    // resumeCwd も同じ先を返す。
    expect(resumeCwd(db, 'me', { cwd: '/Users/o/.agent-hangar/scratch/20260901-090000', project_id: 'q' })).toBe(path.join(quick, '20260901-090000'));
  });

  it('同名のフォルダがすでにあれば、それを使い、作らない', () => {
    fs.mkdirSync(path.join(quick, '20261016-101010'));
    expect(resumeTarget(db, 'me', { cwd: 'C:\\Users\\x\\.agent-hangar\\quick-sessions\\20261016-101010', project_id: 'q' })).toEqual({ path: path.join(quick, '20261016-101010'), createsFolder: false });
  });

  it('cwd がこの PC にあれば、前の置き場（scratch）の下でもそのまま使う', () => {
    const legacy = path.join(here, 'scratch', '20260901-090000');
    fs.mkdirSync(legacy, { recursive: true });
    expect(resumeTarget(db, 'me', { cwd: legacy, project_id: 'q' })).toEqual({ path: legacy, createsFolder: false });
  });

  it('まとめる前の、別のスクラッチのプロジェクトに属していても、この PC のクイックセッションの場所で読み替える', () => {
    upsertShared(db, 'projects', { id: 'q-win', name: 'スクラッチ', status: 'active', is_scratch: 1 }, 'win');
    expect(resumeTarget(db, 'me', { cwd: 'C:\\Users\\x\\.agent-hangar\\quick-sessions\\20261016-101010', project_id: 'q-win' })?.path).toBe(path.join(quick, '20261016-101010'));
  });

  it('クイックセッションへ移した普通の会話は、普通の読み替えにする（クイックの分岐は所属でなく cwd で決める）', () => {
    fs.mkdirSync(path.join(here, 'src'), { recursive: true });
    const id = session({ cwd: 'D:\\src\\notes-app\\src', project: 'q' });
    upsertShared(db, 'session_states', { session_id: id, project_id: 'q' }, 'me', 'session_id');
    expect(resumeTarget(db, 'me', { id, cwd: 'D:\\src\\notes-app\\src', project_id: 'q' })).toEqual({ path: path.join(here, 'src'), createsFolder: false });
    expect(resumeHerePlan(db, 'me', id)?.to.path).toBe(path.join(here, 'src'));
    // cwd を含む場所を持つプロジェクトが無ければ、移した先（クイックセッションの置き場）には倒さない。
    expect(resumeTarget(db, 'me', { id, cwd: 'E:\\elsewhere', project_id: 'q' })).toBeNull();
  });

  it('普通のプロジェクトへ移したクイックセッションの会話は、クイックの分岐で読み替える', () => {
    const id = session({ cwd: 'C:\\Users\\x\\.agent-hangar\\quick-sessions\\20261016-101010', project: 'p1' });
    upsertShared(db, 'session_states', { session_id: id, project_id: 'p1' }, 'me', 'session_id');
    expect(resumeTarget(db, 'me', { id, cwd: 'C:\\Users\\x\\.agent-hangar\\quick-sessions\\20261016-101010', project_id: 'p1' })).toEqual({ path: path.join(quick, '20261016-101010'), createsFolder: true });
  });

  it('再開の確認は、作って再開するフォルダのパスと、作ることを返す', () => {
    const id = session({ cwd: 'C:\\Users\\x\\.agent-hangar\\quick-sessions\\20261016-101010', project: 'q' });
    run(id, 'win', 3);
    expect(resumeHerePlan(db, 'me', id)?.to).toEqual({ deviceName: 'this-mac', platform: 'darwin', path: path.join(quick, '20261016-101010'), createsFolder: true });
    expect(fs.existsSync(path.join(quick, '20261016-101010'))).toBe(false);
  });

  it('置き場の外の cwd と、置き場そのものの cwd は、フォルダを作らず場所が無い（null）にする', () => {
    for (const cwd of [
      'E:\\odd\\place\\20261016-111111',
      'C:\\Users\\x\\.agent-hangar\\quick-sessions',
      'C:\\Users\\x\\.agent-hangar\\quick-sessions\\',
      'C:\\Users\\x\\.agent-hangar\\quick-sessions\\.',
      '/Users/o/.agent-hangar/scratch/',
      '/Users/o/.agent-hangar/scratch/..',
      '/Users/o/.agent-hangar/scratch/../elsewhere',
      '/Users/o/.agent-hangar/scratch/C:',
      '',
    ]) {
      expect(resumeTarget(db, 'me', { cwd, project_id: 'q' }), cwd).toBeNull();
    }
    expect(fs.readdirSync(quick)).toEqual([]);
  });

  it('読み替えは、所属ではなく cwd がどれかの PC の置き場の下にあるかで決める', () => {
    // クイックセッションから普通のプロジェクトへ移した会話も、置き場の下の cwd ならこの PC の quick-sessions で再開する。
    expect(resumeTarget(db, 'me', { cwd: 'C:\\Users\\x\\.agent-hangar\\quick-sessions\\20261016-101010', project_id: 'p1' })).toEqual({ path: path.join(quick, '20261016-101010'), createsFolder: true });
    // クイックセッションへ移した普通の会話は、置き場の下ではないので、quick-sessions の下にも置き場そのものにも読み替えない。
    // cwd を含む場所を持つプロジェクト（p1）の、この PC の場所で読み替える（下位のフォルダが無ければ場所そのもの）。
    expect(resumeTarget(db, 'me', { cwd: 'D:\\src\\notes-app\\sub', project_id: 'q' })).toEqual({ path: here, createsFolder: false });
    // 普通のプロジェクトの会話は、今までどおりそのプロジェクトの場所で読み替える。
    expect(resumeTarget(db, 'me', { cwd: 'D:\\src\\notes-app', project_id: 'p1' })).toEqual({ path: here, createsFolder: false });
  });

  it('元のフォルダ名の Windows で使えない文字は _ に置き換える', () => {
    expect(resumeTarget(db, 'me', { cwd: '/Users/o/.agent-hangar/scratch/a<b>c:d"e|f?g*h', project_id: 'q' })?.path).toBe(path.join(quick, 'a_b_c_d_e_f_g_h'));
    expect(resumeTarget(db, 'me', { cwd: '/Users/o/.agent-hangar/scratch/tab\there\u0001/sub', project_id: 'q' })?.path).toBe(path.join(quick, 'tab_here_'));
    expect(resumeTarget(db, 'me', { cwd: '/Users/o/.agent-hangar/scratch/name. .', project_id: 'q' })?.path).toBe(path.join(quick, 'name___'));
  });

  it('scratchFolderName は、空、. と ..、ドライブ文字だけの段を断り、Windows で使えない文字を _ にする', () => {
    for (const bad of [undefined, '', '.', '..', 'C:', 'z:']) expect(scratchFolderName(bad), String(bad)).toBeNull();
    expect(scratchFolderName('20261016-101010')).toBe('20261016-101010');
    expect(scratchFolderName('a:b')).toBe('a_b');
    expect(scratchFolderName('...')).toBe('___');
    expect(scratchFolderName('x ')).toBe('x_');
    expect(scratchFolderName('q?')).toBe('q_');
  });

  it('利用者が自分で作った scratch という名前のフォルダの会話は、クイックセッションの読み替えをしない', () => {
    upsertShared(db, 'projects', { id: 'own', name: 'scratch', status: 'active', is_scratch: 0 }, 'win');
    upsertShared(db, 'project_roots', { id: 'r-own', project_id: 'own', device_id: 'win', path: 'D:\\work\\scratch', resolved: 1 }, 'win');
    expect(resumeTarget(db, 'me', { cwd: 'D:\\work\\scratch\\notes', project_id: 'own' })).toBeNull();
  });
});
