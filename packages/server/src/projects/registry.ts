import fs from 'node:fs';
import path from 'node:path';
import { newId, type ResolveAction } from '@agent-hangar/shared';
import { touchRow } from '../db/notify.ts';
import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { gitRemoteOf } from '../git/remote.ts';
import { isStrictlyUnder, isUnder, pathKey, samePath } from '../platform/paths.ts';
import { pinnedProjectOf, repointPins } from '../sessions/move.ts';
import { moveProjectContents } from './contents.ts';
import { fillProjectRemote, linkCandidateFor, placelessProjects } from './link.ts';
import { scratchPlacesOf } from './scratch.ts';

/**
 * パスを比べられる形にそろえる。`..` や末尾の `/` を除き、Unicode を NFC にする。
 * macOS は Finder などで作った名前を NFD（デ＝テ＋濁点）で持つことがあり、readdir もその形で返す。
 * transcript の cwd は NFC で来るので、そろえないと同じフォルダでも文字列が一致しない。
 * APFS は正規化の違いを区別しないので、NFC にしたパスでもそのまま開ける。
 */
export function normalizeDir(p: string): string {
  return path.resolve(p).normalize('NFC');
}

type RootRow = { id: string; project_id: string; device_id: string; path: string; resolved: number; deleted_at: number | null };

/**
 * 作成場所（設定の workspaceRoot）が決まっているか。
 * 作成場所は任意で、空は「決めていない」である（2026-10-13）。
 * path.resolve('') はサーバの作業ディレクトリになるので、空のまま下の関数へ渡さない。
 */
export function hasWorkspaceRoot(workspaceRoot: string | null | undefined): workspaceRoot is string {
  return typeof workspaceRoot === 'string' && workspaceRoot.trim() !== '';
}

/** ルート直下の、隠しでないディレクトリを名前順に返す。ルートが空なら子は無い。 */
function childDirs(root: string): string[] {
  if (!hasWorkspaceRoot(root)) return [];
  // 無いパスも、ディレクトリでないパスも「子は無い」として扱う。
  // 設定でワークスペースのルートにファイルを指されたときに 500 にしないため。
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => normalizeDir(path.join(root, d.name)))
    .sort();
}

/**
 * プロジェクト行と、この端末のルート（解決済み）を作る。作ったプロジェクトの id を返す。
 * フォルダが git のリポジトリなら、その remote（正規化した形）も入れる。ほかの PC がこのプロジェクトと同じフォルダを見分けるのに使う。
 */
export function insertProject(db: Db, deviceId: string, name: string, dir: string): string {
  const id = newId();
  upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0, git_remote: gitRemoteOf(dir) }, deviceId);
  upsertShared(db, 'project_roots', { id: newId(), project_id: id, device_id: deviceId, path: dir, resolved: 1 }, deviceId);
  return id;
}

/**
 * この PC に場所の無いプロジェクトを、dir の場所として結び付ける（0.6.1）。
 * 書き込みは「場所を再指定」（resolveProject の repoint）と同じで、その下の未分類の会話も紐づける。
 * プロジェクトの remote が空なら、dir のリポジトリの remote で埋める。
 * 結び付けてよいか（この PC に場所が無いか、ほかのプロジェクトの場所でないか）は呼び手が確かめる。
 */
export function linkProjectHere(db: Db, deviceId: string, projectId: string, dir: string): void {
  resolveProject(db, deviceId, projectId, { kind: 'repoint', path: dir });
  fillProjectRemote(db, deviceId, projectId, normalizeDir(dir));
}

/**
 * 作成場所の直下の 1 つのフォルダを、自動の登録の規則でプロジェクトにする。
 * ほかの PC から届いた同じプロジェクト（remote が同じもの、名前が同じで remote が食い違わないもの）があれば、新しく作らずに結び付ける。
 * remote が食い違うときは結び付けず、今までどおり作る。
 */
function adoptWorkspaceChild(db: Db, deviceId: string, dir: string): { projectId: string; linked: boolean } {
  const link = linkCandidateFor(placelessProjects(db, deviceId), { name: path.basename(dir), remote: gitRemoteOf(dir) });
  if (link) {
    linkProjectHere(db, deviceId, link.projectId, dir);
    return { projectId: link.projectId, linked: true };
  }
  return { projectId: insertProject(db, deviceId, path.basename(dir), dir), linked: false };
}

