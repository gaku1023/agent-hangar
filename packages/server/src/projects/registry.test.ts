import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { assignSession, assignSessions, candidateDirs, checkProjectRoots, listWorkspaceDirs, mergeDirection, mergePreview, mergeProjects, registerWorkspaceChildOf, rootConflict, resolvedProjectCount, resolveProject, sameFolderPairs, syncProjectsFromWorkspace, workspaceProjectCount } from './registry.ts';

let ws: string;
let db: Db;
const DEV = 'dev-1';
function addSession(id: string, cwd: string) {
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: id, cwd, home_device: DEV }, DEV);
}
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  for (const d of ['alpha', 'beta', 'alpha-v2', '.hidden']) fs.mkdirSync(path.join(ws, d));
  db = openDb(':memory:');
  addSession('s-alpha', path.join(ws, 'alpha'));
  addSession('s-alpha-sub', path.join(ws, 'alpha', 'src'));
  addSession('s-other', '/somewhere/else');
});
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

const project = (id: string) => db.prepare('select * from projects where id = ?').get(id) as Record<string, unknown>;
const root = (projectId: string) => db.prepare('select * from project_roots where project_id = ? and device_id = ?').get(projectId, DEV) as Record<string, unknown>;
const sessionProject = (id: string) => (db.prepare('select project_id from sessions where id = ?').get(id) as { project_id: string | null }).project_id;

describe('syncProjectsFromWorkspace', () => {
  it('セッションのある直下ディレクトリだけをプロジェクトにする', () => {
    const r = syncProjectsFromWorkspace(db, DEV, ws);
    expect(r.created).toHaveLength(1);
    expect(project(r.created[0]!)).toMatchObject({ name: 'alpha', status: 'active', is_scratch: 0 });
    expect(root(r.created[0]!)).toMatchObject({ path: path.join(ws, 'alpha'), resolved: 1 });
  });
  it('二度呼んでも増えない', () => {
    syncProjectsFromWorkspace(db, DEV, ws);
    expect(syncProjectsFromWorkspace(db, DEV, ws).created).toEqual([]);
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 1 });
  });
  it('ルートが無ければ何もしない', () => {
    expect(syncProjectsFromWorkspace(db, DEV, path.join(ws, 'nope')).created).toEqual([]);
  });
  // macOS は Finder などで作った名前を NFD（ご＝こ＋濁点）で持つことがあり、readdir もその形で返す。
  // 一方 transcript の cwd は NFC で来るので、文字列のまま比べると一致せず、プロジェクトにならない。
  it('ディスク上の名前が NFD でも、NFC の cwd のセッションがあれば NFC のパスで登録する', () => {
    const name = 'ご注文ガイド';
    fs.mkdirSync(path.join(ws, name.normalize('NFD')));
    addSession('s-nfc', path.join(ws, name.normalize('NFC'), 'runs'));
    const r = syncProjectsFromWorkspace(db, DEV, ws);
    const pid = r.created.find((id) => project(id).name === name);
    expect(pid).toBeDefined();
    expect(root(pid!).path).toBe(path.join(ws, name));
    assignSessions(db, DEV);
    expect(sessionProject('s-nfc')).toBe(pid);
    expect(syncProjectsFromWorkspace(db, DEV, ws).created).toEqual([]);
  });
});

