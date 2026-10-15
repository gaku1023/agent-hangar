import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FolderCandidateDto, FolderCandidatesDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { gitFolderOf, gitRemoteOf } from '../git/remote.ts';
import { gitRootOf } from '../git/repoRoot.ts';
import { isStrictlyUnder, isUnder, pathKey, samePath } from '../platform/paths.ts';
import { hasWorkspaceRoot, normalizeDir } from './registry.ts';
import { candidateNotes, cloudSyncedOf, defaultCloudSyncEnv, type CloudSyncEnv } from './candidateHints.ts';
import { scratchRoot } from './scratch.ts';

/**
 * Claude Code と会話したフォルダの候補（初日のプロジェクト。2026-10-13）。
 * homeDir は利用者のホーム、hangarHome は hangar の手元（スクラッチの置き場を引く）、tmpDirs は一時フォルダの置き場である。
 * workspaceRoot は設定の作成場所で、空のときだけ作成場所の候補（suggestedRoot）を出す。
 */
export type CandidateEnv = { homeDir?: string; hangarHome: string; tmpDirs?: string[]; workspaceRoot: string; now?: number; cloud?: CloudSyncEnv };

/** 一時フォルダの置き場。実体のパス（macOS は /private/var/folders）と、よく使われる別名も入れる。 */
export function defaultTmpDirs(platform: NodeJS.Platform = process.platform): string[] {
  const out = new Set<string>([os.tmpdir()]);
  try { out.add(fs.realpathSync(os.tmpdir())); } catch { /* 無ければそのまま */ }
  if (platform !== 'win32') for (const p of ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders']) out.add(p);
  return [...out];
}

/** パスのどこかに隠しの名前（. で始まる名前）を含むか。 */
function hasHiddenPart(p: string): boolean {
  return p.split(/[\\/]/).some((part) => part.startsWith('.') && part !== '.' && part !== '..');
}

type Group = { path: string; sessions: number; last: number | null; worktrees: Set<string> };

/**
 * まだプロジェクトに入っていない、この PC の会話の作業フォルダを、git のリポジトリの根でまとめて返す。
 * worktree は元のリポジトリへまとめ、まとめた worktree の数を添える。
 * ホームフォルダとその上、一時フォルダ、hangar のスクラッチ、隠しの名前を含むもの、無くなったフォルダ、
 * この PC で登録済みのプロジェクトの場所とその下は除く。
 * 並びは会話の数の多い順で、同じ数なら最後の活動の新しい順にする。
 * 作成場所が空で、過半（2 件以上）が同じ親フォルダにあるときだけ、その親を作成場所の候補にする。親がホームフォルダのときは出さない。
 */
export function folderCandidates(db: Db, deviceId: string, env: CandidateEnv): FolderCandidatesDto {
  const home = normalizeDir(env.homeDir ?? os.homedir());
  const tmps = (env.tmpDirs ?? defaultTmpDirs()).map((p) => normalizeDir(p));
  const scratch = normalizeDir(scratchRoot(env.hangarHome));
  const known = (db.prepare(`select r.path from project_roots r join projects p on p.id = r.project_id
    where r.device_id = ? and r.deleted_at is null and p.deleted_at is null`).all(deviceId) as { path: string }[]).map((r) => normalizeDir(r.path));
  const rows = db.prepare(`select cwd, count(*) n, max(last_activity_at) last from sessions
    where home_device = ? and project_id is null and deleted_at is null group by cwd`).all(deviceId) as { cwd: string; n: number; last: number | null }[];

  /** ホームフォルダかその上（根を含む）。 */
  const aboveHome = (p: string) => samePath(p, home) || isStrictlyUnder(home, p) || p === path.parse(p).root;
  const excluded = (p: string) => aboveHome(p) || hasHiddenPart(path.relative(path.parse(p).root, p))
    || tmps.some((t) => isUnder(p, t)) || isUnder(p, scratch) || known.some((k) => isUnder(p, k));

  const groups = new Map<string, Group>();
  /**
   * 作業フォルダ（DB のままの文字列）から、入った候補の鍵。
   * 最近の会話の題を候補へ振り分けるのに使う。
   */
  const rootOfCwd = new Map<string, string>();
  for (const r of rows) {
    if (!r.cwd) continue;
    const cwd = normalizeDir(r.cwd);
    if (!path.isAbsolute(r.cwd)) continue;
    const g = gitRootOf(cwd);
    // リポジトリの根がホームかその上にあるとき（ホームそのものを git で管理しているなど）は、まとめずに作業フォルダのまま見る。
    const root = g.found && !aboveHome(normalizeDir(g.root)) ? normalizeDir(g.root) : cwd;
    const worktree = g.found && g.worktree && root !== cwd;
    if (excluded(root)) continue;
    const key = pathKey(root);
    rootOfCwd.set(r.cwd, key);
    const cur = groups.get(key) ?? { path: root, sessions: 0, last: null, worktrees: new Set<string>() };
    cur.sessions += r.n;
    if (r.last !== null && (cur.last === null || r.last > cur.last)) cur.last = r.last;
    if (worktree) cur.worktrees.add(pathKey(gitRootOfWorktree(cwd)));
    groups.set(key, cur);
  }

  const kept = [...groups.values()].filter((g) => fs.statSync(g.path, { throwIfNoEntry: false })?.isDirectory() ?? false);
  const titles = recentTitlesOf(db, deviceId, rootOfCwd, new Set(kept.map((g) => pathKey(g.path))));
  const now = env.now ?? Date.now();
  const cloud = env.cloud ?? defaultCloudSyncEnv(home);
  const candidates: FolderCandidateDto[] = kept
    .map((g) => {
      const base = { path: g.path, sessionCount: g.sessions, lastActivityAt: g.last, worktreeCount: g.worktrees.size };
      const isGit = gitFolderOf(g.path).git;
      return {
        ...base,
        recentTitles: titles.get(pathKey(g.path)) ?? [],
        isGit,
        gitRemote: isGit ? gitRemoteOf(g.path) : null,
        enclosedBy: enclosedByOf(g.path, kept.map((k) => k.path), known),
        cloudSynced: cloudSyncedOf(g.path, cloud),
        notes: candidateNotes({ ...base, isGit }, { homeDir: home, now }),
      };
    })
    .sort((a, b) => b.sessionCount - a.sessionCount || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.path.localeCompare(b.path));

  const unassignedTotal = (db.prepare('select count(*) c from sessions where home_device = ? and project_id is null and deleted_at is null').get(deviceId) as { c: number }).c;
  return {
    candidates,
    suggestedRoot: hasWorkspaceRoot(env.workspaceRoot) ? null : suggestRoot(candidates.map((c) => c.path), home),
    unassignedTotal,
    workspaceRoot: hasWorkspaceRoot(env.workspaceRoot) ? env.workspaceRoot : null,
  };
}

/** 最近の会話の題の数の上限。 */
const RECENT_TITLES = 3;
/** 最初の発言から採るときの字数（一覧の表示名と同じ）。 */
const PROMPT_HEAD = 40;

/**
 * 改行と続く空白を 1 つの空白にし、前後を落とす。
 * 空なら null。
 */
function oneLine(s: string | null): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

/**
 * 候補ごとの最近の会話の題（新しい順に 3 件まで）。
 * 題は、本文の題（custom_title）、hangar で付けた名前、AI の題、要約の 1 文、最初の発言の冒頭の順に採る。
 * どれも無い会話は飛ばす。
 * rootOfCwd は作業フォルダから候補の鍵（pathKey）を引く表で、候補に残らなかったものは数えない。
 */
function recentTitlesOf(db: Db, deviceId: string, rootOfCwd: Map<string, string>, keep: Set<string>): Map<string, string[]> {
  const rows = db.prepare(`select s.cwd, s.custom_title, sn.name sn_name, s.ai_title, ss.one_liner, s.first_prompt from sessions s
    left join session_notes sn on sn.session_id = s.id and sn.deleted_at is null
    left join session_summaries ss on ss.session_id = s.id and ss.deleted_at is null
    where s.home_device = ? and s.project_id is null and s.deleted_at is null
    order by s.last_activity_at desc nulls last, s.id`).all(deviceId) as { cwd: string; custom_title: string | null; sn_name: string | null; ai_title: string | null; one_liner: string | null; first_prompt: string | null }[];
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const key = rootOfCwd.get(r.cwd);
    if (key === undefined || !keep.has(key)) continue;
    const list = out.get(key) ?? [];
    if (list.length >= RECENT_TITLES) continue;
    const prompt = oneLine(r.first_prompt);
    const title = oneLine(r.custom_title) ?? oneLine(r.sn_name) ?? oneLine(r.ai_title) ?? oneLine(r.one_liner) ?? (prompt === null ? null : [...prompt].slice(0, PROMPT_HEAD).join(''));
    if (title === null) continue;
    list.push(title);
    out.set(key, list);
  }
  return out;
}

