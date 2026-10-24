import { safeDirectoryCommand, type GitDiffDto, type GitDto, type GitFileDto, type GitFileStatus, type GitTreeDto, type ProjectGitDto, type SessionChangesDto, type SessionDto, type SessionEditsDto, type Translate, type UiAction } from '@agent-hangar/shared';
import { clientPlatform } from '../keys.ts';
import type { State } from '../mediator/types.ts';
import { gitFileKey, shownLive, type Store } from '../store/store.ts';
import { openLabel } from './editor.ts';
import { translatorOf } from './i18n.ts';
import { firstChangedLine, parseUnifiedDiff, type DiffHunk } from './diff.ts';
import { presentTool } from './tools.ts';

/**
 * git の表示（0.5.0）の見せ方。読むだけで、hangar は git に書かない。
 * 件数は作業ツリー（同じフォルダ）ごとの git status の数で、セッションごとに割らない（試作の推す組み合わせ）。
 * 同じ作業ツリーで実行中のセッションがほかにあれば「共有 N」を添え、このセッションの分は (i) と差分の一覧で言う。
 */

/**
 * 一覧の行、引き出しの行、現在の札、冒頭の 1 枚に置く小さい札。
 * kind の ok は作業ツリーを読めたもの、remote は他の PC のセッション（本文の gitBranch だけ）、gone は消えた worktree。
 * worktree が真なら、枝の印ではなく分かれ道の印と「worktree」の小札を出し、name は worktree の名前、title にブランチを持つ。
 * value は「・」の後ろの語（未コミット N、件数なし、他の PC、削除済み。変更が無ければ空）で、count は件数（回すため）。dirty は琥珀にするか。
 * shared は自分を含めた本数で、2 本以上の実行中の行にだけ持つ。
 */
export type GitChipProps = {
  kind: 'ok' | 'remote' | 'gone'; worktree: boolean; name: string; title: string; value: string; count: number | null; dirty: boolean;
  shared: number | null; sharedTitle: string | null; label: string;
};

const tsep = (n: number) => n.toLocaleString('en-US');

/** 未コミットの件数の語。cap を超えたものは「1,000+」。 */
function countValue(t: Translate, tr: GitTreeDto): { value: string; count: number | null; dirty: boolean } {
  if (tr.slow || tr.dirty === null) return { value: t('gitUi.chip.noCount'), count: null, dirty: false };
  // 変更が無ければ値を出さず、ブランチだけの札にする（「変更なし」と言い直さない）。
  if (tr.dirty === 0) return { value: '', count: 0, dirty: false };
  if (tr.capped) return { value: t('gitUi.chip.uncommittedCapped', { n: tsep(tr.dirty) }), count: tr.dirty, dirty: true };
  return { value: t('gitUi.chip.uncommitted', { n: tsep(tr.dirty) }), count: tr.dirty, dirty: true };
}

/** その作業ツリーで実行中のセッションの数（自分を含む）。 */
function runningOn(git: GitDto, root: string, sessions: Record<string, SessionDto>): number {
  let n = 0;
  for (const [id, g] of Object.entries(git.sessions)) {
    const s = sessions[id];
    if (g.state === 'ok' && g.root === root && s && shownLive(s) !== null) n++;
  }
  return n;
}

/**
 * セッションの git の札。まだ届いていないもの、git でないものは null（札を出さない）。
 * ブランチの名前は本文の gitBranch（セッションがどのブランチで作業したか）を先に使い、無ければ作業ツリーの今のブランチ、それも無ければコミットの短い名前。
 */