describe('assignSessions', () => {
  it('cwd がルート以下のセッションを紐づけ、外のものは未分類のまま', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    expect(assignSessions(db, DEV)).toBe(2);
    expect(sessionProject('s-alpha')).toBe(pid);
    expect(sessionProject('s-alpha-sub')).toBe(pid);
    expect(sessionProject('s-other')).toBeNull();
  });
  // Windows のファイルシステムは大文字小文字を区別しない。Claude が書く cwd とワークスペースの綴りが違っても同じフォルダである。
  it.runIf(process.platform === 'win32')('Windows では、綴りの大文字小文字が違う cwd も紐づける', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    addSession('s-upper', path.join(ws, 'alpha', 'src').toUpperCase());
    assignSessions(db, DEV);
    expect(sessionProject('s-upper')).toBe(pid);
  });
  it('最長一致のルートを選ぶ', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    upsertShared(db, 'projects', { id: 'p-src', name: 'src', status: 'active', is_scratch: 0 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r-src', project_id: 'p-src', device_id: DEV, path: path.join(ws, 'alpha', 'src'), resolved: 1 }, DEV);
    assignSessions(db, DEV);
    expect(sessionProject('s-alpha')).toBe(pid);
    expect(sessionProject('s-alpha-sub')).toBe('p-src');
  });
});

describe('assignSessions の正規化', () => {
  it('ルートが NFD で、cwd が NFC でも紐づける', () => {
    upsertShared(db, 'projects', { id: 'p-nfd', name: 'モデル', status: 'active', is_scratch: 0 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r-nfd', project_id: 'p-nfd', device_id: DEV, path: path.join(ws, 'モデル'.normalize('NFD')), resolved: 1 }, DEV);
    addSession('s-nfc', path.join(ws, 'モデル'.normalize('NFC'), 'src'));
    assignSessions(db, DEV);
    expect(sessionProject('s-nfc')).toBe('p-nfd');
  });
});

describe('assignSession', () => {
  it('1 件だけを紐づけ、最長一致のルートを選ぶ', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    upsertShared(db, 'projects', { id: 'p-src', name: 'src', status: 'active', is_scratch: 0 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r-src', project_id: 'p-src', device_id: DEV, path: path.join(ws, 'alpha', 'src'), resolved: 1 }, DEV);
    expect(assignSession(db, DEV, 's-alpha-sub')).toBe('p-src');
    expect(sessionProject('s-alpha-sub')).toBe('p-src');
    expect(sessionProject('s-alpha')).toBeNull();
    expect(assignSession(db, DEV, 's-alpha')).toBe(pid);
  });
  it('当たるルートが無いか、既に紐づいていれば null', () => {
    syncProjectsFromWorkspace(db, DEV, ws);
    expect(assignSession(db, DEV, 's-other')).toBeNull();
    expect(assignSession(db, DEV, 'いないセッション')).toBeNull();
    assignSession(db, DEV, 's-alpha');
    expect(assignSession(db, DEV, 's-alpha')).toBeNull();
  });
});

describe('checkProjectRoots', () => {
  it('消えたルートを unresolved、戻ったら recovered', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    expect(checkProjectRoots(db, DEV)).toEqual({ unresolved: [], recovered: [] });
    fs.renameSync(path.join(ws, 'alpha'), path.join(ws, 'alpha-moved'));
    expect(checkProjectRoots(db, DEV)).toEqual({ unresolved: [pid], recovered: [] });
    expect(root(pid!).resolved).toBe(0);
    expect(checkProjectRoots(db, DEV)).toEqual({ unresolved: [], recovered: [] });
    fs.renameSync(path.join(ws, 'alpha-moved'), path.join(ws, 'alpha'));
    expect(checkProjectRoots(db, DEV)).toEqual({ unresolved: [], recovered: [pid] });
  });
});

describe('resolveProject', () => {
  it('repoint はパスを変えて再び紐づける', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    assignSessions(db, DEV);
    fs.renameSync(path.join(ws, 'alpha'), path.join(ws, 'alpha-moved'));
    checkProjectRoots(db, DEV);
    addSession('s-moved', path.join(ws, 'alpha-moved'));
    resolveProject(db, DEV, pid!, { kind: 'repoint', path: path.join(ws, 'alpha-moved') });
    expect(root(pid!)).toMatchObject({ path: path.join(ws, 'alpha-moved'), resolved: 1 });
    expect(sessionProject('s-moved')).toBe(pid);
  });
  // 末尾の / や .. が残ると longestMatch の前方一致（cwd === path か cwd.startsWith(path + '/')）が
  // 一件も当たらず、直したつもりのプロジェクトにセッションが永久に紐づかない。
  it('repoint のパスは正規化してから入れる', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    assignSessions(db, DEV);
    fs.renameSync(path.join(ws, 'alpha'), path.join(ws, 'alpha-moved'));
    checkProjectRoots(db, DEV);
    addSession('s-moved', path.join(ws, 'alpha-moved', 'src'));
    resolveProject(db, DEV, pid!, { kind: 'repoint', path: path.join(ws, 'beta', '..', 'alpha-moved') + '/' });
    expect(root(pid!)).toMatchObject({ path: path.join(ws, 'alpha-moved'), resolved: 1 });
    expect(sessionProject('s-moved')).toBe(pid);
  });
  it('archive は status を archived にする', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    resolveProject(db, DEV, pid!, { kind: 'archive' });
    expect(project(pid!).status).toBe('archived');
  });
  it('unlink はプロジェクトとルートを論理削除し、セッションを未分類に戻す', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    assignSessions(db, DEV);
    resolveProject(db, DEV, pid!, { kind: 'unlink' });
    expect(project(pid!).deleted_at).not.toBeNull();
    expect(root(pid!).deleted_at).not.toBeNull();
    expect(sessionProject('s-alpha')).toBeNull();
  });
});