/**
 * ワークスペース直下のディレクトリのうち、セッションを持つものをプロジェクトとして登録する。
 * ほかの PC から届いた同じプロジェクトがあれば、作らずに結び付ける（adoptWorkspaceChild）。created は作った id、linked は結び付けた id である。
 */
export function syncProjectsFromWorkspace(db: Db, deviceId: string, workspaceRoot: string): { created: string[]; linked: string[] } {
  const created: string[] = [];
  const linked: string[] = [];
  // SQL の文字列比較では NFC と NFD が一致しないので、正規化してから JS で比べる。
  const cwds = (db.prepare('select distinct cwd from sessions where deleted_at is null').all() as { cwd: string }[]).map((r) => r.cwd.normalize('NFC'));
  const known = knownRoots(db, deviceId);
  for (const dir of childDirs(workspaceRoot)) {
    if (!cwds.some((c) => isUnder(c, dir))) continue;
    if (known.has(pathKey(dir))) continue;
    const r = adoptWorkspaceChild(db, deviceId, dir);
    (r.linked ? linked : created).push(r.projectId);
  }
  return { created, linked };
}

export type WorkspaceDir = { name: string; path: string };

/** この端末の、論理削除されていないルートのパスの比べる鍵（NFC にしてから pathKey）。 */
function knownRoots(db: Db, deviceId: string): Set<string> {
  return new Set((db.prepare('select path from project_roots where device_id = ? and deleted_at is null').all(deviceId) as { path: string }[]).map((r) => pathKey(r.path.normalize('NFC'))));
}

/**
 * ワークスペース直下の、まだプロジェクトになっていないディレクトリ。
 * 新しいセッションのダイアログの検索と、作成のダイアログの一覧に出す。
 * 一覧から削除したプロジェクトのフォルダは、ルートが論理削除されているので未登録に数える。
 */
export function listWorkspaceDirs(db: Db, deviceId: string, workspaceRoot: string): WorkspaceDir[] {
  const known = knownRoots(db, deviceId);
  return childDirs(workspaceRoot).filter((dir) => !known.has(pathKey(dir))).map((dir) => ({ name: path.basename(dir), path: dir }));
}

/**
 * 起動中に現れた未分類のセッションのための、その場の自動登録。
 * cwd がワークスペース直下のディレクトリ（またはその下）にあり、そのディレクトリが実在し、隠しでなく、未登録なら、
 * 起動時の syncProjectsFromWorkspace と同じ規則でプロジェクトにして id を返す（結び付けたときは、結び付けたプロジェクトの id）。
 * ワークスペースの外とワークスペースそのものは null（未分類に残し、利用者に知らせる）。
 */
export function registerWorkspaceChildOf(db: Db, deviceId: string, workspaceRoot: string, cwd: string): string | null {
  if (!hasWorkspaceRoot(workspaceRoot)) return null;
  const root = normalizeDir(workspaceRoot);
  const c = normalizeDir(cwd);
  if (!isStrictlyUnder(c, root)) return null;
  const head = path.relative(root, c).split(/[\\/]/)[0]!;
  if (head.startsWith('.')) return null;
  const dir = path.join(root, head);
  // 実在は、NFC にしたパスを開いてではなく、直下の一覧に載っているかで確かめる。
  // ディスク上の名前が NFD のとき、正規化を区別するファイルシステム（Linux など）では NFC のパスでは開けない。
  if (!childDirs(root).some((d) => samePath(d, dir))) return null;
  if (knownRoots(db, deviceId).has(pathKey(dir))) return null;
  return adoptWorkspaceChild(db, deviceId, normalizeDir(dir)).projectId;
}

/**
 * ワークスペースの直下から登録したプロジェクトの数。
 * この PC で解決済みのルートのうち、親がワークスペースのものを数える。スクラッチと消したものは入れない。
 */
export function workspaceProjectCount(db: Db, deviceId: string, workspaceRoot: string): number {
  if (!hasWorkspaceRoot(workspaceRoot)) return 0;
  const rows = db.prepare(`select r.path from project_roots r join projects p on p.id = r.project_id
    where r.device_id = ? and r.resolved = 1 and r.deleted_at is null and p.deleted_at is null and p.is_scratch = 0`).all(deviceId) as { path: string }[];
  const root = path.resolve(workspaceRoot);
  return rows.filter((r) => samePath(path.dirname(r.path), root)).length;
}

