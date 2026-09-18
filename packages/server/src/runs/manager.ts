import crypto from 'node:crypto';
import fs from 'node:fs';
import { newId, shortId, type LaunchParams, type LaunchResultDto, type RunDto, type RunKind, type TabDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { buildClaudeArgs } from '../launch/args.ts';
import { renderInjection } from '../launch/injection.ts';
import { ensureWrapperScript, runLogPath } from '../launch/wrapper.ts';
import type { LaunchInput } from '../provider/types.ts';
import type { Tmux } from '../tmux/tmux.ts';
import { getRun, getTab, listActiveRuns, listTabs } from './queries.ts';

/** HTTP の状態コードを持つ失敗。呼び手はそのまま応答に使える。 */
export class RunError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'RunError';
  }
}

export type LaunchResult = LaunchResultDto;
export type RunListener = { runStarted?(r: LaunchResult): void; runUpdated?(run: RunDto): void; runEnded?(run: RunDto): void; tabChanged?(tab: TabDto): void };
export type RunManagerDeps = { db: Db; deviceId: string; home: string; tmux: Tmux | null; claudeBin: string; port: number; token: string; shell?: string; isLive?: (providerSessionId: string) => boolean; now?: () => number };

type ProjectInfo = { id: string; name: string; path: string | null; resolved: boolean };

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** run の寿命を管理する。この段階では起動だけで、終了検知と heartbeat とシェルタブは後の課題で足す。 */
export class RunManager {
  private listeners = new Set<RunListener>();

  constructor(private readonly deps: RunManagerDeps) {}

