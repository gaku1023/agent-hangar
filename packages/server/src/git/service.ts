import fs from 'node:fs';
import path from 'node:path';
import type { GitDiffDto, GitDto, GitFileDto, GitSessionDto, GitTreeDto, LiveSessionDto, ProjectGitDto, SessionChangesDto, SessionEditDto, SessionEditsDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { EDIT_TOOLS } from '../indexer/indexFile.ts';
import { changedFilesOf } from '../sessions/files.ts';
import { readEvents } from '../transcript/read.ts';
import { readGitHint } from './hint.ts';
import { diffFile, locateTree, numstatOf, readTreeStatus, type GitExec, type StatusEntry, type TreeLocation } from './status.ts';

// git の表示の受け持ち（0.5.0）。一覧と (i) の件数、変更したファイルの差分、プロジェクトの worktree。
// 値は端末ローカルで、クラウドへは同期しない。git には書かない。

/** 実行中のセッションの根は短く覚え、終わったものは長く覚える。 */
const LIVE_MAX_AGE_MS = 2_000;
const IDLE_MAX_AGE_MS = 60_000;
/** git が止まった根は、この間は呼ばない。 */
const FAILURE_MS = 60_000;
/** 根の見つけ方を覚える長さ（cwd ごと）。 */
const LOCATE_MS = 60_000;
/** 同時に走らせる git の数。 */
const PARALLEL = 2;
/** 本文が伸びてから読み直すまで待つ長さ。続けて書いたものを 1 回にまとめる。 */
const DEBOUNCE_MS = 2_000;
/** 1 つのファイルの編集として返す呼び出しの上限。 */
const MAX_EDITS = 50;

/** 根の見つけ方の覚え。unsafe は持ち主の違いで git が断った場所、null は git のリポジトリではない。 */
type Located = TreeLocation | { unsafe: string } | null;
type TreeEntry = { tree: GitTreeDto; entries: StatusEntry[]; at: number };
type SessionRow = { id: string; cwd: string; provider_session_id: string; has_local: number; has_transcript: number; main_path: string | null; locked: number };

export type GitServiceDeps = {
  db: Db; deviceId: string;
  /** Claude の登録（実行中のセッション）。 */
  live: () => LiveSessionDto[];
  /** 値が変わったときに配る（git.upsert）。 */
  broadcast: (git: GitDto) => void;
  /** git を起こす口。git が見つからなければ null で、どのセッションも nogit にする。 */
  exec: () => GitExec | null;
  now?: () => number;
  debounceMs?: number;
};

/** 小さな数の取り合い。git を同時に PARALLEL 本までにする。 */
class Gate {
  private running = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try { return await fn(); } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

/** パスの比べ方。Windows は大文字と小文字を区別しない。 */
const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

/** 作業ツリーの根からの相対パス（/ 区切り）。根の外なら null。 */
export function relOf(root: string, file: string): string | null {
  const rel = path.relative(root, file);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export class GitService {
  private readonly now: () => number;
  private readonly gate = new Gate(PARALLEL);
  private readonly located = new Map<string, { at: number; value: Located }>();
  private readonly trees = new Map<string, TreeEntry>();
  private readonly inflight = new Map<string, Promise<TreeEntry>>();
  private readonly failedAt = new Map<string, number>();
  /** 一度時間切れになった根。以後は未追跡を数えずに試す。 */
  private readonly heavy = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: GitServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** セッションの行（cwd、他の PC で動いているか、手元の本文があるか、本文の場所）。 */
  private rows(ids: string[]): SessionRow[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => '?').join(',');
    return this.deps.db.prepare(`
      select s.id, s.cwd, s.provider_session_id,
        exists(select 1 from transcript_files t where t.session_id = s.id and t.agent_id is null and t.device_id is null) has_local,
        exists(select 1 from transcript_files t where t.session_id = s.id and t.agent_id is null) has_transcript,
        (select t.path from transcript_files t where t.session_id = s.id and t.agent_id is null order by (t.device_id is null) desc, t.mtime desc limit 1) main_path,
        exists(select 1 from runs r where r.session_id = s.id and r.ended_at is null and r.deleted_at is null and r.device_id <> ?) locked
      from sessions s where s.id in (${marks}) and s.deleted_at is null`).all(this.deps.deviceId, ...ids) as SessionRow[];
  }

  private isLive(row: SessionRow): boolean {
    return this.deps.live().some((l) => l.sessionId === row.provider_session_id);
  }

  private async locate(cwd: string, exec: GitExec): Promise<Located> {
    const key = norm(cwd);
    const hit = this.located.get(key);
    if (hit && this.now() - hit.at < LOCATE_MS) return hit.value;
    const value = await this.gate.run(() => locateTree(cwd, exec));
    this.located.set(key, { at: this.now(), value });
    return value;
  }

  /** 根の状態。maxAge より新しい覚えがあればそれを返す。同じ根への同時の呼び出しは 1 つにまとめる。 */
  private async tree(loc: TreeLocation, exec: GitExec, maxAge: number): Promise<TreeEntry> {
    const key = norm(loc.root);
    const hit = this.trees.get(key);
    const failed = this.failedAt.get(key);
    if (failed !== undefined && this.now() - failed < FAILURE_MS && hit) return hit;
    if (hit && this.now() - hit.at < maxAge) return hit;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.gate.run(async () => {
      const r = await readTreeStatus(loc.root, exec, { now: this.now(), worktree: loc.worktree, mainRoot: loc.mainRoot, untracked: !this.heavy.has(key) });
      if (r.tree.slow) { this.failedAt.set(key, this.now()); this.heavy.add(key); } else this.failedAt.delete(key);
      const entry: TreeEntry = { ...r, at: this.now() };
      this.trees.set(key, entry);
      return entry;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /**
   * 1 件のセッションの手がかりと、その作業ツリー。
   * 他の PC で動いているか、この PC に本文が無いものは git を読まず、本文の gitBranch だけを返す（remote）。
   * 作業ディレクトリは本文の最後の cwd（EnterWorktree で入った worktree）を先に見て、無ければセッションの cwd を使う。
   */
  private async one(row: SessionRow, exec: GitExec | null, maxAge?: number): Promise<{ session: GitSessionDto; tree: TreeEntry | null }> {
    const hint = row.main_path ? readGitHint(row.main_path) : { branch: null, cwd: null, worktree: null };
    if (row.locked === 1 || (row.has_transcript === 1 && row.has_local === 0)) return { session: { state: 'remote', root: null, branch: hint.branch, worktree: hint.worktree?.name ?? null }, tree: null };
    const cwd = [hint.cwd, row.cwd].find((c): c is string => !!c && fs.existsSync(c)) ?? null;
    if (cwd === null) {
      // 作業していた場所が消えた。worktree なら、消した worktree として言う（ブランチは残っていることがある）。
      const wt = hint.worktree?.name ?? (hint.cwd && /[\\/]\.claude[\\/]worktrees[\\/]/.test(hint.cwd) ? path.basename(hint.cwd) : null);
      return { session: wt ? { state: 'gone', root: null, branch: hint.branch, worktree: wt } : { state: 'nogit', root: null, branch: null, worktree: null }, tree: null };
    }
    const loc = exec ? await this.locate(cwd, exec) : null;
    if (!loc || !exec) return { session: { state: 'nogit', root: null, branch: null, worktree: null }, tree: null };
    // 持ち主の違いで git が断った。git でないとはせず、断った場所を持たせる（画面が訳と許し方を言う）。
    if ('unsafe' in loc) return { session: { state: 'unsafe', root: loc.unsafe, branch: hint.branch, worktree: null }, tree: null };
    const tree = await this.tree(loc, exec, maxAge ?? (this.isLive(row) ? LIVE_MAX_AGE_MS : IDLE_MAX_AGE_MS));
    return { session: { state: 'ok', root: tree.tree.root, branch: hint.branch ?? tree.tree.branch, worktree: loc.worktree }, tree };
  }

  /** 一覧と (i) の git。見えている行の分だけ呼ばれる。 */
  async sessions(ids: string[]): Promise<GitDto> {
    const out: GitDto = { sessions: {}, trees: {} };
    const exec = this.deps.exec();
    await Promise.all(this.rows([...new Set(ids)]).map(async (row) => {
      const r = await this.one(row, exec);
      out.sessions[row.id] = r.session;
      if (r.tree) out.trees[r.tree.tree.root] = r.tree.tree;
    }));
    return out;
  }

  /**
   * 実行中のセッションの本文が伸びた。少し待ってから作業ツリーを読み直し、件数かブランチが変わったときだけ配る。
   * 実行中でなければ何もしない。返り値は試験が待つためのもの。
   */
  noteAppended(sessionId: string): Promise<void> {
    const [row] = this.rows([sessionId]);
    if (!row || !this.isLive(row)) return Promise.resolve();
    const delay = this.deps.debounceMs ?? DEBOUNCE_MS;
    const prev = this.timers.get(sessionId);
    if (prev) clearTimeout(prev);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(sessionId);
        void this.refresh(row).finally(resolve);
      }, delay);
      t.unref?.();
      this.timers.set(sessionId, t);
    });
  }

  private async refresh(row: SessionRow): Promise<void> {
    const exec = this.deps.exec();
    if (!exec) return;
    // 読み直す前の値と比べる。覚えは読み直しで書き替わるので、先に写しておく。
    const snapshot = new Map(this.trees);
    const r = await this.one(row, exec, 0);
    if (!r.tree) return;
    const t = r.tree.tree;
    const prev = snapshot.get(norm(t.root))?.tree ?? null;
    if (prev && prev.dirty === t.dirty && prev.branch === t.branch && prev.capped === t.capped && prev.slow === t.slow) return;
    this.deps.broadcast({ sessions: { [row.id]: r.session }, trees: { [t.root]: t } });
  }

  /** そのセッションが編集系のツールで変えたファイル（絶対パス）。 */
  private editedFiles(sessionId: string): string[] {
    return changedFilesOf(this.deps.db, sessionId).files.map((f) => f.path).filter((p) => path.isAbsolute(p));
  }

  /**
   * 「変更したファイル」の差分の一覧。変えたファイルに git の状態を添え、作業ツリーのほかの変更を others に分ける。
   * git でないフォルダや他の PC のセッションは、git の状態を持たずにファイルだけを並べる。
   */
  async changes(sessionId: string): Promise<SessionChangesDto> {
    const [row] = this.rows([sessionId]);
    const files = row ? this.editedFiles(sessionId) : [];
    const plain = (state: SessionChangesDto['state'], root: string | null = null, tree: GitTreeDto | null = null): SessionChangesDto => ({
      state, root, tree, others: [], othersCapped: false,
      files: files.map((f) => ({ path: f, rel: root ? relOf(root, f) ?? f : path.basename(f), status: fs.existsSync(f) ? 'M' : 'D', added: null, deleted: null, binary: false })),
    });
    if (!row) return plain('nogit');
    const exec = this.deps.exec();
    const r = await this.one(row, exec, this.isLive(row) ? LIVE_MAX_AGE_MS : IDLE_MAX_AGE_MS);
    if (r.session.state !== 'ok' || !r.tree || !exec) return plain(r.session.state);
    const { tree, entries } = r.tree;
    const root = tree.root;
    if (tree.slow) return plain('slow', root, tree);
    const byRel = new Map(entries.map((e) => [process.platform === 'win32' ? e.rel.toLowerCase() : e.rel, e]));
    const mine = new Set<string>();
    const fileRows: { path: string; rel: string; status: GitFileDto['status'] }[] = files.map((f) => {
      const rel = relOf(root, f);
      if (rel === null) return { path: f, rel: f, status: 'C' };
      const k = process.platform === 'win32' ? rel.toLowerCase() : rel;
      mine.add(k);
      return { path: f, rel, status: byRel.get(k)?.status ?? 'C' };
    });
    const others = entries.filter((e) => !mine.has(process.platform === 'win32' ? e.rel.toLowerCase() : e.rel));
    const counts = await this.gate.run(() => numstatOf(root, exec, [...fileRows.filter((f) => f.status !== 'C').map((f) => ({ status: f.status, rel: f.rel })), ...others]));
    const withCounts = (f: { path: string; rel: string; status: GitFileDto['status'] }): GitFileDto => {
      const c = counts.get(f.rel);
      return { ...f, added: c?.added ?? null, deleted: c?.deleted ?? null, binary: c?.binary ?? false };
    };
    return { state: 'ok', root, tree, files: fileRows.map(withCounts), others: others.map((e) => withCounts({ path: path.join(root, e.rel), rel: e.rel, status: e.status })), othersCapped: tree.capped };
  }

  /** 1 つのファイルの作業ツリーとの差。そのセッションが変えたファイルでなければ null（呼び手は 404 にする）。git の外なら 'nogit'。 */
  async diff(sessionId: string, file: string): Promise<GitDiffDto | 'nogit' | null> {
    if (!this.editedFiles(sessionId).includes(file)) return null;
    const ch = await this.changes(sessionId);
    const f = ch.files.find((x) => x.path === file);
    const exec = this.deps.exec();
    if (!f || ch.state !== 'ok' || !ch.root || !exec || f.rel === file) return 'nogit';
    return this.gate.run(() => diffFile(ch.root!, f.rel, f.status, exec));
  }

  /** そのファイルへのセッションの編集（トランスクリプトの Edit、MultiEdit、Write）を、結果と一緒に古い順に返す。 */
  edits(sessionId: string, file: string): SessionEditsDto {
    const marks = EDIT_TOOLS.map(() => '?').join(',');
    const rows = this.deps.db.prepare(`select seq, parent_agent from event_index where session_id = ? and kind = 'tool_call' and tool_name in (${marks}) and file_path = ? order by id limit ?`).all(sessionId, ...EDIT_TOOLS, file, MAX_EDITS + 1) as { seq: number; parent_agent: string | null }[];
    const edits: SessionEditDto[] = [];
    for (const r of rows.slice(0, MAX_EDITS)) {
      // 呼び出しの後ろを少しだけ読み、同じ id の結果を探す。
      const page = readEvents(this.deps.db, sessionId, { fromSeq: r.seq, limit: 40, agentId: r.parent_agent });
      const call = page.events.find((e) => e.seq === r.seq && e.kind === 'tool_call');
      if (!call || call.kind !== 'tool_call') continue;
      const res = page.events.find((e) => e.kind === 'tool_result' && e.toolId === call.toolId);
      edits.push({ seq: r.seq, ts: call.ts ?? null, agentId: r.parent_agent, call: { toolId: call.toolId, name: call.name, input: call.input, summary: call.summary }, result: res && res.kind === 'tool_result' ? { text: res.text, isError: res.isError } : null });
    }
    return { file, edits, truncated: rows.length > MAX_EDITS };
  }

  /**
   * プロジェクトの作業ツリーと、git worktree で足した作業ツリー。
   * フォルダがこの PC に無ければ missing、持ち主の違いで git が断れば unsafe を blocked に持たせる。
   */
  async project(dir: string): Promise<ProjectGitDto> {
    if (!fs.existsSync(dir)) return { root: null, worktrees: [], blocked: { kind: 'missing' } };
    const exec = this.deps.exec();
    if (!exec) return { root: null, worktrees: [] };
    const loc = await this.locate(dir, exec);
    if (!loc) return { root: null, worktrees: [] };
    if ('unsafe' in loc) return { root: null, worktrees: [], blocked: { kind: 'unsafe', path: loc.unsafe } };
    const main = loc.mainRoot ? { root: loc.mainRoot, worktree: null, mainRoot: null } : loc;
    const root = (await this.tree(main, exec, IDLE_MAX_AGE_MS)).tree;
    const list = await this.gate.run(() => exec(['worktree', 'list', '--porcelain', '-z'], { cwd: main.root, timeoutMs: 3000 }));
    const worktrees: ProjectGitDto['worktrees'] = [];
    if (list.code === 0) {
      let cur: { path?: string; branch?: string | null } = {};
      const flush = () => {
        if (cur.path && norm(cur.path) !== norm(main.root) && fs.existsSync(cur.path)) worktrees.push({ path: cur.path, name: path.basename(cur.path), branch: cur.branch ?? null, tree: null });
        cur = {};
      };
      for (const f of list.stdout.split('\0')) {
        if (f === '') { flush(); continue; }
        if (f.startsWith('worktree ')) cur.path = path.resolve(f.slice(9));
        else if (f.startsWith('branch ')) cur.branch = f.slice(7).replace(/^refs\/heads\//, '');
        else if (f === 'detached') cur.branch = null;
      }
      flush();
    }
    for (const w of worktrees) {
      const e = await this.tree({ root: w.path, worktree: w.name, mainRoot: main.root }, exec, IDLE_MAX_AGE_MS).catch(() => null);
      w.tree = e?.tree ?? null;
    }
    return { root, worktrees };
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
