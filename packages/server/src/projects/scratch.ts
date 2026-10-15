import fs from 'node:fs';
import path from 'node:path';
import { newId } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { isStrictlyUnder } from '../platform/paths.ts';
import { moveProjectContents } from './contents.ts';

/**
 * クイックセッション（コードでは scratch）の擬似プロジェクトの DB の名前。
 * 画面には出さない。画面は辞書の project.name.quick で出す（ui の projectDisplayName）。
 */
export const SCRATCH_PROJECT_NAME = 'スクラッチ';

/** 新しいクイックセッションの置き場の名前。~/.agent-hangar/quick-sessions である。 */
const QUICK_DIR = 'quick-sessions';
/** 前の置き場の名前。~/.agent-hangar/scratch である。中身は動かさず、いままでどおり使える。 */
const LEGACY_DIR = 'scratch';

/** 新しいクイックセッションの置き場。この PC のスクラッチのプロジェクトの場所（project_roots）でもある。 */
export function quickSessionsRoot(home: string): string {
  return path.join(home, QUICK_DIR);
}

/** 前の置き場。既存の利用者の会話の cwd がここの下に残っている。 */
export function legacyScratchRoot(home: string): string {
  return path.join(home, LEGACY_DIR);
}

/**
 * スクラッチのプロジェクトの場所の行のパスから、それが表すクイックセッションの置き場の完全なパスを返す。
 * 場所が `<hangar のホーム>/quick-sessions` なら、同じホームの前の置き場 `<hangar のホーム>/scratch` も返す。
 * そうでなければ（まだ前の版の PC の行など）、その場所だけを返す。
 * ほかの PC の行も読むので、/ と \ のどちらの区切りでも扱う。名前の一致ではなく、場所の行から組んだ完全なパスで判定するためのものである。
 */
export function scratchPlacesOf(root: string): string[] {
  const m = /^(.*[\\/])quick-sessions[\\/]*$/.exec(root);
  return m ? [root, `${m[1]}${LEGACY_DIR}`] : [root];
}

/**
 * 端末をまたいで 1 つのスクラッチの擬似プロジェクトを返す。無ければ作る。起動のたびに呼んでよい（冪等）。
 *
 * 前の版は PC ごとに別のスクラッチのプロジェクトを作っていた。ここで 1 つにまとめる。
 * - まとめ先は、消していないスクラッチのプロジェクトのうち id の最も小さいもの。id は uuidv7 なので、作った日時の古いもの（同じなら id の小さいもの）になり、どの PC でも同じ先を選ぶ。
 * - ほかのスクラッチのプロジェクトの会話、TODO、成果物、メモはまとめ先へ移す（registry.ts の moveProjectContents）。状態（session_states）は会話の id に付くので引き継がれる。移した先（session_states.project_id）がまとめる元を指していれば、まとめ先へ付け替える。
 * - 動かす場所の行は、この PC の行だけである。同じ PC の行を 2 台が別々に作ると `(project_id, device_id)` の一意の制約が同期でぶつかるからである。
 *   ほかの PC の行が残っている方は消さずに置き、その PC が新しい版で起きて自分の行を外したときに消す。
 * - この PC の場所は `~/.agent-hangar/quick-sessions` にする。前の置き場 `~/.agent-hangar/scratch` は動かさず消さない。
 *   その下の会話は cwd もそのままで、振り分け（registry.ts の resolvedRoots）と判定（isUnderScratch、db/queries.ts の fromScratch）は 2 つの置き場を見る。
 */