// 他の PC が同じフォルダを別の ID で登録していると、同期で同名のプロジェクトが 2 つ並ぶ。
// 届いた方の場所に、この PC で登録済みのフォルダを選んだら、2 つを 1 つにまとめる。
describe('同じフォルダのプロジェクトをまとめる', () => {
  const OTHER = 'dev-2';
  /** 他の PC で作られ、この PC にはまだ場所の無いプロジェクト。 */
  function addElsewhere(id = 'p-win') {
    upsertShared(db, 'projects', { id, name: 'alpha', status: 'active', is_scratch: 0 }, OTHER);
    upsertShared(db, 'project_roots', { id: `r-${id}`, project_id: id, device_id: OTHER, path: 'D:\\workspace\\alpha', resolved: 1 }, OTHER);
    upsertShared(db, 'sessions', { id: `s-${id}`, provider: 'claude-code', provider_session_id: `s-${id}`, cwd: 'D:\\workspace\\alpha', home_device: OTHER, project_id: id }, OTHER);
  }
  const liveRoots = (projectId: string) => (db.prepare('select device_id, path from project_roots where project_id = ? and deleted_at is null order by device_id').all(projectId) as { device_id: string; path: string }[]);

  it('rootConflict は、この PC で同じフォルダを置き場にしている別のプロジェクトを返す', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    addElsewhere();
    expect(rootConflict(db, DEV, 'p-win', path.join(ws, 'alpha'))).toEqual({ projectId: pid, name: 'alpha' });
    // 自分自身、別のフォルダ、他の PC の置き場は当たらない。
    expect(rootConflict(db, DEV, pid!, path.join(ws, 'alpha'))).toBeNull();
    expect(rootConflict(db, DEV, 'p-win', path.join(ws, 'beta'))).toBeNull();
    expect(rootConflict(db, DEV, pid!, 'D:\\workspace\\alpha')).toBeNull();
  });
  it('rootConflict は、一覧から削除したプロジェクトの置き場を数えない', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    addElsewhere();
    resolveProject(db, DEV, pid!, { kind: 'unlink' });
    expect(rootConflict(db, DEV, 'p-win', path.join(ws, 'alpha'))).toBeNull();
  });
  it('セッション、TODO、成果物を移し、相手の PC のパスを引き継ぎ、まとめた方を論理削除する', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    assignSessions(db, DEV);
    addElsewhere();
    upsertShared(db, 'todos', { id: 't-into', project_id: pid, text: '元からある', done: 0, position: 3 }, DEV);
    upsertShared(db, 'todos', { id: 't-a', project_id: 'p-win', text: 'A', done: 0, position: 0 }, OTHER);
    upsertShared(db, 'todos', { id: 't-b', project_id: 'p-win', text: 'B', done: 0, position: 1 }, OTHER);
    upsertShared(db, 'artifacts', { id: 'a-1', project_id: 'p-win', url: 'https://example.test/a', first_published_at: 1, last_published_at: 1 }, OTHER);
    mergeProjects(db, DEV, 'p-win', pid!);
    expect(sessionProject('s-p-win')).toBe(pid);
    expect(sessionProject('s-alpha')).toBe(pid);
    // 移した TODO は、元からある TODO の後ろに、元の順で並ぶ。
    expect(db.prepare('select id from todos where project_id = ? and deleted_at is null order by position').all(pid)).toEqual([{ id: 't-into' }, { id: 't-a' }, { id: 't-b' }]);
    expect(db.prepare('select project_id from artifacts where id = ?').get('a-1')).toEqual({ project_id: pid });
    expect(liveRoots(pid!)).toEqual([{ device_id: DEV, path: path.join(ws, 'alpha') }, { device_id: OTHER, path: 'D:\\workspace\\alpha' }]);
    expect(project('p-win').deleted_at).not.toBeNull();
    expect(liveRoots('p-win')).toEqual([]);
    expect(project(pid!).deleted_at).toBeNull();
  });
  it('両方が同じ PC に置き場を持つときは、残す方の置き場を保つ', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    addElsewhere();
    // 直す前の版で、届いた方にもこの PC の同じフォルダが結び付いてしまった状態。
    upsertShared(db, 'project_roots', { id: 'r-dup', project_id: 'p-win', device_id: DEV, path: path.join(ws, 'alpha'), resolved: 1 }, DEV);
    mergeProjects(db, DEV, 'p-win', pid!);
    expect(liveRoots(pid!)).toEqual([{ device_id: DEV, path: path.join(ws, 'alpha') }, { device_id: OTHER, path: 'D:\\workspace\\alpha' }]);
    expect(liveRoots('p-win')).toEqual([]);
  });
  it('残す方が相手の PC の置き場を前に消していても、まとめた方の置き場を引き継ぐ', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    addElsewhere();
    upsertShared(db, 'project_roots', { id: 'r-old', project_id: pid, device_id: OTHER, path: 'C:\\old', resolved: 1, deleted_at: 1 }, OTHER);
    mergeProjects(db, DEV, 'p-win', pid!);
    expect(liveRoots(pid!)).toEqual([{ device_id: DEV, path: path.join(ws, 'alpha') }, { device_id: OTHER, path: 'D:\\workspace\\alpha' }]);
  });
  it('メモは、残す方が空なら移し、両方にあれば後ろへつなぐ', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    addElsewhere();
    addElsewhere('p-win2');
    const memo = (id: string) => db.prepare('select markdown from project_memos where project_id = ? and deleted_at is null').get(id) as { markdown: string } | undefined;
    upsertShared(db, 'project_memos', { project_id: 'p-win', markdown: 'Windows のメモ' }, OTHER, 'project_id');
    mergeProjects(db, DEV, 'p-win', pid!);
    expect(memo(pid!)).toEqual({ markdown: 'Windows のメモ' });
    expect(memo('p-win')).toBeUndefined();
    upsertShared(db, 'project_memos', { project_id: 'p-win2', markdown: '2 台目のメモ' }, OTHER, 'project_id');
    mergeProjects(db, DEV, 'p-win2', pid!);
    expect(memo(pid!)).toEqual({ markdown: 'Windows のメモ\n\n2 台目のメモ' });
  });
  it('mergePreview は、まとめた後の PC ごとの場所と、両方のセッションの数を返す', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    assignSessions(db, DEV);
    addElsewhere();
    upsertShared(db, 'devices', { id: OTHER, name: 'DESKTOP-01', platform: 'win32', last_seen_at: 1 }, OTHER);
    upsertShared(db, 'project_roots', { id: 'r-third', project_id: 'p-win', device_id: 'dev-3', path: '/home/me/alpha', resolved: 1 }, 'dev-3');
    expect(mergePreview(db, DEV, 'p-win', pid!)).toEqual({
      roots: [
        { deviceName: null, path: path.join(ws, 'alpha'), here: true },
        { deviceName: 'DESKTOP-01', path: 'D:\\workspace\\alpha', here: false },
        // 名前の分からない PC は後ろに置く。
        { deviceName: null, path: '/home/me/alpha', here: false },
      ],
      sessions: 2,
      fromSessions: 1,
    });
    // 両方が同じ PC に場所を持つときは、残す方の場所を見せる（mergeProjects と同じ規則）。
    upsertShared(db, 'project_roots', { id: 'r-into-win', project_id: pid, device_id: OTHER, path: 'E:\\alpha', resolved: 1 }, OTHER);
    expect(mergePreview(db, DEV, 'p-win', pid!).roots.map((r) => r.path)).toEqual([path.join(ws, 'alpha'), 'E:\\alpha', '/home/me/alpha']);
  });
  it('sameFolderPairs は、この PC で同じフォルダを場所にしている組を見つけ、まとめる方から残す方を引く', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    assignSessions(db, DEV);
    addElsewhere();
    expect(sameFolderPairs(db, DEV).size).toBe(0);
    // 直す前の版で、届いた方にもこの PC の同じフォルダを結び付けてしまった状態。
    upsertShared(db, 'project_roots', { id: 'r-dup', project_id: 'p-win', device_id: DEV, path: path.join(ws, 'alpha'), resolved: 1 }, DEV);
    // セッションの多い方を残す。
    expect([...sameFolderPairs(db, DEV)]).toEqual([['p-win', { projectId: pid, name: 'alpha' }]]);
    // 一覧から削除したものと、スクラッチは数えない。
    resolveProject(db, DEV, 'p-win', { kind: 'unlink' });
    expect(sameFolderPairs(db, DEV).size).toBe(0);
  });
  it('sameFolderPairs は、セッションの数が同じなら先に作った方（id の小さい方）を残す', () => {
    for (const id of ['p-b', 'p-a']) {
      upsertShared(db, 'projects', { id, name: 'beta', status: 'active', is_scratch: 0 }, DEV);
      upsertShared(db, 'project_roots', { id: `r-${id}`, project_id: id, device_id: DEV, path: path.join(ws, 'beta'), resolved: 1 }, DEV);
    }
    upsertShared(db, 'projects', { id: 'p-s', name: 'scratch', status: 'active', is_scratch: 1 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r-p-s', project_id: 'p-s', device_id: DEV, path: path.join(ws, 'beta'), resolved: 1 }, DEV);
    expect([...sameFolderPairs(db, DEV)]).toEqual([['p-b', { projectId: 'p-a', name: 'beta' }]]);
  });
  it('mergeDirection は、選び直すフォルダがまだ自分の場所でなければ、選んだ方をまとめる方にする', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    assignSessions(db, DEV);
    addElsewhere();
    const dir = path.join(ws, 'alpha');
    expect(mergeDirection(db, DEV, 'p-win', pid!, dir)).toEqual({ fromId: 'p-win', intoId: pid });
    // 既に両方の場所になっているときは、どちらから選んでも同じ向きにする。
    upsertShared(db, 'project_roots', { id: 'r-dup', project_id: 'p-win', device_id: DEV, path: dir, resolved: 1 }, DEV);
    expect(mergeDirection(db, DEV, pid!, 'p-win', dir)).toEqual({ fromId: 'p-win', intoId: pid });
    expect(mergeDirection(db, DEV, 'p-win', pid!, dir)).toEqual({ fromId: 'p-win', intoId: pid });
  });
  it('まとめた後に他の PC が古い紐づけを書き戻しても、assignSessions が残した方へ紐づけ直す', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    assignSessions(db, DEV);
    addElsewhere();
    upsertShared(db, 'project_roots', { id: 'r-dup', project_id: 'p-win', device_id: DEV, path: path.join(ws, 'alpha'), resolved: 1 }, DEV);
    mergeProjects(db, DEV, 'p-win', pid!);
    // まとめる前の行を持っていた PC の索引が、消えたプロジェクトへの紐づけを後から書き戻した。
    const s = db.prepare('select * from sessions where id = ?').get('s-alpha') as Record<string, unknown>;
    upsertShared(db, 'sessions', { ...s, project_id: 'p-win' }, OTHER);
    expect(assignSessions(db, DEV)).toBe(1);
    expect(sessionProject('s-alpha')).toBe(pid);
    // 場所の当たらないセッションは、そのままにする。
    expect(sessionProject('s-p-win')).toBe(pid);
  });
  it('同じプロジェクト同士、無いプロジェクト、スクラッチはまとめない', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    addElsewhere();
    upsertShared(db, 'projects', { id: 'p-s', name: 'scratch', status: 'active', is_scratch: 1 }, DEV);
    expect(() => mergeProjects(db, DEV, pid!, pid!)).toThrow();
    expect(() => mergeProjects(db, DEV, 'nope', pid!)).toThrow();
    expect(() => mergeProjects(db, DEV, 'p-win', 'p-s')).toThrow();
    expect(() => mergeProjects(db, DEV, 'p-s', pid!)).toThrow();
    expect(project('p-win').deleted_at).toBeNull();
  });
});

