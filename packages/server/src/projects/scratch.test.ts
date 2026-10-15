import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { assignSessions } from './registry.ts';
import { ensureScratchProject, isUnderScratch, legacyScratchRoot, newScratchDir, quickSessionsRoot, SCRATCH_PROJECT_NAME, scratchPlacesOf } from './scratch.ts';

let db: Db;
let home: string;

beforeEach(() => {
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-scr-'));
});
// 途中で落ちても一時ディレクトリを置き去りにしない。
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const scratchProject = (id: string, device: string, root: string) => {
  upsertShared(db, 'projects', { id, name: SCRATCH_PROJECT_NAME, status: 'active', is_scratch: 1 }, device);
  upsertShared(db, 'project_roots', { id: `r-${id}-${device}`, project_id: id, device_id: device, path: root, resolved: 1 }, device);
};
const session = (id: string, cwd: string, projectId: string | null, device = 'd') =>
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: `u-${id}`, cwd, home_device: device, project_id: projectId }, device);
const projectOf = (id: string) => (db.prepare('select project_id from sessions where id = ?').get(id) as { project_id: string | null }).project_id;
const liveScratch = () => (db.prepare('select id from projects where is_scratch = 1 and deleted_at is null order by id').all() as { id: string }[]).map((r) => r.id);

describe('scratch', () => {
  it('擬似プロジェクトは 1 つだけ作られ、この PC の場所は quick-sessions になる', () => {
    const id = ensureScratchProject(db, 'd', home);
    expect(ensureScratchProject(db, 'd', home)).toBe(id);
    const p = db.prepare('select name, is_scratch, status from projects where id = ?').get(id);
    expect(p).toEqual({ name: SCRATCH_PROJECT_NAME, is_scratch: 1, status: 'active' });
    expect(db.prepare('select path, resolved from project_roots where project_id = ? and device_id = ?').get(id, 'd')).toEqual({ path: quickSessionsRoot(home), resolved: 1 });
    expect(quickSessionsRoot(home)).toBe(path.join(home, 'quick-sessions'));
    expect(fs.existsSync(quickSessionsRoot(home))).toBe(true);
    // 前の置き場は作らない。
    expect(fs.existsSync(legacyScratchRoot(home))).toBe(false);
    expect(db.prepare('select count(*) c from projects where is_scratch = 1').get()).toEqual({ c: 1 });
  });

  it('ディレクトリ名は時刻で quick-sessions の下に作り、同じ秒は -2 を付ける', () => {
    const t = new Date(2026, 8, 17, 9, 5, 7);
    const a = newScratchDir(home, t);
    expect(a).toBe(path.join(quickSessionsRoot(home), '20260917-090507'));
    expect(fs.statSync(a).isDirectory()).toBe(true);
    expect(newScratchDir(home, t)).toBe(path.join(quickSessionsRoot(home), '20260917-090507-2'));
    expect(newScratchDir(home, t)).toBe(path.join(quickSessionsRoot(home), '20260917-090507-3'));
  });

  it('isUnderScratch は 2 つの置き場の下だけを真とし、パスを正規化してから比べる', () => {
    const a = newScratchDir(home, new Date(2026, 8, 17, 9, 5, 7));
    const legacy = path.join(legacyScratchRoot(home), '20260901-100000');
    expect(isUnderScratch(home, a)).toBe(true);
    expect(isUnderScratch(home, legacy)).toBe(true);
    expect(isUnderScratch(home, path.join(a, 'sub'))).toBe(true);
    expect(isUnderScratch(home, quickSessionsRoot(home))).toBe(false);
    expect(isUnderScratch(home, legacyScratchRoot(home))).toBe(false);
    expect(isUnderScratch(home, '/elsewhere')).toBe(false);
    // 末尾の区切り、`.`、`..` が混じっても判定は変わらない。
    expect(isUnderScratch(home, a + path.sep)).toBe(true);
    expect(isUnderScratch(home, path.join(a, '.', 'sub', '..'))).toBe(true);
    expect(isUnderScratch(home, path.join(a, '..'))).toBe(false);
    expect(isUnderScratch(home + path.sep, a)).toBe(true);
    // 名前が置き場で始まるだけの隣のディレクトリは下ではない。
    expect(isUnderScratch(home, `${quickSessionsRoot(home)}-old`)).toBe(false);
    expect(isUnderScratch(home, `${legacyScratchRoot(home)}pad`)).toBe(false);
    // 区切りを足しただけの置き場は置き場のままである。
    expect(isUnderScratch(home, quickSessionsRoot(home) + path.sep)).toBe(false);
    // 正規化していない綴りでも下は下である。
    expect(isUnderScratch(home, `${legacyScratchRoot(home)}${path.sep}${path.sep}sub`)).toBe(true);
  });

  it('利用者が自分で作った scratch という名前のフォルダは、クイックセッションと取り違えない', () => {
    const own = path.join(home, 'workspace', 'scratch', 'notes');
    expect(isUnderScratch(home, own)).toBe(false);
    expect(isUnderScratch(home, path.join(os.homedir(), 'scratch', 'x'))).toBe(false);
    expect(isUnderScratch(home, path.join(home, 'workspace', 'quick-sessions', 'x'))).toBe(false);
    // 索引の振り分けでも、名前ではなく完全なパスで見る。
    const id = ensureScratchProject(db, 'd', home);
    session('own', own, null);
    session('legacy', path.join(legacyScratchRoot(home), '20260901-100000'), null);
    session('quick', path.join(quickSessionsRoot(home), '20261016-090000'), null);
    assignSessions(db, 'd');
    expect(projectOf('own')).toBeNull();
    expect(projectOf('legacy')).toBe(id);
    expect(projectOf('quick')).toBe(id);
  });

  it('scratchPlacesOf は quick-sessions の場所から前の置き場も返す（Windows の区切りでも）。それ以外の場所はそのまま', () => {
    expect(scratchPlacesOf('/Users/me/.agent-hangar/quick-sessions')).toEqual(['/Users/me/.agent-hangar/quick-sessions', '/Users/me/.agent-hangar/scratch']);
    expect(scratchPlacesOf('C:\\Users\\me\\.agent-hangar\\quick-sessions')).toEqual(['C:\\Users\\me\\.agent-hangar\\quick-sessions', 'C:\\Users\\me\\.agent-hangar\\scratch']);
    expect(scratchPlacesOf('/Users/me/.agent-hangar/scratch')).toEqual(['/Users/me/.agent-hangar/scratch']);
  });
});

