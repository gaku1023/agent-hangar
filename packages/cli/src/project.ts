import os from 'node:os';
import path from 'node:path';
import { samePath } from '@agent-hangar/server/src/cliEntry.ts';
import type { CandidateNote, FolderCandidateDto, FolderCandidatesDto, FolderRegisterOutcomeDto, FolderRegisterPreviewDto, FolderRegisterResultDto, ProjectDto, SettingsDto, UnlinkPreviewDto, WorkspaceRootPreviewDto } from '@agent-hangar/shared';
import { serverDownMessage } from './probe.ts';

/**
 * hangar project（candidates、add、remove）と hangar workspace（set、unset）。
 * 2026-10-15。
 * セットアップのすゝめで、Claude Code が Bash から叩く道具である。
 * 端末が無い（TTY が無い）前提なので、対話の y/n は作らない。
 * 承諾は Claude の会話の中で取り、書く前の見せ方は --dry-run だけにする（問いを飛ばす旗は作らない）。
 *
 * どれも動いているサーバの API を鍵（Bearer）付きで呼ぶ。
 * サーバは起こさない。
 * 終了の符号は、全部成功が 0、一部でも失敗が 1、サーバが止まっているときが 2 である。
 * --json は標準出力に 1 行の JSON を出す。
 * 失敗は { error: 符号, message } の形で、サーバが止まっているときは { error: 'server_down', hint: 'hangar start' } である。
 */

/**
 * 呼び出しの共通の入力。
 * log は標準出力、error は標準エラーの代わりで、試験が差し替える。
 */