describe('candidateDirs', () => {
  it('名前が近い直下ディレクトリを返す', () => {
    expect(candidateDirs(ws, 'alpha')).toEqual([path.join(ws, 'alpha'), path.join(ws, 'alpha-v2')]);
    expect(candidateDirs(ws, 'zzz')).toEqual([]);
  });
});

describe('listWorkspaceDirs', () => {
  it('登録済みと隠しを除いた直下のディレクトリを、名前順に返す', () => {
    syncProjectsFromWorkspace(db, DEV, ws);
    expect(listWorkspaceDirs(db, DEV, ws)).toEqual([
      { name: 'alpha-v2', path: path.join(ws, 'alpha-v2') },
      { name: 'beta', path: path.join(ws, 'beta') },
    ]);
  });
  it('一覧から削除したプロジェクトのフォルダは、未登録に数える', () => {
    const { created } = syncProjectsFromWorkspace(db, DEV, ws);
    resolveProject(db, DEV, created[0]!, { kind: 'unlink' });
    expect(listWorkspaceDirs(db, DEV, ws).map((d) => d.name)).toContain('alpha');
  });
  it('ディスク上の名前が NFD でも、NFC のパスで返し、NFC で登録済みのものは除く', () => {
    const nfd = 'デ'.normalize('NFD');
    fs.mkdirSync(path.join(ws, nfd));
    fs.mkdirSync(path.join(ws, `ガ${nfd}`.normalize('NFD')));
    upsertShared(db, 'projects', { id: 'p-nfc', name: 'デ', status: 'active', is_scratch: 0 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r-nfc', project_id: 'p-nfc', device_id: DEV, path: path.join(ws, 'デ'), resolved: 1 }, DEV);
    const names = listWorkspaceDirs(db, DEV, ws).map((d) => d.name);
    expect(names).not.toContain('デ');
    expect(names).toContain('ガデ');
    expect(listWorkspaceDirs(db, DEV, ws).every((d) => d.path === d.path.normalize('NFC'))).toBe(true);
  });
  it('ルートが無ければ空', () => {
    expect(listWorkspaceDirs(db, DEV, path.join(ws, 'nope'))).toEqual([]);
  });
});

describe('registerWorkspaceChildOf', () => {
  it('直下の未登録のディレクトリの下の cwd なら、そのディレクトリをプロジェクトにする', () => {
    const id = registerWorkspaceChildOf(db, DEV, ws, path.join(ws, 'beta', 'src', 'deep'));
    expect(id).not.toBeNull();
    expect(project(id!)).toMatchObject({ name: 'beta', status: 'active', is_scratch: 0 });
    expect(root(id!)).toMatchObject({ path: path.join(ws, 'beta'), resolved: 1 });
  });
  it('外、ワークスペースそのもの、隠し、無いディレクトリ、登録済みなら null', () => {
    syncProjectsFromWorkspace(db, DEV, ws);
    for (const cwd of ['/somewhere/else', ws, path.join(ws, '.hidden'), path.join(ws, 'gone'), path.join(ws, 'alpha')]) {
      expect(registerWorkspaceChildOf(db, DEV, ws, cwd)).toBeNull();
    }
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 1 });
  });
  it('cwd が NFD でも NFC のパスで登録する', () => {
    const nfd = 'ゲーム'.normalize('NFD');
    fs.mkdirSync(path.join(ws, nfd));
    const id = registerWorkspaceChildOf(db, DEV, ws, path.join(ws, nfd));
    expect(root(id!)).toMatchObject({ path: path.join(ws, 'ゲーム') });
  });
});