export function ensureScratchProject(db: Db, deviceId: string, home: string): string {
  const root = quickSessionsRoot(home);
  fs.mkdirSync(root, { recursive: true });
  return db.transaction(() => {
    const live = (db.prepare('select id from projects where is_scratch = 1 and deleted_at is null order by id').all() as { id: string }[]).map((r) => r.id);
    let into = live[0];
    if (!into) {
      into = newId();
      upsertShared(db, 'projects', { id: into, name: SCRATCH_PROJECT_NAME, status: 'active', is_scratch: 1 }, deviceId);
    }
    let moved = false;
    for (const from of live.slice(1)) if (moveProjectContents(db, deviceId, from, into)) moved = true;

    // この PC の場所の行は、まとめ先の 1 行だけにする。消したスクラッチのプロジェクトに残った行も外す。
    const mineElsewhere = db.prepare(`select r.id from project_roots r join projects p on p.id = r.project_id
      where r.device_id = ? and r.project_id <> ? and r.deleted_at is null and p.is_scratch = 1`).all(deviceId, into) as { id: string }[];
    for (const r of mineElsewhere) softDeleteShared(db, 'project_roots', r.id, deviceId);
    const mine = db.prepare('select * from project_roots where project_id = ? and device_id = ?').get(into, deviceId) as Record<string, unknown> | undefined;
    if (!mine) upsertShared(db, 'project_roots', { id: newId(), project_id: into, device_id: deviceId, path: root, resolved: 1 }, deviceId);
    else if (mine.path !== root || mine.resolved !== 1 || mine.deleted_at !== null) upsertShared(db, 'project_roots', { ...mine, path: root, resolved: 1, deleted_at: null }, deviceId);

    // 中身を移した方は、ほかの PC の場所の行が残っていなければ消す。
    const rootsLeft = db.prepare('select count(*) c from project_roots where project_id = ? and deleted_at is null');
    for (const from of live.slice(1)) {
      if ((rootsLeft.get(from) as { c: number }).c === 0) softDeleteShared(db, 'projects', from, deviceId);
    }
    // まとめ先は、行は変わらないが中身（セッション、最終の活動、TODO の数）が変わる。
    // 知らせるのは、実際に何か移したときだけにする。前の版の PC の行が残る間は live が 2 つのままなので、数で見ると起動のたびに知らせてしまう。
    if (moved) touchRow(db, 'projects', into);
    return into;
  })();
}

/** 同期で当てた 1 行が、スクラッチのプロジェクトの行か、スクラッチのプロジェクトの場所の行か。当てた後の DB で見る。 */
export function isScratchRow(db: Db, c: { tableName: string; rowId: string }): boolean {
  if (c.tableName === 'projects') return (db.prepare('select is_scratch from projects where id = ?').get(c.rowId) as { is_scratch: number } | undefined)?.is_scratch === 1;
  if (c.tableName === 'project_roots') {
    return (db.prepare('select p.is_scratch from project_roots r join projects p on p.id = r.project_id where r.id = ?').get(c.rowId) as { is_scratch: number } | undefined)?.is_scratch === 1;
  }
  return false;
}

/**
 * 同期の取り込みの受け手（sync/engine.ts の applied）。スクラッチのプロジェクトかその場所の行が届いたら、まとめ直す（ensureScratchProject）。
 * 前の版の PC が作った会話が、次の起動まで別のスクラッチのプロジェクトに割れたままにならないようにする。
 * 1 回の取り込みで届いた行は同期のうちに続けて渡されるので、マイクロタスクで 1 回にまとめる。ほかの表の行では何もしない。
 * まとめに失敗しても投げずに onError へ渡す（マイクロタスクで投げるとプロセスごと落ちる）。
 */
export function followRemoteScratch(db: Db, deviceId: string, home: string, o: { onError: (e: unknown) => void; ensure?: typeof ensureScratchProject }): (c: { tableName: string; rowId: string }) => void {
  const ensure = o.ensure ?? ensureScratchProject;
  let queued = false;
  return (c) => {
    if (queued || !isScratchRow(db, c)) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      try {
        if (db.open) ensure(db, deviceId, home);
      } catch (e) {
        o.onError(e);
      }
    });
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** <quick-sessions>/<yyyymmdd-HHmmss> を作る。同じ秒に重なれば -2、-3 を付ける。 */
export function newScratchDir(home: string, now: Date = new Date()): string {
  const root = quickSessionsRoot(home);
  fs.mkdirSync(root, { recursive: true });
  const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let n = 1; ; n++) {
    const dir = path.join(root, n === 1 ? base : `${base}-${n}`);
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir);
    return dir;
  }
}

/**
 * cwd がクイックセッションの置き場（quick-sessions と前の scratch）の下（置き場そのものは含まない）にあるか。
 * 判定は 2 つの完全なパスで行う。利用者が自分で作った scratch という名前のフォルダ（~/workspace/scratch など）は当たらない。
 * 綴りの違いで判定が変わらないよう、どちらも path.resolve で正規化してから比べる。
 * 末尾の区切り、重なった区切り、`.` と `..` はここで消える。
 * symlink までは辿らないので、cwd は保存されたときの綴りのまま比べられる。
 */
export function isUnderScratch(home: string, cwd: string): boolean {
  const c = path.resolve(cwd);
  return [quickSessionsRoot(home), legacyScratchRoot(home)].some((r) => isStrictlyUnder(c, path.resolve(r)));
}