export function presentGitChip(t: Translate, git: GitDto, sessionId: string, sessions: Record<string, SessionDto>): GitChipProps | null {
  const g = git.sessions[sessionId];
  // 持ち主の違いで git が断ったものも札は出さない（訳と許し方は (i) で言う）。
  if (!g || g.state === 'nogit' || g.state === 'unsafe') return null;
  const chip = (p: Omit<GitChipProps, 'label' | 'shared' | 'sharedTitle'> & { shared?: number | null }): GitChipProps => {
    const shared = p.shared ?? null;
    const branch = p.title || p.name;
    return { ...p, shared, sharedTitle: shared ? t('gitUi.chip.sharedTitle', { n: shared - 1 }) : null, label: p.value === '' ? t('gitUi.chip.labelBranch', { branch }) : t('gitUi.chip.label', { branch, value: p.value }) };
  };
  if (g.state === 'remote') return chip({ kind: 'remote', worktree: false, name: g.branch ?? '', title: g.branch ? `${g.branch}\n${t('gitUi.chip.otherPcTitle')}` : t('gitUi.chip.otherPcTitle'), value: t('gitUi.chip.otherPc'), count: null, dirty: false });
  if (g.state === 'gone') return chip({ kind: 'gone', worktree: true, name: g.worktree ?? g.branch ?? '', title: g.branch ?? g.worktree ?? '', value: t('gitUi.chip.removed'), count: null, dirty: false });
  const s = sessions[sessionId];
  // 終わったセッションの行には、今の作業ツリーの件数を出さない。そのセッションの状態のように読めてしまう。
  // ブランチは本文の gitBranch（そのセッションのときのもの）を出す。
  if (s && shownLive(s) === null) {
    if (!g.branch) return null;
    const wtName = g.worktree;
    return chip({ kind: 'ok', worktree: wtName !== null, name: wtName ?? g.branch, title: g.branch, value: '', count: null, dirty: false });
  }
  const tr = g.root ? git.trees[g.root] : undefined;
  if (!tr) return null;
  const branch = g.branch ?? tr.branch ?? tr.head ?? 'HEAD';
  const wt = g.worktree ?? tr.worktree;
  const c = countValue(t, tr);
  const n = s && shownLive(s) !== null ? runningOn(git, tr.root, sessions) : 0;
  const slowNote = tr.slow ? `\n${t('gitUi.chip.noCountTitle')}` : '';
  return chip({ kind: 'ok', worktree: wt !== null, name: wt ?? branch, title: `${branch}${slowNote}`, ...c, shared: n >= 2 ? n : null });
}

/** (i) の 1 行。note は値の後ろに薄く添える語、link は値の後ろのボタン。 */
export type GitDetailRow = { name: string; value: string; mono?: boolean; note?: string; link?: { label: string; send: UiAction } };

/**
 * (i) の詳細に足す git の行。ブランチ（上流との差）、worktree、作業ツリーの未コミット（共有）、このセッションの変更（一覧）。
 * このセッションの変更は「変更したファイル」の一覧（changes）が届いてから数える。
 */
export function gitDetailRows(t: Translate, git: GitDto, sessionId: string, sessions: Record<string, SessionDto>, changes: SessionChangesDto | undefined): GitDetailRow[] {
  const g = git.sessions[sessionId];
  if (!g) return [];
  const gitRow = (value: string): GitDetailRow => ({ name: t('gitUi.details.git'), value });
  if (g.state === 'nogit') return [gitRow(t('gitUi.details.noGit'))];
  if (g.state === 'unsafe') return [...(g.branch ? [{ name: t('gitUi.details.branch'), value: g.branch, mono: true }] : []), gitRow(t('gitUi.details.unsafe'))];
  if (g.state === 'remote') return [...(g.branch ? [{ name: t('gitUi.details.branch'), value: g.branch, mono: true }] : []), gitRow(t('gitUi.details.remote'))];
  if (g.state === 'gone') return [{ name: t('gitUi.details.worktree'), value: g.worktree ?? '', mono: true }, gitRow(t('gitUi.details.worktreeRemoved', { branch: g.branch ?? '' }))];
  const tr = g.root ? git.trees[g.root] : undefined;
  if (!tr) return [];
  const rows: GitDetailRow[] = [];
  const branch = g.branch ?? tr.branch ?? tr.head ?? 'HEAD';
  const notes = [tr.ahead ? t('gitUi.details.ahead', { n: tr.ahead }) : null, tr.behind ? t('gitUi.details.behind', { n: tr.behind }) : null].filter((x): x is string => x !== null);
  rows.push({ name: t('gitUi.details.branch'), value: branch, mono: true, ...(notes.length ? { note: notes.join(t('common.list.separator')) } : {}) });
  const wt = g.worktree ?? tr.worktree;
  if (wt) rows.push({ name: t('gitUi.details.worktree'), value: wt, mono: true, ...(tr.mainRoot ? { note: t('gitUi.details.worktreeFrom', { path: tr.mainRoot }) } : {}) });
  if (tr.slow || tr.dirty === null) { rows.push({ name: t('gitUi.details.tree'), value: t('gitUi.details.treeSlow') }); return rows; }
  const s = sessions[sessionId];
  const n = s && shownLive(s) !== null ? runningOn(git, tr.root, sessions) : 0;
  rows.push({ name: t('gitUi.details.tree'), value: tr.capped ? t('gitUi.details.treeMany', { n: tsep(tr.dirty) }) : t('gitUi.details.treeValue', { n: tsep(tr.dirty) }), ...(n >= 2 ? { note: t('gitUi.details.shared', { n: n - 1 }) } : {}) });
  const mine = changes && changes.state === 'ok' ? changes.files.filter((f) => f.status !== 'C').length : null;
  rows.push({ name: t('gitUi.details.mine'), value: mine === null ? t('gitUi.details.mineLoading') : t('gitUi.details.mineValue', { n: mine }), link: { label: t('gitUi.details.list'), send: { type: 'diff.open', sessionId } } });
  return rows;
}