describe('workspaceProjectCount', () => {
  it('親がワークスペースの、解決済みのルートを数える', () => {
    syncProjectsFromWorkspace(db, DEV, ws);
    expect(workspaceProjectCount(db, DEV, ws)).toBe(1);
    expect(workspaceProjectCount(db, DEV, path.join(ws, 'alpha'))).toBe(0);
  });
  // 設定のワークスペースを綴り違い（d:\workspace と D:\Workspace）で打ち直しても、同じフォルダである。
  it.runIf(process.platform === 'win32')('Windows では、ワークスペースの綴りの大文字小文字が違っても数える', () => {
    syncProjectsFromWorkspace(db, DEV, ws);
    expect(workspaceProjectCount(db, DEV, ws.toUpperCase())).toBe(1);
    expect(workspaceProjectCount(db, DEV, ws.toLowerCase())).toBe(1);
  });
});


// 作成場所（workspaceRoot）は任意で、空は「決めていない」である（2026-10-13）。
// path.resolve('') はサーバの作業ディレクトリになるので、空のまま渡すとそこを親として扱ってしまう。
describe('作成場所が空のとき', () => {
  it('どの関数も、サーバの作業ディレクトリを作成場所として扱わない', () => {
    const here = process.cwd();
    const child = fs.readdirSync(here, { withFileTypes: true }).find((d) => d.isDirectory() && !d.name.startsWith('.'))!.name;
    addSession('s-here', path.join(here, child, 'deep'));
    expect(syncProjectsFromWorkspace(db, DEV, '').created).toEqual([]);
    expect(registerWorkspaceChildOf(db, DEV, '', path.join(here, child, 'deep'))).toBeNull();
    expect(listWorkspaceDirs(db, DEV, '')).toEqual([]);
    expect(candidateDirs('', child)).toEqual([]);
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 0 });
  });
  it('作成場所から数えるプロジェクトは 0 件', () => {
    upsertShared(db, 'projects', { id: 'p-1', name: 'x', status: 'active', is_scratch: 0 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r-1', project_id: 'p-1', device_id: DEV, path: path.join(process.cwd(), 'x'), resolved: 1 }, DEV);
    expect(workspaceProjectCount(db, DEV, '')).toBe(0);
  });
});

