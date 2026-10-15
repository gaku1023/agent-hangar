import fs from 'node:fs';
import path from 'node:path';
import type { ResumeHerePlanDto, ResumeHereReplaceDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { readGitHint } from '../git/hint.ts';
import { EDIT_TOOLS } from '../indexer/indexFile.ts';

/**
 * PC をまたいで会話を続けるときの事実（docs/design.md の「指示の注入」と「この PC で再開」）。
 * どれも hangar の DB とこの PC のファイルの有無だけで決める。前の PC の HEAD や未コミットの差分は知らない。
 */

/** 引き継ぎの段（launch.injection.handover）に埋める事実。名前と OS は PC の行が無ければ null。 */
export type HandoverFacts = {
  prevDevice: string | null; prevPlatform: string | null; prevPath: string;
  device: string | null; platform: string | null; path: string;
  lastAt: number | null; branch: string | null;
  /** その会話が編集系のツールで変えたファイルの数（パスで束ねる）。 */
  editedCount: number;
  /** 編集したファイルのうち、この PC に無いもの。プロジェクトの場所からの相対パスで、最大 MISSING_MAX 件。 */
  missing: string[];
  /** この PC に無いものの全件の数。 */
  missingCount: number;
};

/** 引き継ぎの段に並べる無いファイルの上限。 */
export const MISSING_MAX = 10;

export type DeviceRef = { id: string; name: string | null; platform: string | null };

/** Windows の形のパス（ドライブ文字か UNC）か。前の PC が Windows のときは大文字と小文字を区別しない。 */
function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith('\\\\');
}

/** パスを段に分ける。前の PC が Windows でも macOS でも読めるよう、/ と \ のどちらでも切る。 */
function segmentsOf(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
}