/**
 * 持ち主の違いで git が断ったセッションの、許すコマンド（(i) の行の下に写せる形で出す）。断っていなければ null。
 * hangar は git の設定を書かないので、案内にだけ使う。platform はコマンドの引用の形を決める（試験では差し込む）。
 */
export function gitUnsafeFix(git: GitDto, sessionId: string, platform: string = clientPlatform()): string | null {
  const g = git.sessions[sessionId];
  return g?.state === 'unsafe' && g.root ? safeDirectoryCommand(g.root, platform) : null;
}

/** 差分の一覧の 1 行。mark は状態の印（未追跡は A、コミット済みは ✓）、counts は「+20 −2」かバイナリかコミット済み。 */
export type GitFileRow = { path: string; rel: string; status: GitFileStatus; mark: string; statusLabel: string; counts: string };
/**
 * 「変更したファイル」の一覧（現在の札のポップオーバー、差分のダイアログ）。
 * note は一覧の下の 1 行（git でないときの N1、他の PC、時間切れ）。othersLabel は「ほかに作業ツリーで変わったファイル N 件」で、無ければ null。
 * uncommitted は、このセッションが変えたうちの未コミットの件数。
 */
export type GitFilesView = { state: 'loading' | SessionChangesDto['state']; files: GitFileRow[]; others: GitFileRow[]; othersLabel: string | null; note: string | null; uncommitted: number };

const STATUS_KEY = { M: 'gitUi.status.modified', A: 'gitUi.status.added', U: 'gitUi.status.untracked', D: 'gitUi.status.deleted', R: 'gitUi.status.renamed', C: 'gitUi.status.committed' } as const;
const MARK: Record<GitFileStatus, string> = { M: 'M', A: 'A', U: 'A', D: 'D', R: 'R', C: '✓' };

function fileRow(t: Translate, f: GitFileDto, git: boolean): GitFileRow {
  const counts = !git ? '' : f.status === 'C' ? t('gitUi.status.committed') : f.binary ? t('gitUi.files.binary') : f.added === null ? '' : t('gitUi.diff.counts', { added: f.added, deleted: f.deleted ?? 0 });
  return { path: f.path, rel: f.rel, status: f.status, mark: git ? MARK[f.status] : '', statusLabel: git ? t(STATUS_KEY[f.status]) : '', counts };
}

export function presentGitFiles(t: Translate, changes: SessionChangesDto | undefined): GitFilesView {
  if (!changes) return { state: 'loading', files: [], others: [], othersLabel: null, note: null, uncommitted: 0 };
  const git = changes.state === 'ok';
  const NOTE = { nogit: 'gitUi.files.bashNote', unsafe: 'gitUi.files.unsafeNote', remote: 'gitUi.files.remoteNote', gone: 'gitUi.files.goneNote', slow: 'gitUi.files.slowNote', ok: null } as const;
  const key = NOTE[changes.state];
  const note = key ? t(key) : null;
  const n = changes.others.length;
  return {
    state: changes.state, note,
    files: changes.files.map((f) => fileRow(t, f, git)),
    others: git ? changes.others.map((f) => fileRow(t, f, true)) : [],
    othersLabel: git && n > 0 ? t(changes.othersCapped ? 'gitUi.files.othersMany' : 'gitUi.files.others', { n: tsep(n) }) : null,
    uncommitted: git ? changes.files.filter((f) => f.status !== 'C').length : 0,
  };
}

/**
 * 差分のダイアログの右の中身。
 * hunks は git の差（統合形式から直したもの）、edits はこのセッションの編集（トランスクリプトの Edit、MultiEdit、Write）、note は 1 文だけのもの。
 * line はエディタで開く行（最初に足した行、無ければ 1）。
 */