/**
 * この PC で場所の分かっているプロジェクトの数（始める前の確認の「プロジェクト」の行）。
 * アーカイブしたものも数える。スクラッチ、消したもの、ほかの PC だけのもの、場所の分からないものは数えない。
 */
export function resolvedProjectCount(db: Db, deviceId: string): number {
  return (db.prepare(`select count(distinct p.id) c from project_roots r join projects p on p.id = r.project_id
    where r.device_id = ? and r.resolved = 1 and r.deleted_at is null and p.deleted_at is null and p.is_scratch = 0`).get(deviceId) as { c: number }).c;
}

/**
 * この端末の解決済みルートを返す。
 * スクラッチのプロジェクトの場所が quick-sessions なら、同じ hangar のホームの前の置き場（scratch）も同じプロジェクトの場所として足す（scratch.ts の scratchPlacesOf）。
 * 前の置き場の下の会話（既存の会話、そこから外のターミナルで始めたものやフォーク）も、いままでどおりクイックセッションに入れるためである。
 * 足すのは完全なパスなので、利用者が自分で作った scratch という名前のフォルダは当たらない。
 */
function resolvedRoots(db: Db, deviceId: string): RootRow[] {
  const rows = db.prepare(`select r.*, p.is_scratch from project_roots r left join projects p on p.id = r.project_id
    where r.device_id = ? and r.resolved = 1 and r.deleted_at is null`).all(deviceId) as (RootRow & { is_scratch: number | null })[];
  return rows.flatMap(({ is_scratch, ...r }) => (is_scratch === 1 ? scratchPlacesOf(r.path).map((p) => ({ ...r, path: p })) : [r]));
}