/** target が root の下（root 自身を含む）なら、root からの相対の段を返す。外なら null。 */
function relativeSegments(root: string, target: string): string[] | null {
  const fold = isWindowsPath(root) || isWindowsPath(target);
  const r = segmentsOf(root);
  const t = segmentsOf(target);
  if (t.length < r.length) return null;
  for (let i = 0; i < r.length; i++) {
    const a = fold ? r[i]!.toLowerCase() : r[i]!;
    const b = fold ? t[i]!.toLowerCase() : t[i]!;
    if (a !== b) return null;
  }
  const rest = t.slice(r.length);
  return rest.some((s) => s === '..') ? null : rest;
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** この PC のプロジェクトの場所。行が無い、見つからない（resolved = 0）、フォルダが無いときは null。 */
function hereRoot(db: Db, selfDeviceId: string, projectId: string): string | null {
  const r = db.prepare('select path from project_roots where project_id = ? and device_id = ? and deleted_at is null and resolved = 1 order by updated_at desc limit 1')
    .get(projectId, selfDeviceId) as { path: string } | undefined;
  return r && isDirectory(r.path) ? r.path : null;
}

/**
 * プロジェクトのすべての PC の場所（消していないもの）。
 * 同じプロジェクトの場所は PC ごとに 1 行の前提だが、行が重なっていても読めるよう、長い順に並べて深い方を先に当てる。
 */
function allRoots(db: Db, projectId: string): string[] {
  const rows = db.prepare('select path from project_roots where project_id = ? and deleted_at is null').all(projectId) as { path: string }[];
  return rows.map((r) => r.path).sort((a, b) => segmentsOf(b).length - segmentsOf(a).length);
}

/** 前の PC のパスを、どれかの PC のプロジェクトの場所からの相対の段にする。どの場所の下でもなければ null。 */
function relativeToAnyRoot(roots: string[], p: string): string[] | null {
  for (const root of roots) {
    const rel = relativeSegments(root, p);
    if (rel) return rel;
  }
  return null;
}

/** 消していないプロジェクトのうち、どれかの PC の場所が cwd を含むもの。いちばん深い場所のものを返す。無ければ null。 */
function projectHolding(db: Db, cwd: string): string | null {
  const rows = db.prepare(`select r.project_id, r.path from project_roots r join projects p on p.id = r.project_id and p.deleted_at is null
    where r.deleted_at is null`).all() as { project_id: string; path: string }[];
  let best: { id: string; depth: number } | null = null;
  for (const r of rows) {
    if (!relativeSegments(r.path, cwd)) continue;
    const depth = segmentsOf(r.path).length;
    if (!best || depth > best.depth) best = { id: r.project_id, depth };
  }
  return best?.id ?? null;
}

/** 利用者がプロジェクトを移した会話か（session_states.project_id、sessions/move.ts）。 */
function isMoved(db: Db, sessionId: string | undefined): boolean {
  if (sessionId === undefined) return false;
  return db.prepare('select 1 from session_states where session_id = ? and deleted_at is null and project_id is not null').get(sessionId) !== undefined;
}

/**
 * 前の cwd を読み替える元のプロジェクト。
 * 所属するプロジェクトの場所が cwd を含めば、それを使う。
 * 含まなければ、cwd を含む場所を持つほかのプロジェクトを使う。利用者が別のプロジェクトへ移した会話は、cwd が移した先の場所の下に無いからである。
 * どのプロジェクトの場所も cwd を含まないとき、移していない会話は所属するプロジェクトに倒す（前の cwd が場所の外にあった会話）。
 * 移した会話は倒さずに null を返す。再開の cwd は元のままで、移した先の場所で起こすと別の作業ディレクトリになるからである。
 */
function baseProjectOf(db: Db, s: { id?: string; cwd: string; project_id: string }): string | null {
  if (relativeToAnyRoot(allRoots(db, s.project_id), s.cwd)) return s.project_id;
  const holder = projectHolding(db, s.cwd);
  if (holder) return holder;
  return isMoved(db, s.id) ? null : s.project_id;
}

/**
 * 再開とフォークの作業ディレクトリ。
 * 前の cwd（sessions.cwd）がこの PC にあれば、そのまま使う。
 * 無ければ、前の PC のプロジェクトの場所からの相対パスを、この PC のプロジェクトの場所に継ぐ（worktree や下位のフォルダも）。
 * 継いだ先がこの PC に無ければ、いちばん近いある親（プロジェクトの場所まで）に倒す。
 * 前の cwd がどの場所の下にも無ければ、この PC のプロジェクトの場所にする。
 * 読み替えに使うプロジェクトは、所属ではなく cwd を含む場所を持つもの（baseProjectOf）である。利用者が移した会話でも、元の場所で起こす。
 * プロジェクトに属さない会話と、この PC に場所が無い会話は読み替えられないので null を返す。
 * 共有の行の sessions.cwd は書き換えない。本文の写しの置き場（sync/copy.ts）がその cwd から決まるからである。
 * id を渡すと、移した会話かどうかを見る。渡さなければ移していない会話として読む。
 */
export function resumeCwd(db: Db, selfDeviceId: string, s: { id?: string; cwd: string; project_id: string | null }): string | null {
  if (isDirectory(s.cwd)) return s.cwd;
  if (!s.project_id) return null;
  const base = baseProjectOf(db, { id: s.id, cwd: s.cwd, project_id: s.project_id });
  if (!base) return null;
  const root = hereRoot(db, selfDeviceId, base);
  if (!root) return null;
  const rel = relativeToAnyRoot(allRoots(db, base), s.cwd) ?? [];
  for (let n = rel.length; n > 0; n--) {
    const p = path.join(root, ...rel.slice(0, n));
    if (isDirectory(p)) return p;
  }
  return root;
}

function deviceRow(db: Db, id: string): DeviceRef {
  const d = db.prepare('select name, platform from devices where id = ?').get(id) as { name: string; platform: string } | undefined;
  return { id, name: d?.name ?? null, platform: d?.platform ?? null };
}

/** 会話を最後に動かした PC。run（started_at の新しいもの）が無ければ、作った PC（sessions.home_device）。 */
export function deviceOfSession(db: Db, sessionId: string): DeviceRef | null {
  const r = db.prepare('select device_id from runs where session_id = ? and deleted_at is null order by started_at desc limit 1').get(sessionId) as { device_id: string } | undefined;
  if (r) return deviceRow(db, r.device_id);
  const s = db.prepare('select home_device from sessions where id = ?').get(sessionId) as { home_device: string } | undefined;
  return s ? deviceRow(db, s.home_device) : null;
}

/** その PC のプロジェクトの場所（消していないもの）。行が無ければ null。フォルダの有無は見ない（ほかの PC のパスである）。 */
function deviceRoot(db: Db, deviceId: string, projectId: string): string | null {
  const r = db.prepare('select path from project_roots where project_id = ? and device_id = ? and deleted_at is null order by updated_at desc limit 1')
    .get(projectId, deviceId) as { path: string } | undefined;
  return r?.path ?? null;
}

/** その PC から降ろした主線の写しの末尾の cwd（Claude Code がその PC で動いた作業ディレクトリ）。写しが無いか読めなければ null。 */
function lastCwdOn(db: Db, sessionId: string, deviceId: string): string | null {
  const f = db.prepare('select path from transcript_files where session_id = ? and agent_id is null and device_id = ? order by mtime desc limit 1').get(sessionId, deviceId) as { path: string } | undefined;
  if (!f) return null;
  try { return readGitHint(f.path).cwd; } catch { return null; }
}

/**
 * 前の PC の作業ディレクトリ（引き継ぎの段の prevPath と、確認の 1 枚の前の PC のパス）。
 * sessions.cwd は会話を作った PC のパスなので、A → B → A と戻ったとき、前の PC（B）のパスにはならない。
 * そこで、前の PC の最後の run が動いた作業ディレクトリを、その PC から降ろした写しの末尾の cwd から取る。
 * runs は作業ディレクトリを持たないので、写しの末尾で代える。その run がターンを残さなかったときは、末尾が別の PC の cwd になりうるので、
 * その PC のプロジェクトの場所の下にあるときだけ使う。
 * 使えなければ、前の PC が会話を作った PC なら sessions.cwd、そうでなければその PC のプロジェクトの場所、どれも無ければ sessions.cwd に倒す。
 */
function prevPathOf(db: Db, sessionId: string, prev: DeviceRef | null, s: { cwd: string; project_id: string | null; home_device: string }): string {
  if (!prev) return s.cwd;
  const root = s.project_id ? deviceRoot(db, prev.id, s.project_id) : null;
  const last = lastCwdOn(db, sessionId, prev.id);
  if (last && root && relativeSegments(root, last)) return last;
  if (prev.id === s.home_device) return s.cwd;
  return root ?? s.cwd;
}

/** 本文の末尾のブランチ。本体の本文のうち、いちばん新しく書かれたものから読む。読めなければ null。 */
function lastBranch(db: Db, sessionId: string): string | null {
  const f = db.prepare('select path from transcript_files where session_id = ? and agent_id is null order by mtime desc limit 1').get(sessionId) as { path: string } | undefined;
  if (!f) return null;
  try { return readGitHint(f.path).branch; } catch { return null; }
}

/**
 * 引き継ぎの事実。起こす run の直前の run がほかの PC のもの、または run が無くて会話を作ったのがほかの PC のときだけ返す。
 * この PC で 1 度動いた後は null（直前の run がこの PC になる）。
 * 編集したファイルは event_index の編集系のツールのパスで、プロジェクトの場所からの相対にして、この PC の場所の下で有無を見る。
 * どの場所の下でもないファイルは、有無を決められないので数にだけ入れる。
 * cwd はこの PC で起こす作業ディレクトリ（resumeCwd の値）である。
 */
export function handoverFacts(db: Db, o: { sessionId: string; selfDeviceId: string; cwd: string }): HandoverFacts | null {
  const prev = deviceOfSession(db, o.sessionId);
  if (!prev || prev.id === o.selfDeviceId) return null;
  const s = db.prepare('select cwd, project_id, last_activity_at, home_device from sessions where id = ?').get(o.sessionId) as { cwd: string; project_id: string | null; last_activity_at: number | null; home_device: string } | undefined;
  if (!s) return null;
  const self = deviceRow(db, o.selfDeviceId);
  const marks = EDIT_TOOLS.map(() => '?').join(',');
  const files = (db.prepare(`select file_path from event_index where session_id = ? and tool_name in (${marks}) and file_path is not null and file_path <> '' group by file_path order by min(id)`)
    .all(o.sessionId, ...EDIT_TOOLS) as { file_path: string }[]).map((r) => r.file_path);
  const root = s.project_id ? hereRoot(db, o.selfDeviceId, s.project_id) : null;
  const roots = s.project_id ? allRoots(db, s.project_id) : [];
  const missing: string[] = [];
  if (root) {
    for (const f of files) {
      const rel = relativeToAnyRoot(roots, f);
      if (!rel || rel.length === 0) continue;
      if (!fs.existsSync(path.join(root, ...rel))) missing.push(rel.join('/'));
    }
  }
  return {
    prevDevice: prev.name, prevPlatform: prev.platform, prevPath: prevPathOf(db, o.sessionId, prev, s),
    device: self.name, platform: self.platform, path: o.cwd,
    lastAt: s.last_activity_at, branch: lastBranch(db, o.sessionId),
    editedCount: files.length, missing: missing.slice(0, MISSING_MAX), missingCount: missing.length,
  };
}

/**
 * プロジェクトを使っている PC の数。消していない場所の行を PC ごとに数える。
 * 抜けた PC（devices の行を消したもの）は数えない。PC の行がまだ届いていない場所は数える。
 */
export function projectDeviceCount(db: Db, projectId: string): number {
  const r = db.prepare(`select count(distinct r.device_id) c from project_roots r
    where r.project_id = ? and r.deleted_at is null
      and not exists (select 1 from devices d where d.id = r.device_id and d.deleted_at is not null)`).get(projectId) as { c: number };
  return r.c;
}

/**
 * 「この PC で再開」の確認に出すもの（ResumeHerePlanDto）。無いセッションは null。
 * replace は、手元のトランスクリプトをほかの PC の写しで置き換えるかを答える（sync/copy.ts の compareForResume）。渡さなければ null。
 */
export function resumeHerePlan(db: Db, selfDeviceId: string, sessionId: string, o: { replace?: (sessionId: string) => ResumeHereReplaceDto | null } = {}): ResumeHerePlanDto | null {
  const s = db.prepare('select cwd, project_id, last_activity_at, home_device from sessions where id = ? and deleted_at is null').get(sessionId) as { cwd: string; project_id: string | null; last_activity_at: number | null; home_device: string } | undefined;
  if (!s) return null;
  const prev = deviceOfSession(db, sessionId);
  const self = deviceRow(db, selfDeviceId);
  return {
    sessionId,
    from: { deviceName: prev?.name ?? null, platform: prev?.platform ?? null, path: prevPathOf(db, sessionId, prev, s), lastAt: s.last_activity_at },
    to: { deviceName: self.name, platform: self.platform, path: resumeCwd(db, selfDeviceId, { ...s, id: sessionId }) },
    replace: o.replace?.(sessionId) ?? null,
  };
}