  on(l: RunListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit<K extends keyof RunListener>(k: K, arg: Parameters<NonNullable<RunListener[K]>>[0]): void {
    for (const l of this.listeners) (l[k] as ((a: typeof arg) => void) | undefined)?.(arg);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get db(): Db {
    return this.deps.db;
  }

  private tmux(): Tmux {
    if (!this.deps.tmux) throw new RunError(400, 'tmux が見つかりません。Settings で tmuxPath を設定してください');
    return this.deps.tmux;
  }

  private project(projectId: string): ProjectInfo {
    const r = this.db
      .prepare('select p.id, p.name, r.path, r.resolved from projects p left join project_roots r on r.project_id = p.id and r.device_id = ? and r.deleted_at is null where p.id = ? and p.deleted_at is null')
      .get(this.deps.deviceId, projectId) as { id: string; name: string; path: string | null; resolved: number | null } | undefined;
    if (!r) throw new RunError(404, 'プロジェクトが見つかりません');
    return { id: r.id, name: r.name, path: r.path, resolved: r.resolved === 1 };
  }

  private mcpUrl(sessionId: string): string {
    return `http://127.0.0.1:${this.deps.port}/mcp/s/${sessionId}`;
  }

  /** 起動できるかを先に確かめる。行を作る前に呼ぶので、失敗しても孤児の行が残らない。 */
  private precheck(cwd: string): Tmux {
    if (!isDirectory(cwd)) throw new RunError(400, `ディレクトリが見つかりません: ${cwd}`);
    return this.tmux();
  }

  /** 注入する指示。プロジェクトが無ければ「未分類」として cwd だけを書く。 */
  private injectionFor(projectId: string | null, cwd: string): string {
    const p = projectId ? this.project(projectId) : null;
    const memo = projectId ? (this.db.prepare('select markdown from project_memos where project_id = ? and deleted_at is null').get(projectId) as { markdown: string } | undefined)?.markdown ?? null : null;
    const todos = projectId ? (this.db.prepare('select text from todos where project_id = ? and done = 0 and deleted_at is null order by position limit 10').all(projectId) as { text: string }[]).map((t) => t.text) : [];
    return renderInjection({ projectName: p?.name ?? '未分類', projectPath: cwd, memo, todos });
  }

  private baseInput(sessionId: string, projectId: string | null, cwd: string, params: LaunchParams): Omit<LaunchInput, 'mode'> {
    const s = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
    return {
      systemPrompt: this.injectionFor(projectId, cwd),
      mcpUrl: this.mcpUrl(sessionId),
      token: this.deps.token,
      name: s(params.name),
      prompt: s(params.prompt),
      model: s(params.model),
      effort: s(params.effort),
      permissionMode: s(params.permissionMode),
      worktree: s(params.worktree),
      addDirs: (params.addDirs ?? []).map((d) => d.trim()).filter(Boolean),
    };
  }

  /** run の行を作り、tmux セッションで claude を起こす。失敗したら run を閉じて 400 を投げる。 */
  private launch(o: { sessionId: string; cwd: string; kind: RunKind; input: LaunchInput; params: LaunchParams }): LaunchResult {
    const tmux = this.precheck(o.cwd);
    const runId = newId();
    const tmuxName = `hangar-${shortId(runId)}`;
    const wrapper = ensureWrapperScript(this.deps.home);
    const log = runLogPath(this.deps.home, runId);
    // ラッパーはプロセス置換を使うので、sh ではなく bash で起こす。
    const command = ['env', `HANGAR_RUN_ID=${runId}`, 'bash', wrapper, log, this.deps.claudeBin, ...buildClaudeArgs(o.input)];
    const now = this.now();
    upsertShared(this.db, 'runs', { id: runId, session_id: o.sessionId, device_id: this.deps.deviceId, kind: o.kind, tmux_name: tmuxName, pid: null, launch_params: JSON.stringify(o.params), started_at: now, ended_at: null, end_reason: null, heartbeat_at: now }, this.deps.deviceId);
    try {
      tmux.newSession({ name: tmuxName, cwd: o.cwd, command });
      tmux.setOption(tmuxName, 'status', 'off');
    } catch (e) {
      this.end(runId, 'exited');
      throw new RunError(400, `tmux の起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
    const result: LaunchResult = { run: getRun(this.db, runId)!, sessionId: o.sessionId, tabs: listTabs(this.db, runId) };
    this.emit('runStarted', result);
    return result;
  }

  /** run を終了として閉じる。すでに閉じていれば何もしない。 */
  private end(runId: string, reason: 'exited' | 'killed' | 'lost'): RunDto | null {
    const row = this.db.prepare('select * from runs where id = ? and deleted_at is null').get(runId) as Record<string, unknown> | undefined;
    if (!row || row.ended_at !== null) return null;
    upsertShared(this.db, 'runs', { ...row, ended_at: this.now(), end_reason: reason }, this.deps.deviceId);
    const run = getRun(this.db, runId)!;
    this.emit('runEnded', run);
    return run;
  }

  /** 新しいセッションを起こす。検査をすべて先に済ませてから行を作る。 */
  start(params: LaunchParams): LaunchResult {
    if (params.scratch) throw new RunError(400, 'スクラッチはフェーズ 3 で実装します');
    if (!params.projectId) throw new RunError(400, 'projectId は必須です');
    const p = this.project(params.projectId);
    if (!p.path || !p.resolved) throw new RunError(400, 'プロジェクトのディレクトリがこの端末で見つかりません');
    this.precheck(p.path);
    const sessionUuid = crypto.randomUUID();
    const sessionId = ensureSession(this.db, sessionUuid, p.path, this.deps.deviceId);
    const now = this.now();
    const cur = this.db.prepare('select * from sessions where id = ?').get(sessionId) as Record<string, unknown>;
    upsertShared(this.db, 'sessions', { ...cur, project_id: p.id, name: params.name?.trim() || null, started_at: now, last_activity_at: now }, this.deps.deviceId);
    const input: LaunchInput = { ...this.baseInput(sessionId, p.id, p.path, params), mode: { kind: 'start', sessionUuid } };
    return this.launch({ sessionId, cwd: p.path, kind: 'start', input, params });
  }

  /** 生きた run と、開いたシェルタブが残る run。UI の bootstrap と GET /api/runs が使う。 */
  listAlive(): { runs: RunDto[]; tabs: TabDto[] } {
    const runs = listActiveRuns(this.db, this.deps.deviceId);
    return { runs, tabs: runs.flatMap((r) => listTabs(this.db, r.id)) };
  }

  getRun(id: string): RunDto | null {
    return getRun(this.db, id);
  }

  getTab(id: string): TabDto | null {
    return getTab(this.db, id);
  }
}