/** cwd を含むルートのうち、最も深いものを返す。NFC と NFD の違いは無視する。 */
function longestMatch(roots: RootRow[], cwd: string): RootRow | undefined {
  const c = cwd.normalize('NFC');
  return roots.filter((r) => isUnder(c, r.path.normalize('NFC'))).sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * 未分類のセッションを、この端末の解決済みルートの最長一致で紐づける。
 * 一覧から削除したプロジェクトに紐づいたままのセッションも、未分類として拾う。
 * まとめる（mergeProjects）前の行を持っていた PC の索引が、消えたプロジェクトへの紐づけを後から書き戻すことがあるからである。
 * 場所の当たらないものは、そのままにする。
 * 利用者が移したセッション（sessions/move.ts）は、場所ではなく移した先に合わせ直す。古い所属が書き戻されていても戻す。
 */
export function assignSessions(db: Db, deviceId: string): number {
  const roots = resolvedRoots(db, deviceId);
  let n = 0;
  const pinned = db.prepare(`select s.*, st.project_id pin from sessions s
    join session_states st on st.session_id = s.id and st.deleted_at is null and st.project_id is not null
    join projects p on p.id = st.project_id and p.deleted_at is null
    where s.deleted_at is null and (s.project_id is null or s.project_id <> st.project_id)`).all() as Record<string, unknown>[];
  for (const { pin, ...s } of pinned) {
    upsertShared(db, 'sessions', { ...s, project_id: pin }, deviceId);
    touchRow(db, 'projects', pin as string);
    if (typeof s.project_id === 'string') touchRow(db, 'projects', s.project_id);
    n++;
  }
  const sessions = db.prepare(`select * from sessions s where s.deleted_at is null
    and (s.project_id is null or exists (select 1 from projects p where p.id = s.project_id and p.deleted_at is not null))`).all() as Record<string, unknown>[];
  for (const s of sessions) {
    const match = longestMatch(roots, s.cwd as string);
    if (!match) continue;
    upsertShared(db, 'sessions', { ...s, project_id: match.project_id }, deviceId);
    // 入った先のプロジェクトは、行は変わらないが中身（最終の活動、実行中の数）が変わる。
    touchRow(db, 'projects', match.project_id);
    n++;
  }
  return n;
}

/**
 * 未分類のセッション 1 件を、この端末の解決済みルートの最長一致で紐づける。
 * 利用者が移したセッション（sessions/move.ts）は、場所ではなく移した先に紐づける。
 * 紐づけたらプロジェクトの id を返し、既に紐づいているか当たるルートが無ければ null を返す。
 */
export function assignSession(db: Db, deviceId: string, sessionId: string): string | null {
  const s = db.prepare('select * from sessions where id = ? and project_id is null and deleted_at is null').get(sessionId) as Record<string, unknown> | undefined;
  if (!s) return null;
  const projectId = pinnedProjectOf(db, sessionId) ?? longestMatch(resolvedRoots(db, deviceId), s.cwd as string)?.project_id;
  if (!projectId) return null;
  upsertShared(db, 'sessions', { ...s, project_id: projectId }, deviceId);
  return projectId;
}

/**
 * この端末で、同じフォルダを置き場にしている別のプロジェクト。無ければ null。
 * 他の PC が同じフォルダを別の ID で登録していると、同期で同名のプロジェクトが 2 つ並ぶ。
 * 届いた方の場所にそのフォルダを選ぶと、同じフォルダを指すプロジェクトが 2 つになるので、置き場を書く前にここで見る。
 * 綴りの違い（NFC と NFD、Windows の大文字小文字）は同じフォルダとして比べる。一覧から削除したものは数えない。
 */
export function rootConflict(db: Db, deviceId: string, projectId: string, dir: string): { projectId: string; name: string } | null {
  const rows = db.prepare(`select p.id, p.name, r.path from project_roots r join projects p on p.id = r.project_id
    where r.device_id = ? and r.deleted_at is null and p.deleted_at is null and p.id <> ? order by p.id`).all(deviceId, projectId) as { id: string; name: string; path: string }[];
  const target = dir.normalize('NFC');
  const hit = rows.find((r) => samePath(r.path.normalize('NFC'), target));
  return hit ? { projectId: hit.id, name: hit.name } : null;
}

/** 論理削除していないセッションの数を、プロジェクトごとに返す。 */
function sessionCounts(db: Db, ids: string[]): Map<string, number> {
  const out = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return out;
  const rows = db.prepare(`select project_id id, count(*) n from sessions where deleted_at is null and project_id in (${ids.map(() => '?').join(', ')}) group by project_id`).all(...ids) as { id: string; n: number }[];
  for (const r of rows) out.set(r.id, r.n);
  return out;
}

/**
 * 同じフォルダを場所にしているプロジェクトのうち、残す方を先頭に並べる。
 * セッションの多い方を残す。同じなら先に作った方（id は uuidv7 なので、文字列の小さい方）を残す。
 * まとめる方はたいてい、他の PC から届いてこの PC の会話を持たない方である。
 */
function rankToKeep(db: Db, ids: string[]): string[] {
  const n = sessionCounts(db, ids);
  return [...ids].sort((a, b) => n.get(b)! - n.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 「場所を再指定」で選んだフォルダが別のプロジェクト（conflictId）の場所だったときの、まとめる向き。
 * 選んだフォルダがまだ projectId の場所でなければ、選んだ方（projectId）を相手へまとめる。
 * 既に両方の場所になっているとき（直す前の版で二重に結び付けたもの）は、どちらから選んでも同じ向きになるよう rankToKeep で決める。
 */
export function mergeDirection(db: Db, deviceId: string, projectId: string, conflictId: string, dir: string): { fromId: string; intoId: string } {
  const own = db.prepare('select path from project_roots where project_id = ? and device_id = ? and deleted_at is null').get(projectId, deviceId) as { path: string } | undefined;
  if (!own || !samePath(own.path.normalize('NFC'), dir.normalize('NFC'))) return { fromId: projectId, intoId: conflictId };
  const [intoId, fromId] = rankToKeep(db, [projectId, conflictId]) as [string, string];
  return { fromId, intoId };
}

/**
 * この PC で同じフォルダを場所にしているプロジェクトの組。まとめる方の id から、残す方の id と名前を引く。
 * 直す前の版では「場所を再指定」が重複を見なかったので、他の PC から届いた方にも同じフォルダを結び付けられた。その残りを見つけて、まとめる入口に出す。
 * 3 つ以上が同じフォルダなら、残す方 1 つへ、ほかを全部向ける。スクラッチと、一覧から削除したものは数えない。
 * ふつうは組が無く、そのときはセッションを数えない（プロジェクトを配るたびに呼ばれるので軽くしておく）。
 */
export function sameFolderPairs(db: Db, deviceId: string): Map<string, { projectId: string; name: string }> {
  const rows = db.prepare(`select p.id, p.name, r.path from project_roots r join projects p on p.id = r.project_id
    where r.device_id = ? and r.deleted_at is null and p.deleted_at is null and p.is_scratch = 0`).all(deviceId) as { id: string; name: string; path: string }[];
  const groups = new Map<string, { id: string; name: string }[]>();
  for (const r of rows) {
    const key = pathKey(r.path.normalize('NFC'));
    groups.set(key, [...(groups.get(key) ?? []), { id: r.id, name: r.name }]);
  }
  const out = new Map<string, { projectId: string; name: string }>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const [keep, ...rest] = rankToKeep(db, g.map((p) => p.id));
    const name = g.find((p) => p.id === keep)!.name;
    for (const id of rest) out.set(id, { projectId: keep!, name });
  }
  return out;
}

/** まとめた後の 1 つの PC の場所。here はこの PC。deviceName は、分からなければ null。 */
export type MergedRoot = { deviceName: string | null; path: string; here: boolean };

/**
 * from を into へまとめた後の姿（確認のダイアログに出す）。mergeProjects と同じ規則で PC ごとの場所を組む。
 * 並びは、この PC、名前の分かる PC（名前順）、名前の分からない PC の順。
 * sessions は残す方の、fromSessions はまとめる方の、論理削除していないセッションの数である。
 */
export function mergePreview(db: Db, deviceId: string, fromId: string, intoId: string): { roots: MergedRoot[]; sessions: number; fromSessions: number } {
  const liveRoots = db.prepare(`select r.device_id, r.path, d.name from project_roots r left join devices d on d.id = r.device_id and d.deleted_at is null
    where r.project_id = ? and r.deleted_at is null`);
  type Row = { device_id: string; path: string; name: string | null };
  const byDevice = new Map<string, Row>();
  for (const r of liveRoots.all(intoId) as Row[]) byDevice.set(r.device_id, r);
  for (const r of liveRoots.all(fromId) as Row[]) if (!byDevice.has(r.device_id)) byDevice.set(r.device_id, r);
  const order = (r: Row) => (r.device_id === deviceId ? 0 : r.name !== null ? 1 : 2);
  const roots = [...byDevice.values()]
    .sort((a, b) => order(a) - order(b) || (a.name ?? '').localeCompare(b.name ?? '') || a.device_id.localeCompare(b.device_id))
    .map((r) => ({ deviceName: r.device_id === deviceId ? null : r.name, path: r.path, here: r.device_id === deviceId }));
  const n = sessionCounts(db, [fromId, intoId]);
  return { roots, sessions: n.get(intoId)!, fromSessions: n.get(fromId)! };
}

/**
 * プロジェクト from を into へまとめる。from は論理削除し、into の名前と状態は変えない。
 * セッション、TODO、成果物は into へ移す。TODO は into の後ろに、元の順で並べる。
 * メモは、into が空なら移し、両方にあれば into の後ろへ空行を挟んでつなぐ。
 * 置き場は PC ごとに 1 つなので、into がその PC に置き場を持てば into のものを保ち、持たなければ from のものを引き継ぐ。
 * 行の project_id は書き換えず、into の行を作る（消した行があれば戻す）。`(project_id, device_id)` が一意で、消した行もそれに数えるからである。
 * from へ移したセッション（sessions/move.ts）の移した先も into へ付け替える。
 * 途中で失敗したら全部を巻き戻す。
 */
export function mergeProjects(db: Db, deviceId: string, fromId: string, intoId: string): void {
  if (fromId === intoId) throw new Error('mergeProjects: from and into are the same project');
  const live = db.prepare('select * from projects where id = ? and deleted_at is null and is_scratch = 0');
  if (!live.get(fromId) || !live.get(intoId)) throw new Error('mergeProjects: both projects must be live and not scratch');
  db.transaction(() => {
    moveProjectContents(db, deviceId, fromId, intoId);

    const intoRoot = db.prepare('select * from project_roots where project_id = ? and device_id = ?');
    for (const r of db.prepare('select * from project_roots where project_id = ? and deleted_at is null').all(fromId) as RootRow[]) {
      const mine = intoRoot.get(intoId, r.device_id) as RootRow | undefined;
      if (!mine) upsertShared(db, 'project_roots', { id: newId(), project_id: intoId, device_id: r.device_id, path: r.path, resolved: r.resolved }, deviceId);
      else if (mine.deleted_at !== null) upsertShared(db, 'project_roots', { ...mine, path: r.path, resolved: r.resolved, deleted_at: null }, deviceId);
      softDeleteShared(db, 'project_roots', r.id, deviceId);
    }
    softDeleteShared(db, 'projects', fromId, deviceId);
    // 残した方は、行は変わらないが中身（セッション、最終の活動、TODO の数）が変わる。
    touchRow(db, 'projects', intoId);
  })();
}

/** この端末のルートの存在を確かめ、消えたものと戻ったものを報告する。 */
export function checkProjectRoots(db: Db, deviceId: string): { unresolved: string[]; recovered: string[] } {
  const out = { unresolved: [] as string[], recovered: [] as string[] };
  const roots = db.prepare('select * from project_roots where device_id = ? and deleted_at is null').all(deviceId) as RootRow[];
  for (const r of roots) {
    const exists = fs.existsSync(r.path);
    if (exists && r.resolved === 0) { upsertShared(db, 'project_roots', { ...r, resolved: 1 }, deviceId); out.recovered.push(r.project_id); }
    if (!exists && r.resolved === 1) { upsertShared(db, 'project_roots', { ...r, resolved: 0 }, deviceId); out.unresolved.push(r.project_id); }
  }
  return out;
}

/**
 * 未解決のプロジェクトに対する操作を適用する。unlink は行の論理削除だけで、ディレクトリには触れない。
 * unlink では、そのプロジェクトへ移したセッション（sessions/move.ts）の移した印も外す。外したセッションは cwd からの自動の振り分けに戻る。
 */
export function resolveProject(db: Db, deviceId: string, projectId: string, action: ResolveAction): void {
  const root = db.prepare('select * from project_roots where project_id = ? and device_id = ? and deleted_at is null').get(projectId, deviceId) as RootRow | undefined;
  const project = db.prepare('select * from projects where id = ?').get(projectId) as Record<string, unknown> | undefined;
  if (!project) return;
  switch (action.kind) {
    case 'repoint': {
      // `..` や末尾の `/` が残ると longestMatch の前方一致に cwd が当たらず、
      // そのプロジェクトには永久にセッションが紐づかない。必ず正規化してから入れる。
      // 新規登録（POST /api/projects）と同じ扱いである。
      const dir = normalizeDir(action.path);
      if (root) upsertShared(db, 'project_roots', { ...root, path: dir, resolved: 1 }, deviceId);
      else upsertShared(db, 'project_roots', { id: newId(), project_id: projectId, device_id: deviceId, path: dir, resolved: 1 }, deviceId);
      assignSessions(db, deviceId);
      // クイックセッション用のプロジェクトの置き場は、SessionDto の fromScratch（作業の場所がその下にあるか）を決める。
      // 置き場が動くと、行は変わらないのに fromScratch が変わるセッションが出るので、名指しして配り直してもらう。
      // 当たるのは、この端末のセッションのうち、作業の場所が前の置き場か新しい置き場の下にあるものだけである。
      if (project.is_scratch === 1) {
        const roots = [root?.path, dir].filter((p): p is string => typeof p === 'string').map((p) => p.normalize('NFC'));
        const mine = db.prepare('select id, cwd from sessions where home_device = ? and deleted_at is null').all(deviceId) as { id: string; cwd: string }[];
        for (const s of mine) {
          const cwd = s.cwd.normalize('NFC');
          if (roots.some((r) => isStrictlyUnder(cwd, r))) touchRow(db, 'sessions', s.id);
        }
      }
      return;
    }
    case 'archive':
      upsertShared(db, 'projects', { ...project, status: 'archived' }, deviceId);
      return;
    case 'unlink': {
      const sessions = db.prepare('select * from sessions where project_id = ?').all(projectId) as Record<string, unknown>[];
      for (const s of sessions) upsertShared(db, 'sessions', { ...s, project_id: null }, deviceId);
      repointPins(db, deviceId, projectId, null);
      if (root) softDeleteShared(db, 'project_roots', root.id, deviceId);
      softDeleteShared(db, 'projects', projectId, deviceId);
      return;
    }
  }
}

/** 名前が近い直下ディレクトリを名前順に返す。 */
export function candidateDirs(workspaceRoot: string, name: string): string[] {
  const needle = name.toLowerCase();
  return childDirs(workspaceRoot).filter((dir) => {
    const base = path.basename(dir).toLowerCase();
    return base.includes(needle) || needle.includes(base) || (needle.length >= 3 && base.startsWith(needle.slice(0, 3)));
  });
}