describe('resolvedProjectCount', () => {
  it('この PC で場所の分かっているプロジェクトを数え、スクラッチ、消したもの、ほかの PC のもの、場所の分からないものは数えない', () => {
    expect(resolvedProjectCount(db, DEV)).toBe(0);
    syncProjectsFromWorkspace(db, DEV, ws);
    expect(resolvedProjectCount(db, DEV)).toBe(1);
    upsertShared(db, 'projects', { id: 'p-s', name: 'scratch', status: 'active', is_scratch: 1 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r-s', project_id: 'p-s', device_id: DEV, path: path.join(ws, 's'), resolved: 1 }, DEV);
    upsertShared(db, 'projects', { id: 'p-o', name: 'other', status: 'active', is_scratch: 0 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r-o', project_id: 'p-o', device_id: 'dev-2', path: path.join(ws, 'o'), resolved: 1 }, DEV);
    upsertShared(db, 'projects', { id: 'p-u', name: 'gone', status: 'active', is_scratch: 0 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r-u', project_id: 'p-u', device_id: DEV, path: path.join(ws, 'u'), resolved: 0 }, DEV);
    upsertShared(db, 'projects', { id: 'p-a', name: 'archived', status: 'archived', is_scratch: 0 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r-a', project_id: 'p-a', device_id: DEV, path: path.join(ws, 'beta'), resolved: 1 }, DEV);
    expect(resolvedProjectCount(db, DEV)).toBe(2);
  });
});

// 0.6.2：作成場所の直下の自動登録は、ほかの PC から届いた同じプロジェクトがあれば、新しく作らずに結び付ける。
describe('自動登録の結び付け', () => {
  const OTHER = 'dev-2';
  /** ほかの PC だけに場所を持つプロジェクト。 */
  function elsewhere(id: string, name: string, remote: string | null) {
    upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0, git_remote: remote }, OTHER);
    upsertShared(db, 'project_roots', { id: `r-${id}`, project_id: id, device_id: OTHER, path: `/Users/other/src/${name}`, resolved: 1 }, OTHER);
  }
  function origin(dir: string, url: string) {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
  }
  const projectCount = () => (db.prepare('select count(*) c from projects where deleted_at is null').get() as { c: number }).c;

  it('remote が同じ（強い一致）なら、新しく作らずにその場所として結び付け、会話を紐づける', () => {
    origin(path.join(ws, 'alpha'), 'git@github.com:me/alpha.git');
    elsewhere('far', 'alpha-renamed', 'github.com/me/alpha');
    const r = syncProjectsFromWorkspace(db, DEV, ws);
    expect(r).toEqual({ created: [], linked: ['far'] });
    expect(root('far')).toMatchObject({ path: path.join(ws, 'alpha'), resolved: 1 });
    expect(sessionProject('s-alpha')).toBe('far');
    expect(projectCount()).toBe(1);
  });
  it('名前が同じで remote が食い違わない（弱い一致）なら結び付け、空の remote を埋める', () => {
    origin(path.join(ws, 'alpha'), 'https://github.com/me/alpha.git');
    elsewhere('far', 'alpha', null);
    expect(syncProjectsFromWorkspace(db, DEV, ws)).toEqual({ created: [], linked: ['far'] });
    expect(project('far').git_remote).toBe('github.com/me/alpha');
  });
  it('名前が同じでも remote が食い違えば、結び付けずに今までどおり作り、remote を入れる', () => {
    origin(path.join(ws, 'alpha'), 'https://github.com/me/alpha.git');
    elsewhere('far', 'alpha', 'github.com/someone/alpha');
    const r = syncProjectsFromWorkspace(db, DEV, ws);
    expect(r.linked).toEqual([]);
    expect(r.created).toHaveLength(1);
    expect(project(r.created[0]!)).toMatchObject({ name: 'alpha', git_remote: 'github.com/me/alpha' });
    expect(root('far')).toBeUndefined();
  });
  it('その場の自動登録も、強い一致なら結び付けて、そのプロジェクトの id を返す', () => {
    origin(path.join(ws, 'beta'), 'git@github.com:me/beta.git');
    elsewhere('far', 'b', 'github.com/me/beta');
    expect(registerWorkspaceChildOf(db, DEV, ws, path.join(ws, 'beta', 'src'))).toBe('far');
    expect(root('far')).toMatchObject({ path: path.join(ws, 'beta'), resolved: 1 });
    expect(projectCount()).toBe(1);
  });
});