describe('既存の利用者（~/.agent-hangar/scratch を使っていた PC）', () => {
  it('同じプロジェクトのまま場所を quick-sessions に替え、前の置き場の中身は動かさず消さない', () => {
    const legacyDir = path.join(legacyScratchRoot(home), '20260901-100000');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'a.txt'), 'A');
    scratchProject('p-old', 'd', legacyScratchRoot(home));
    session('s-old', legacyDir, 'p-old');

    expect(ensureScratchProject(db, 'd', home)).toBe('p-old');
    expect(db.prepare('select path from project_roots where project_id = ? and device_id = ? and deleted_at is null').all('p-old', 'd')).toEqual([{ path: quickSessionsRoot(home) }]);
    expect(fs.readFileSync(path.join(legacyDir, 'a.txt'), 'utf8')).toBe('A');
    // 会話の cwd も所属もそのまま。
    expect(db.prepare('select cwd, project_id from sessions where id = ?').get('s-old')).toEqual({ cwd: legacyDir, project_id: 'p-old' });
    // 前の置き場で新しく見つかった会話（外のターミナルで始めたもの、フォーク）も、クイックセッションに入る。
    session('s-new', path.join(legacyScratchRoot(home), '20260902-100000'), null);
    assignSessions(db, 'd');
    expect(projectOf('s-new')).toBe('p-old');
  });
});

