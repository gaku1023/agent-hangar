import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeOut, SharedTable } from '@agent-hangar/shared';
import { onRowChange } from '../db/notify.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { applyRemoteBatch } from '../sync/apply.ts';
import { setSessionPlacement } from '../sessions/states.ts';
import { assignSessions } from './registry.ts';
import { ensureScratchProject, followRemoteScratch, isUnderScratch, legacyScratchRoot, newScratchDir, quickSessionsRoot, SCRATCH_PROJECT_NAME, scratchPlacesOf } from './scratch.ts';

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
  it('DB の名前は「クイックセッション」。前の版が付けた旧称の名前は、起動のときに書き換えて同期へ出す', () => {
    expect(SCRATCH_PROJECT_NAME).toBe('クイックセッション');
    upsertShared(db, 'projects', { id: 'old', name: '\u30b9\u30af\u30e9\u30c3\u30c1', status: 'active', is_scratch: 1 }, 'other');
    const before = (db.prepare('select updated_at from projects where id = ?').get('old') as { updated_at: number }).updated_at;
    expect(ensureScratchProject(db, 'd', home)).toBe('old');
    const after = db.prepare('select name, origin_device from projects where id = ?').get('old');
    expect(after).toEqual({ name: SCRATCH_PROJECT_NAME, origin_device: 'd' });
    // もう一度起動しても、同じ名前なら書かない（同期へ毎回出さない）。
    const changes = (db.prepare("select count(*) c from changes where table_name = 'projects'").get() as { c: number }).c;
    ensureScratchProject(db, 'd', home);
    expect((db.prepare("select count(*) c from changes where table_name = 'projects'").get() as { c: number }).c).toBe(changes);
    expect((db.prepare('select updated_at from projects where id = ?').get('old') as { updated_at: number }).updated_at).toBeGreaterThanOrEqual(before);
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

describe('PC ごとのクイックセッションのプロジェクトを 1 つにまとめる', () => {
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

  it('まとめる元へ移した会話は、移した先（session_states.project_id）もまとめ先へ付け替える', () => {
    scratchProject(OLD, 'mac2', '/Users/other/.agent-hangar/scratch');
    scratchProject(NEW, 'd', legacyScratchRoot(home));
    session('s-moved', '/Users/me/src/app', NEW);
    setSessionPlacement(db, 'd', 's-moved', NEW);

    expect(ensureScratchProject(db, 'd', home)).toBe(OLD);
    expect(db.prepare('select project_id from session_states where session_id = ?').get('s-moved')).toEqual({ project_id: OLD });
    expect(projectOf('s-moved')).toBe(OLD);
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

  it('消したクイックセッションのプロジェクトに残った自分の場所の行も外す', () => {
    scratchProject(OLD, 'mac2', '/Users/other/.agent-hangar/scratch');
    scratchProject(NEW, 'd', legacyScratchRoot(home));
    db.prepare('update projects set deleted_at = 5 where id = ?').run(NEW);
    expect(ensureScratchProject(db, 'd', home)).toBe(OLD);
    expect(db.prepare("select project_id, path from project_roots where device_id = 'd' and deleted_at is null").all()).toEqual([{ project_id: OLD, path: quickSessionsRoot(home) }]);
  });
});

describe('まとめを繰り返しても、同期の変更を出し続けない', () => {
  const OLD = '0190a000-0000-7000-8000-000000000001';
  const NEW = '0190b000-0000-7000-8000-000000000002';
  const pendingChanges = () => (db.prepare('select count(*) c from changes').get() as { c: number }).c;

  it('前の版の PC の行が残る間、2 回目からは何も書かず、まとめ先の行の変化も知らせない', async () => {
    scratchProject(OLD, 'd', quickSessionsRoot(home));
    scratchProject(NEW, 'mac2', '/Users/other/.agent-hangar/scratch');
    session('s-mac2', '/Users/other/.agent-hangar/scratch/20260901-100000', NEW, 'mac2');
    expect(ensureScratchProject(db, 'd', home)).toBe(OLD);
    expect(projectOf('s-mac2')).toBe(OLD);
    const notices: string[] = [];
    const off = onRowChange((c) => { if (c.db === db) notices.push(`${c.table}:${c.rowId}:${c.origin}`); });
    try {
      const before = pendingChanges();
      await Promise.resolve();
      notices.length = 0;
      expect(ensureScratchProject(db, 'd', home)).toBe(OLD);
      expect(ensureScratchProject(db, 'd', home)).toBe(OLD);
      await Promise.resolve();
      expect(pendingChanges()).toBe(before);
      expect(notices).toEqual([]);
      // 前の版の PC がまた自分のプロジェクトに会話を作れば、それは移し、まとめ先の中身が変わったことを知らせる。
      session('s-mac2-b', '/Users/other/.agent-hangar/scratch/20260903-100000', NEW, 'mac2');
      notices.length = 0;
      await Promise.resolve();
      notices.length = 0;
      ensureScratchProject(db, 'd', home);
      await Promise.resolve();
      expect(projectOf('s-mac2-b')).toBe(OLD);
      expect(notices).toContain(`projects:${OLD}:touch`);
    } finally {
      off();
    }
    // ほかの PC の行は残したまま、そのプロジェクトも消さない。
    expect(liveScratch()).toEqual([OLD, NEW]);
  });
});

describe('別々に作った 2 つのクイックセッションのプロジェクトは、両側から同じ先へ収束する', () => {
  /** db の未送の変更を、同期で降りたものとして to に当てる。 */
  const deliver = (from: Db, to: Db, toDevice: string) => {
    const rows = from.prepare('select * from changes where pushed_at is null order by seq').all() as { seq: number; table_name: SharedTable; row_id: string; op: 'upsert' | 'delete'; payload: string; updated_at: number; device_id: string }[];
    from.prepare('update changes set pushed_at = 1 where pushed_at is null').run();
    const changes: ChangeOut[] = rows.map((r) => ({ seq: r.seq, tableName: r.table_name, rowId: r.row_id, op: r.op, payload: JSON.parse(r.payload) as Record<string, unknown>, updatedAt: r.updated_at, deviceId: r.device_id }));
    applyRemoteBatch(to, changes, { ownDeviceId: toDevice, skipOwn: true, home });
  };
  const live = (d: Db) => (d.prepare('select id from projects where is_scratch = 1 and deleted_at is null order by id').all() as { id: string }[]).map((r) => r.id);
  const roots = (d: Db, id: string) => d.prepare('select device_id from project_roots where project_id = ? and deleted_at is null order by device_id').all(id);
  const projectIn = (d: Db, sid: string) => (d.prepare('select project_id from sessions where id = ?').get(sid) as { project_id: string }).project_id;

  it('どちらの PC も、作った日時の古い方へまとめ、場所の行と会話がそろう', () => {
    const dbB = openDb(':memory:');
    const homeA = path.join(home, 'a');
    const homeB = path.join(home, 'b');
    try {
      const pa = ensureScratchProject(db, 'a', homeA);
      const pb = ensureScratchProject(dbB, 'b', homeB);
      upsertShared(db, 'sessions', { id: 's-a', provider: 'claude-code', provider_session_id: 'u-a', cwd: path.join(quickSessionsRoot(homeA), '20261016-100000'), home_device: 'a', project_id: pa }, 'a');
      upsertShared(dbB, 'sessions', { id: 's-b', provider: 'claude-code', provider_session_id: 'u-b', cwd: path.join(quickSessionsRoot(homeB), '20261016-100001'), home_device: 'b', project_id: pb }, 'b');
      const into = [pa, pb].sort()[0]!;
      // 互いの行が届き、それぞれが次の起動か取り込みでまとめる。往復を 2 回くり返す。
      for (let i = 0; i < 2; i++) {
        deliver(db, dbB, 'b');
        deliver(dbB, db, 'a');
        ensureScratchProject(db, 'a', homeA);
        ensureScratchProject(dbB, 'b', homeB);
      }
      deliver(db, dbB, 'b');
      deliver(dbB, db, 'a');
      for (const d of [db, dbB]) {
        expect(live(d)).toEqual([into]);
        expect(roots(d, into)).toEqual([{ device_id: 'a' }, { device_id: 'b' }]);
        expect(projectIn(d, 's-a')).toBe(into);
        expect(projectIn(d, 's-b')).toBe(into);
      }
      // そろった後は、どちらももう何も書かない。
      ensureScratchProject(db, 'a', homeA);
      ensureScratchProject(dbB, 'b', homeB);
      expect(db.prepare('select count(*) c from changes where pushed_at is null').get()).toEqual({ c: 0 });
      expect(dbB.prepare('select count(*) c from changes where pushed_at is null').get()).toEqual({ c: 0 });
    } finally {
      dbB.close();
    }
  });
});

describe('同期でクイックセッションの行が届いたら、まとめ直す', () => {
  const OLD = '0190a000-0000-7000-8000-000000000001';
  const NEW = '0190b000-0000-7000-8000-000000000002';

  it('クイックセッションのプロジェクトかその場所の行のときだけ、取り込みの後に 1 回まとめる', async () => {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const follow = followRemoteScratch(db, 'd', home, { onError: (e) => errors.push(e), ensure: (d, device, h) => { calls.push(device); return ensureScratchProject(d, device, h); } });
    scratchProject(OLD, 'd', quickSessionsRoot(home));
    upsertShared(db, 'projects', { id: 'p1', name: 'app', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'r-p1', project_id: 'p1', device_id: 'd', path: '/src/app', resolved: 1 }, 'd');
    follow({ tableName: 'projects', rowId: 'p1' });
    follow({ tableName: 'project_roots', rowId: 'r-p1' });
    follow({ tableName: 'sessions', rowId: 'x' });
    await Promise.resolve();
    expect(calls).toEqual([]);
    // 前の版の PC が作ったクイックセッションのプロジェクトと会話が、同じ取り込みで届いた。
    scratchProject(NEW, 'mac2', '/Users/other/.agent-hangar/scratch');
    session('s-mac2', '/Users/other/.agent-hangar/scratch/20260901-100000', NEW, 'mac2');
    follow({ tableName: 'projects', rowId: NEW });
    follow({ tableName: 'project_roots', rowId: `r-${NEW}-mac2` });
    expect(calls).toEqual([]);
    await Promise.resolve();
    expect(calls).toEqual(['d']);
    expect(projectOf('s-mac2')).toBe(OLD);
    expect(errors).toEqual([]);
  });

  it('まとめに失敗しても投げず、onError へ渡す', async () => {
    const errors: unknown[] = [];
    scratchProject(OLD, 'd', quickSessionsRoot(home));
    const follow = followRemoteScratch(db, 'd', home, { onError: (e) => errors.push(e), ensure: () => { throw new Error('boom'); } });
    expect(() => follow({ tableName: 'projects', rowId: OLD })).not.toThrow();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });
});