/**
 * 候補を下に持つ場所のうち、いちばん深いもの。
 * 登録済みのプロジェクトの下は候補から除いているので、ふつうは candidate だけが当たる（念のため project も見る）。
 */
function enclosedByOf(p: string, candidates: string[], projects: string[]): FolderCandidateDto['enclosedBy'] {
  const deepest = (list: string[]) => list.filter((d) => isStrictlyUnder(p, d)).sort((a, b) => b.length - a.length)[0];
  const project = deepest(projects);
  if (project !== undefined) return { kind: 'project', path: project };
  const candidate = deepest(candidates);
  return candidate === undefined ? null : { kind: 'candidate', path: candidate };
}

/** worktree の中のフォルダから、その worktree の最上位（.git ファイルのあるフォルダ）を求める。数を数えるためだけに使う。 */
function gitRootOfWorktree(cwd: string): string {
  for (let d = cwd; ; d = path.dirname(d)) {
    if (fs.statSync(path.join(d, '.git'), { throwIfNoEntry: false })?.isFile()) return d;
    if (path.dirname(d) === d) return cwd;
  }
}

/** 過半（2 件以上）が同じ親フォルダにあれば、その親。親がホームフォルダか、その上のときは出さない。 */
function suggestRoot(paths: string[], home: string): string | null {
  const counts = new Map<string, { dir: string; n: number }>();
  for (const p of paths) {
    const dir = path.dirname(p);
    const cur = counts.get(pathKey(dir)) ?? { dir, n: 0 };
    cur.n++;
    counts.set(pathKey(dir), cur);
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  if (!best || best.n < 2 || best.n * 2 <= paths.length) return null;
  if (samePath(best.dir, home) || isStrictlyUnder(home, best.dir)) return null;
  return best.dir;
}