describe('PC ごとのスクラッチのプロジェクトを 1 つにまとめる', () => {
  // id は uuidv7 なので、小さい方が先に作ったものである。
  const OLD = '0190a000-0000-7000-8000-000000000001';
  const NEW = '0190b000-0000-7000-8000-000000000002';

  it('作った日時の古いもの（id の小さいもの）へ、会話と TODO を移し、自分の場所を付け替えて、空になった方を消す', () => {
    scratchProject(OLD, 'mac2', '/Users/other/.agent-hangar/scratch');
    scratchProject(NEW, 'd', legacyScratchRoot(home));
    session('s-mac2', '/Users/other/.agent-hangar/scratch/20260901-100000', OLD, 'mac2');
    session('s-mine', path.join(legacyScratchRoot(home), '20260902-100000'), NEW);
    upsertShared(db, 'todos', { id: 't-old', project_id: OLD, text: 'old', done: 0, position: 0 }, 'mac2');
    upsertShared(db, 'todos', { id: 't-mine-1', project_id: NEW, text: 'mine 1', done: 0, position: 0 }, 'd');
    upsertShared(db, 'todos', { id: 't-mine-2', project_id: NEW, text: 'mine 2', done: 0, position: 1 }, 'd');

    expect(ensureScratchProject(db, 'd', home)).toBe(OLD);
    expect(liveScratch()).toEqual([OLD]);
    expect(projectOf('s-mac2')).toBe(OLD);
    expect(projectOf('s-mine')).toBe(OLD);
    expect(db.prepare('select id, position from todos where project_id = ? order by position').all(OLD)).toEqual([{ id: 't-old', position: 0 }, { id: 't-mine-1', position: 1 }, { id: 't-mine-2', position: 2 }]);
    // 自分の場所はまとめ先にあり、ほかの PC の場所はその PC の行のまま。
    expect(db.prepare('select device_id, path from project_roots where project_id = ? and deleted_at is null order by device_id').all(OLD)).toEqual([
      { device_id: 'd', path: quickSessionsRoot(home) },
      { device_id: 'mac2', path: '/Users/other/.agent-hangar/scratch' },
    ]);
    expect(db.prepare('select count(*) c from project_roots where project_id = ? and deleted_at is null').get(NEW)).toEqual({ c: 0 });
    // 冪等である。
    expect(ensureScratchProject(db, 'd', home)).toBe(OLD);
    expect(db.prepare('select id, position from todos where project_id = ? order by position').all(OLD)).toHaveLength(3);
  });

  it('どちらの PC でも同じまとめ先を選ぶ', () => {
    scratchProject(NEW, 'a', '/Users/a/.agent-hangar/scratch');
    scratchProject(OLD, 'b', '/Users/b/.agent-hangar/scratch');
    const homeA = path.join(home, 'a');
    const homeB = path.join(home, 'b');
    expect(ensureScratchProject(db, 'a', homeA)).toBe(OLD);
    expect(ensureScratchProject(db, 'b', homeB)).toBe(OLD);
    expect(liveScratch()).toEqual([OLD]);
    expect(db.prepare('select device_id, path from project_roots where project_id = ? and deleted_at is null order by device_id').all(OLD)).toEqual([
      { device_id: 'a', path: quickSessionsRoot(homeA) },
      { device_id: 'b', path: quickSessionsRoot(homeB) },
    ]);
  });

  it('ほかの PC の場所が残っている方は、中身だけ移して消さない（その PC が自分で外すまで待つ）', () => {
    scratchProject(OLD, 'd', legacyScratchRoot(home));
    scratchProject(NEW, 'mac2', '/Users/other/.agent-hangar/scratch');
    session('s-mac2', '/Users/other/.agent-hangar/scratch/20260901-100000', NEW, 'mac2');
    expect(ensureScratchProject(db, 'd', home)).toBe(OLD);
    expect(projectOf('s-mac2')).toBe(OLD);
    expect(liveScratch()).toEqual([OLD, NEW]);
    // ほかの PC の場所の行には触らない（同じ PC の行を 2 台が別々に作ると一意の制約がぶつかる）。
    expect(db.prepare('select project_id from project_roots where device_id = ? and deleted_at is null').all('mac2')).toEqual([{ project_id: NEW }]);
    // その PC が新しい版で起きると、自分の場所を付け替え、空になった方を消す。
    expect(ensureScratchProject(db, 'mac2', path.join(home, 'mac2'))).toBe(OLD);
    expect(liveScratch()).toEqual([OLD]);
  });

  it('消したスクラッチのプロジェクトに残った自分の場所の行も外す', () => {
    scratchProject(OLD, 'mac2', '/Users/other/.agent-hangar/scratch');
    scratchProject(NEW, 'd', legacyScratchRoot(home));
    db.prepare('update projects set deleted_at = 5 where id = ?').run(NEW);
    expect(ensureScratchProject(db, 'd', home)).toBe(OLD);
    expect(db.prepare("select project_id, path from project_roots where device_id = 'd' and deleted_at is null").all()).toEqual([{ project_id: OLD, path: quickSessionsRoot(home) }]);
  });
});