export type ApiCommandOptions = {
  port: number;
  token: string;
  json: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

/**
 * 失敗の符号。
 * server_down だけは終了の符号が 2 になる。
 */
type FailCode = 'server_down' | 'unauthorized' | 'rejected' | 'http_error' | 'timeout' | 'not_found' | 'scratch' | 'ambiguous' | 'outdated';

class CommandError extends Error {
  constructor(readonly code: FailCode, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CommandError';
  }
}

/**
 * 応答を待つ上限。
 * 候補は会話の作業フォルダを全部たどるので、ほかより長めにとる。
 */
const TIMEOUT_MS = 30_000;

/** 試しの終わりに添える 1 行。 */
const DRY_NOTE = '試しなので、何も書いていません。';
/** 一覧から削除で、会話がどうなるか。 */
const REMOVE_KEEPS = '会話は未分類に戻るだけで、本文は消えません。フォルダにも触れません。';
/** 作成場所を空にしたときに、何が残り何が止まるか。 */
const UNSET_EFFECT = '登録済みのプロジェクトはそのまま残ります。作成場所の直下の自動の登録は止まり、新しいフォルダはアプリで作るときに場所を選びます。';

/**
 * 鍵付きで 1 回呼ぶ。
 * 繋がらなければ server_down、鍵が合わなければ unauthorized、400 台はサーバの文のまま rejected にする。
 */
async function call<T>(o: ApiCommandOptions, method: 'GET' | 'POST' | 'PATCH', apiPath: string, body?: unknown): Promise<T> {
  const fetchFn = o.fetch ?? fetch;
  let r: Response;
  try {
    r = await fetchFn(`http://127.0.0.1:${o.port}${apiPath}`, {
      method,
      headers: { authorization: `Bearer ${o.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') throw new CommandError('timeout', `サーバが ${TIMEOUT_MS / 1000} 秒のうちに応えませんでした`);
    throw new CommandError('server_down', serverDownMessage(o.port));
  }
  let parsed: unknown = null;
  try { parsed = await r.json(); } catch { parsed = null; }
  if (r.status === 401 || r.status === 403) throw new CommandError('unauthorized', '鍵が合いません。サーバと同じ HANGAR_HOME で実行しているか確かめてください');
  if (!r.ok) {
    const message = typeof (parsed as { error?: unknown } | null)?.error === 'string' ? (parsed as { error: string }).error : `HTTP ${r.status}`;
    if (r.status >= 400 && r.status < 500 && r.status !== 404) throw new CommandError('rejected', message);
    throw new CommandError('http_error', message, { status: r.status });
  }
  return parsed as T;
}

/** 失敗を出して終了の符号を返す。 */
function fail(o: ApiCommandOptions, e: unknown): number {
  if (!(e instanceof CommandError)) throw e;
  const log = o.log ?? ((l: string) => console.log(l));
  const error = o.error ?? ((l: string) => console.error(l));
  if (o.json) log(JSON.stringify(e.code === 'server_down' ? { error: 'server_down', hint: 'hangar start' } : { error: e.code, message: e.message, ...e.extra }));
  else error(e.message);
  return e.code === 'server_down' ? 2 : 1;
}

/** 失敗の扱いを包んで走らせる。 */
async function guarded(o: ApiCommandOptions, run: (log: (l: string) => void) => Promise<number>): Promise<number> {
  try {
    return await run(o.log ?? ((l: string) => console.log(l)));
  } catch (e) {
    return fail(o, e);
  }
}

/**
 * 先頭の ~ をホームに直し、cwd から絶対にする。
 * サーバは相対のパスを断るので、打った場所から解決して送る。
 */
export function absolutePath(raw: string, o: { cwd?: string; homeDir?: string } = {}): string {
  const home = o.homeDir ?? os.homedir();
  const expanded = raw === '~' ? home : /^~[\\/]/.test(raw) ? path.join(home, raw.slice(2)) : raw;
  return path.resolve(o.cwd ?? process.cwd(), expanded);
}

// ---- candidates ----

const NOTE_LABEL: Record<CandidateNote, string> = {
  'desktop-direct': 'デスクトップの直下',
  'downloads-direct': 'ダウンロードの直下',
  'not-git': 'git なし',
  'stale-30d': '30 日より前',
  'single-session': '会話 1 件',
};
const CLOUD_LABEL = { icloud: 'iCloud で同期', onedrive: 'OneDrive で同期' } as const;

/**
 * 日付（YYYY-MM-DD）。
 * timeZone を省けばこの PC の時刻で読む。
 */
function day(ms: number | null, timeZone: string | undefined): string {
  if (ms === null) return '----------';
  return new Date(ms).toLocaleDateString('sv-SE', { timeZone });
}

/**
 * 候補 1 件の注記。
 * サーバの符号を日本語の短い言葉にする。
 */
function candidateMarks(c: FolderCandidateDto): string[] {
  const marks = (c.notes ?? []).map((n) => NOTE_LABEL[n] ?? n);
  if (c.cloudSynced) marks.push(CLOUD_LABEL[c.cloudSynced]);
  if (c.enclosedBy) marks.push(`${c.enclosedBy.kind === 'candidate' ? '候補' : 'プロジェクト'} ${c.enclosedBy.path} の中`);
  if (c.worktreeCount > 0) marks.push(`worktree ${c.worktreeCount}`);
  return marks;
}

/**
 * 人向けの候補の一覧。
 * 1 行 1 候補で、会話の数、最終日、パス、注記を並べる。
 */
export function formatCandidates(dto: FolderCandidatesDto, o: { timeZone?: string } = {}): string[] {
  const lines: string[] = [];
  if (dto.unassignedTotal !== undefined) lines.push(`この PC の未分類の会話: ${dto.unassignedTotal} 件`);
  if (dto.workspaceRoot !== undefined) lines.push(`作成場所: ${dto.workspaceRoot ?? '未設定'}`);
  if (dto.candidates.length === 0) lines.push('候補はありません。');
  else {
    lines.push(`候補 ${dto.candidates.length} 件（会話の多い順）:`);
    for (const c of dto.candidates) {
      const marks = candidateMarks(c);
      lines.push(`  会話 ${String(c.sessionCount).padStart(3)} 件  ${day(c.lastActivityAt, o.timeZone)}  ${c.path}${marks.length ? `  [${marks.join('、')}]` : ''}`);
    }
  }
  if (dto.suggestedRoot) lines.push(`作成場所の候補: ${dto.suggestedRoot}（hangar workspace set で決められます）`);
  return lines;
}

/** hangar project candidates。 */
export function candidatesCommand(o: ApiCommandOptions): Promise<number> {
  return guarded(o, async (log) => {
    const dto = await call<FolderCandidatesDto>(o, 'GET', '/api/workspace/candidates');
    if (o.json) log(JSON.stringify(dto));
    else for (const l of formatCandidates(dto)) log(l);
    return 0;
  });
}

// ---- add ----

/**
 * 登録の 1 行の結果を、人向けの 1 行にする。
 * dry は試し（これから行う形の言い方）。
 */
export function outcomeLine(r: FolderRegisterOutcomeDto, dry: boolean): string {
  const into = (n: number | undefined) => `未分類の会話 ${n ?? 0} 件が${dry ? '入ります' : '入りました'}`;
  switch (r.status) {
    case 'added': return `${dry ? '登録します' : '登録しました'}: ${r.path}（名前 ${r.name}、${into(r.sessionCount)}）`;
    case 'already': return `登録済み: ${r.path}（名前 ${r.name}${r.restored ? `。アーカイブから${dry ? '戻します' : '戻しました'}` : ''}）`;
    case 'linked': return `${dry ? '結び付けます' : '結び付けました'}: ${r.path}（ほかの PC のプロジェクト ${r.name}、${into(r.sessionCount)}）`;
    case 'nested': return `登録できません: ${r.path}（プロジェクト ${r.enclosing?.name}（${r.enclosing?.path}）の中にあります。別のプロジェクトに分けるかは、アプリで決めてください）`;
    default: return `登録できません: ${r.path}（${r.error ?? '理由が分かりません'}）`;
  }
}

/**
 * 失敗に数える結果か。
 * 登録済みは冪等なので失敗に数えない。
 */
const failed = (r: FolderRegisterOutcomeDto): boolean => r.status === 'nested' || r.status === 'error';

/**
 * hangar project add <パス…>。
 * 入れ子は失敗として返す（包むプロジェクトから分けるかは、利用者がアプリで決める。CLI から分ける旗は作らない）。
 * 1 件が失敗しても残りは続け、全件の結果を出す。
 */
export function projectAddCommand(o: ApiCommandOptions & { paths: string[]; dryRun: boolean; cwd?: string; homeDir?: string }): Promise<number> {
  return guarded(o, async (log) => {
    const paths = o.paths.map((p) => absolutePath(p, o));
    const body = o.dryRun ? { paths, dryRun: true } : { paths };
    const res = await call<FolderRegisterPreviewDto | FolderRegisterResultDto>(o, 'POST', '/api/workspace/register', body);
    const results = res.results;
    if (!results) throw new CommandError('outdated', 'サーバが古く、行ごとの結果を返しません。アプリを新しくしてください');
    const ok = !results.some(failed);
    if (o.json) log(JSON.stringify({ ok, dryRun: o.dryRun, results }));
    else {
      for (const r of results) log(outcomeLine(r, o.dryRun));
      if (o.dryRun) log(DRY_NOTE);
    }
    return ok ? 0 : 1;
  });
}

// ---- remove ----

/** id か、この PC の場所のパスで、プロジェクトを 1 つ選ぶ。 */
function pickProject(list: ProjectDto[], target: string, o: { cwd?: string; homeDir?: string }): ProjectDto {
  const byId = list.find((p) => p.id === target);
  const hits = byId ? [byId] : (() => {
    const want = absolutePath(target, o).normalize('NFC');
    return list.filter((p) => p.path !== null && samePath(p.path.normalize('NFC'), want));
  })();
  if (hits.length === 0) throw new CommandError('not_found', `${target} に当たるプロジェクトがありません（id か、この PC の場所のパスを渡してください）`);
  if (hits.length > 1) throw new CommandError('ambiguous', `${target} に当たるプロジェクトが ${hits.length} 件あります。id で選んでください: ${hits.map((p) => `${p.id}（${p.name}）`).join('、')}`, { ids: hits.map((p) => p.id) });
  const hit = hits[0]!;
  if (hit.isScratch) throw new CommandError('scratch', 'スクラッチ（クイックセッションの置き場）は一覧から削除できません');
  return hit;
}

/**
 * hangar project remove <パス|id>。
 * アプリの「一覧から削除」と同じ経路（resolve の unlink）を通す。
 * 会話は未分類に戻り、プロジェクトは論理削除になる。
 * 同期を使っているかは、試しの応答から読む。
 * 本番でも先に試しを呼んで、それを出す。
 */
export function projectRemoveCommand(o: ApiCommandOptions & { target: string; dryRun: boolean; cwd?: string; homeDir?: string }): Promise<number> {
  return guarded(o, async (log) => {
    const p = pickProject(await call<ProjectDto[]>(o, 'GET', '/api/projects'), o.target, o);
    const resolvePath = `/api/projects/${encodeURIComponent(p.id)}/resolve`;
    const preview = await call<UnlinkPreviewDto>(o, 'POST', resolvePath, { kind: 'unlink', dryRun: true });
    let sessionCount = preview.sessionCount;
    if (!o.dryRun) {
      const done = await call<{ id: string; unlinked?: boolean; sessionCount?: number }>(o, 'POST', resolvePath, { kind: 'unlink' });
      sessionCount = done.sessionCount ?? sessionCount;
    }
    if (o.json) {
      log(JSON.stringify({ ok: true, dryRun: o.dryRun, project: { id: p.id, name: p.name, path: p.path }, sessionCount, syncing: preview.syncing }));
      return 0;
    }
    log(`${o.dryRun ? '一覧から削除します' : '一覧から削除しました'}: ${p.name}（${p.path ?? 'この PC に場所なし'}）`);
    log(o.dryRun ? `会話 ${sessionCount} 件が未分類に戻ります。` : `会話 ${sessionCount} 件を未分類に戻しました。`);
    log(REMOVE_KEEPS);
    if (preview.syncing) log(o.dryRun ? '同期しているほかの PC の一覧からも消えます。' : '同期しているほかの PC の一覧からも消えます（次の同期で届きます）。');
    if (o.dryRun) log(DRY_NOTE);
    return 0;
  });
}

// ---- workspace ----

/**
 * 作成場所を root にする（空なら未設定にする）。
 * 設定の保存（PATCH /api/settings）と同じ経路を使う。
 * 試しは保存と同じ検証を通し、保存のときに自動で登録される直下のフォルダを全部見せる。
 * 本番は、保存の前後のプロジェクトの一覧の違いから、この PC に場所ができたものを登録したものとして出す。
 */
function setRoot(o: ApiCommandOptions & { dryRun: boolean }, root: string): Promise<number> {
  return guarded(o, async (log) => {
    if (o.dryRun) {
      const pv = await call<WorkspaceRootPreviewDto>(o, 'PATCH', '/api/settings', { workspaceRoot: root, dryRun: true });
      if (o.json) { log(JSON.stringify({ ok: true, ...pv })); return 0; }
      log(`作成場所: ${pv.previous || '未設定'} → ${pv.workspaceRoot || '未設定'}`);
      if (pv.workspaceRoot === '') log(UNSET_EFFECT);
      else if (pv.unchanged) log('いまと同じ作成場所です。保存しても自動の登録は走りません。');
      else if (pv.register.length === 0) log('直下に、会話があってまだ登録していないフォルダはありません。');
      else {
        log(`保存すると、直下の次のフォルダを自動で登録します（${pv.register.length} 件）:`);
        for (const r of pv.register) log(`  ${outcomeLine(r, true)}`);
      }
      log(DRY_NOTE);
      return 0;
    }
    const before = new Map((await call<ProjectDto[]>(o, 'GET', '/api/projects')).map((p) => [p.id, p.path]));
    const saved = await call<SettingsDto>(o, 'PATCH', '/api/settings', { workspaceRoot: root });
    const after = await call<ProjectDto[]>(o, 'GET', '/api/projects');
    const registered = after.filter((p) => !p.isScratch && p.path !== null && (before.get(p.id) ?? null) === null).map((p) => ({ id: p.id, name: p.name, path: p.path! }));
    if (o.json) { log(JSON.stringify({ ok: true, dryRun: false, workspaceRoot: saved.workspaceRoot, registered })); return 0; }
    if (saved.workspaceRoot === '') {
      log('作成場所を空にしました（未設定）。');
      log(UNSET_EFFECT);
      return 0;
    }
    log(`作成場所を ${saved.workspaceRoot} にしました。`);
    if (registered.length === 0) log('直下に、自動で登録したフォルダはありません。');
    else {
      log(`直下の ${registered.length} 件を登録しました:`);
      for (const p of registered) log(`  ${p.path}（名前 ${p.name}）`);
    }
    return 0;
  });
}

/** hangar workspace set <dir>。 */
export function workspaceSetCommand(o: ApiCommandOptions & { dir: string; dryRun: boolean; cwd?: string; homeDir?: string }): Promise<number> {
  return setRoot(o, absolutePath(o.dir, o));
}

/**
 * hangar workspace unset。
 * 作成場所は任意で、空は「決めていない」として保存できる（設定の既存の意味）。
 */
export function workspaceUnsetCommand(o: ApiCommandOptions & { dryRun: boolean }): Promise<number> {
  return setRoot(o, '');
}