export type DiffBody =
  | { kind: 'none'; line: number }
  | { kind: 'loading'; line: number }
  | { kind: 'note'; text: string; line: number }
  | { kind: 'hunks'; hunks: DiffHunk[]; truncated: boolean; line: number }
  | { kind: 'edits'; items: { key: string; head: string; hunks: DiffHunk[] }[]; truncated: boolean; line: number };

const hhmm = (ts: number | null) => {
  if (ts === null) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 書いた中身を、全部足した 1 つのハンクにする（Write）。 */
function writeHunk(text: string): DiffHunk {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  return { header: null, lines: lines.map((l, i) => ({ t: 'add' as const, old: null, new: i + 1, text: l })) };
}

export function presentDiffBody(t: Translate, o: { source: 'git' | 'session'; file: GitFileRow | GitFileDto | null; diff: GitDiffDto | { error: string } | undefined; edits: SessionEditsDto | { error: string } | undefined; cwd: string }): DiffBody {
  if (!o.file) return { kind: 'none', line: 1 };
  if (o.source === 'git') {
    if (o.file.status === 'C') return { kind: 'note', text: t('gitUi.diff.committed'), line: 1 };
    if (!o.diff) return { kind: 'loading', line: 1 };
    if ('error' in o.diff) return { kind: 'note', text: o.diff.error, line: 1 };
    if (o.diff.binary) return { kind: 'note', text: t('gitUi.diff.binary'), line: 1 };
    const hunks = parseUnifiedDiff(o.diff.text);
    if (hunks.length === 0) return { kind: 'note', text: t('gitUi.diff.empty'), line: 1 };
    return { kind: 'hunks', hunks, truncated: o.diff.truncated, line: firstChangedLine(hunks) };
  }
  if (!o.edits) return { kind: 'loading', line: 1 };
  if ('error' in o.edits) return { kind: 'note', text: o.edits.error, line: 1 };
  if (o.edits.edits.length === 0) return { kind: 'note', text: t('gitUi.diff.noEdits'), line: 1 };
  const items = o.edits.edits.map((e) => {
    const view = presentTool({ kind: 'tool_call', seq: e.seq, toolId: e.call.toolId, name: e.call.name, input: e.call.input, summary: e.call.summary }, e.result, o.cwd, t);
    const hunks = view.body.kind === 'diff' ? view.body.hunks : view.body.kind === 'code' ? [writeHunk(view.body.text)] : [];
    const time = hhmm(e.ts);
    return { key: String(e.seq), head: time ? t('gitUi.diff.editHead', { tool: e.call.name, time }) : e.call.name, hunks };
  });
  const last = items.at(-1);
  return { kind: 'edits', items, truncated: o.edits.truncated, line: last ? firstChangedLine(last.hunks) : 1 };
}

/**
 * プロジェクト画面の git。root はパスの行の札、rows は右パネルの「ブランチと worktree」の行（元の作業ツリーが先頭）。
 * 行の sessions は、その作業ツリーで実行中（入力待ちを先）のセッションの数の語で、無ければ「セッションなし」。
 * state の noPath はこの PC にパスが無い、missing はフォルダが無い、unsafe は持ち主の違いで git が断ったもので、どれも行を持たない。
 * fix は unsafe のときの許すコマンドで、ほかは null。
 */
export type ProjectGitRow = { key: string; path: string; name: string; worktree: boolean; branch: string; value: string; dirty: boolean; sessions: string };
export type ProjectGitProps = { state: 'loading' | 'nogit' | 'noPath' | 'missing' | 'unsafe' | 'ok'; root: GitChipProps | null; rows: ProjectGitRow[]; fix: string | null };

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const under = (cwd: string, root: string) => cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`);

export function presentProjectGit(t: Translate, pg: ProjectGitDto | undefined, sessions: SessionDto[], git: GitDto, platform: string = clientPlatform()): ProjectGitProps {
  const none = (state: ProjectGitProps['state'], fix: string | null = null): ProjectGitProps => ({ state, root: null, rows: [], fix });
  if (!pg) return none('loading');
  if (pg.blocked?.kind === 'unsafe') return none('unsafe', safeDirectoryCommand(pg.blocked.path, platform));
  if (pg.blocked) return none(pg.blocked.kind);
  if (!pg.root) return none('nogit');
  const trees = [{ tree: pg.root, path: pg.root.root, name: baseName(pg.root.root), worktree: false, branch: pg.root.branch }, ...pg.worktrees.map((w) => ({ tree: w.tree, path: w.path, name: w.name, worktree: true, branch: w.branch }))];
  // セッションが乗っている作業ツリー。git の手がかりがあればその根で、無ければ cwd の前方一致で、いちばん深い根に寄せる。
  const rootOf = (s: SessionDto): string | null => {
    const g = git.sessions[s.id];
    if (g?.state === 'ok' && g.root) return g.root;
    const hits = trees.filter((x) => under(s.cwd, x.path)).sort((a, b) => b.path.length - a.path.length);
    return hits[0]?.path ?? null;
  };
  const live = sessions.filter((s) => shownLive(s) !== null);
  const rows = trees.map((x): ProjectGitRow => {
    const on = live.filter((s) => rootOf(s) === x.path);
    const waiting = on.filter((s) => shownLive(s) === 'waiting').length;
    const running = on.length - waiting;
    const parts = [waiting > 0 ? t('gitUi.rail.waiting', { n: waiting }) : null, running > 0 ? t('gitUi.rail.running', { n: running }) : null].filter((v): v is string => v !== null);
    const c = x.tree ? countValue(t, x.tree) : { value: '', count: null, dirty: false };
    return { key: x.path, path: x.path, name: x.name, worktree: x.worktree, branch: t('gitUi.rail.branch', { name: x.branch ?? x.tree?.head ?? 'HEAD' }), value: c.value, dirty: c.dirty, sessions: parts.length ? parts.join(t('common.list.separator')) : t('gitUi.rail.noSessions') };
  });
  const rc = countValue(t, pg.root);
  const branch = pg.root.branch ?? pg.root.head ?? 'HEAD';
  const root: GitChipProps = { kind: 'ok', worktree: false, name: branch, title: branch, ...rc, shared: null, sharedTitle: null, label: rc.value === '' ? t('gitUi.chip.labelBranch', { branch }) : t('gitUi.chip.label', { branch, value: rc.value }) };
  return { state: 'ok', root, rows, fix: null };
}

/**
 * 差分のダイアログ（試作の 2-5 の A）。左に「変更したファイル」、右に選んだファイルの差分。
 * 選んでいなければ最初の未コミット（無ければ最初の行）を選ぶ。出どころは git が既定で、git の作業ツリーでなければ「このセッションの編集」だけ。
 * load は右の中身を読む UiAction で、画面は選んだファイルか出どころが替わるたびに出す。line はエディタで開く行。
 */
export type DiffDialogProps = {
  sessionId: string; name: string; chip: GitChipProps | null; files: GitFilesView;
  source: 'git' | 'session'; canGit: boolean; selected: string | null; selectedRow: GitFileRow | null;
  body: DiffBody; line: number; openLabel: string; load: UiAction | null;
};

export function presentDiffDialog(state: State, store: Store): DiffDialogProps | null {
  const o = state.overlay;
  if (o.kind !== 'diff') return null;
  const t = translatorOf(store);
  const changes = store.gitChanges[o.sessionId];
  const files = presentGitFiles(t, changes);
  const canGit = changes?.state === 'ok';
  const source = !canGit ? 'session' : o.source ?? 'git';
  const pick = files.files.find((f) => f.path === o.file) ?? files.files.find((f) => f.status !== 'C') ?? files.files[0] ?? null;
  const selected = pick?.path ?? o.file;
  const key = selected ? gitFileKey(o.sessionId, selected) : null;
  const s = store.sessions[o.sessionId];
  const body = changes === undefined ? { kind: 'loading' as const, line: 1 } : presentDiffBody(t, { source, file: pick, diff: key ? store.gitDiffs[key] : undefined, edits: key ? store.gitEdits[key] : undefined, cwd: changes.root ?? s?.cwd ?? '' });
  const load: UiAction | null = !selected || !pick || (source === 'git' && pick.status === 'C') ? null : source === 'git' ? { type: 'git.diff.load', sessionId: o.sessionId, file: selected } : { type: 'git.edits.load', sessionId: o.sessionId, file: selected };
  return {
    sessionId: o.sessionId, name: s?.name ?? t('common.label.noName'), chip: presentGitChip(t, store.git, o.sessionId, store.sessions), files,
    source, canGit, selected, selectedRow: pick, body, line: body.line, openLabel: openLabel(t, store.settings), load,
  };
}
