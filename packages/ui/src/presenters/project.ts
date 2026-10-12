import type { ArtifactDto, InstructionFileDto, InstructionFileKind, ProjectGitDto, ProjectRailSection, ProjectStatus, TodoDto, Translate } from '@agent-hangar/shared';
import { presentProjectGit, type ProjectGitProps } from './git.ts';
import { SEARCH_STEP } from '../mediator/screen.ts';
import type { State } from '../mediator/types.ts';
import { artifactsOf, todosOf, type Store } from '../store/store.ts';
import { relativeTime } from './format.ts';
import type { ParentLink } from './heading.ts';
import { translatorOf } from './i18n.ts';
import { projectDisplayName } from './projectName.ts';
import { bytesLabel } from './retention.ts';
import { presentSessionList, type SessionListProps } from './sessions.ts';

/** 候補の TODO の表示。sessionId は、そのセッションが手元にあって開けるときだけ入る。 */
export type TodoCandidateProps = { note: string; sessionId: string | null; sessionName: string; ago: string };
/** position は並べ替えと、完了した直後の行を元の場所に少し残すために使う。 */
export type TodoItemProps = { id: string; text: string; done: boolean; position: number; candidate: TodoCandidateProps | null };
/** Claude が足して、まだ受け入れていない TODO。sessionId は、そのセッションが手元にあって開けるときだけ入る。 */
export type TodoSuggestionProps = { id: string; text: string; note: string | null; sessionId: string | null; sessionName: string; ago: string };
export type ArtifactCardProps = { id: string; title: string; description: string | null; favicon: string; url: string; lastPublished: string; versionCount: number; canOpenEditor: boolean };
/** 見出しの (i) のポップオーバーに出す値。プロジェクトは作成日を持たないので、出さない。 */
export type ProjectInfoProps = { sessionsText: string; lastActivity: string };
/**
 * 1 つのプロジェクトの画面（Q3）。
 * list は、左の一覧（ホームと同じ部品）に渡すもので、このプロジェクトのセッションだけを持つ。loadMore は語で検索しているときの「さらに読み込む」。
 * TODO は、未完（todos、position の順）、完了（doneTodos、終えた新しい順）、Claude の提案（suggestions、出した古い順）に分ける。
 * 終えた時刻は持たないので、完了の並びは最後に変わった時刻（updatedAt）で代える。
 * pendingTodos は TODO の見出しに出す、完了の候補が付いた未完の TODO の数。
 */
export type ProjectProps = {
  id: string; name: string; parent: ParentLink; path: string | null; resolved: boolean; status: ProjectStatus; notFound: boolean; isScratch: boolean;
  list: SessionListProps; loadMore: { remaining: number; step: number; loading: boolean } | null; info: ProjectInfoProps;
  todos: TodoItemProps[]; doneTodos: TodoItemProps[]; suggestions: TodoSuggestionProps[]; pendingTodos: number; instructions: InstructionsProps; artifacts: ArtifactCardProps[];
  /** 手で足した URL が断られたときの理由と、入れた URL。このプロジェクトのものだけ。 */
  artifactAddError: { url: string; message: string } | null;
  /** 右パネルで折りたたんでいる節。プロジェクトごとに覚えたもので、無ければどれも開く。 */
  railFolded: ProjectRailSection[];
  /** git の表示（0.5.0）。パスの行の札と、右パネルの「ブランチと worktree」の行。 */
  git?: ProjectGitProps;
};

/**
 * 候補の TODO を表示用の文にする。候補でなければ null。
 * 出したセッションが手元に無い（削除済み、同期前、セッション別でない URL から出た）ときは、開けないので名前の代わりに決まりの文を出す。
 * 完了の行は候補を持たないものとして扱う。サーバも null にして返すが、同期の競り合いで食い違っても Home に出さない。
 */
export function presentTodoCandidate(t: TodoDto, store: Store, now: number): TodoCandidateProps | null {
  const c = t.candidate;
  if (!c || t.done) return null;
  const tr = translatorOf(store);
  return { note: c.note ?? tr('projectScreen.todo.noNote'), ...sessionLabel(store, c.sessionId), ago: relativeTime(tr, c.at, now) };
}

/** 出したセッションの名前。手元に無ければ開けないので、決まりの文にする。 */
function sessionLabel(store: Store, sessionId: string | null): { sessionId: string | null; sessionName: string } {
  const tr = translatorOf(store);
  const s = sessionId ? store.sessions[sessionId] : undefined;
  return { sessionId: s ? s.id : null, sessionName: s ? s.name ?? tr('projectScreen.todo.noName') : tr('projectScreen.todo.unknownSession') };
}

/** アーティファクト 1 件分のカード。題名が無い手動追加は URL の末尾を出す。 */
export function presentArtifactCard(t: Translate, a: ArtifactDto, now: number): ArtifactCardProps {
  return {
    id: a.id, title: a.title ?? a.url.split('/').filter(Boolean).at(-1) ?? a.url, description: a.description, favicon: a.favicon ?? '📄',
    url: a.url, lastPublished: relativeTime(t, a.lastPublishedAt, now), versionCount: a.versionCount, canOpenEditor: a.filePath !== null && a.fileExists,
  };
}

/**
 * 指示とメモリの 1 行。desc は種類の説明（AGENTS.md は読まれるかで替える）、meta は大きさと更新、off は起動時に読まれないもの。
 * markdown と truncated はダイアログに描く本文で、読めなかったら markdown は null。
 */
export type InstructionRowProps = { kind: InstructionFileKind; name: string; desc: string; meta: string; off: boolean; markdown: string | null; truncated: boolean };
/**
 * 右パネルの「指示とメモリ」。state は読み込む前（loading）、この PC にフォルダが無い（missing）、読み込んだ（ready）。
 * legacyNote は、やめたプロジェクトのノートに中身が残っているときの本文で、空なら null。
 */
export type InstructionsProps = { state: 'loading' | 'missing' | 'ready'; rows: InstructionRowProps[]; legacyNote: string | null };

/** ファイルの大きさ。1 KB 未満はバイト、10 KB 未満は小数 1 桁の KB、それより上は bytesLabel に任せる。 */
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 10 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  return bytesLabel(bytes);
}

/** AGENTS.md の代わりに読まれる種類。並んでいれば、読まれない理由を言い切れる。 */
const CLAUDE_KINDS = new Set<InstructionFileKind>(['project', 'projectDotClaude', 'local']);

function descOf(t: Translate, f: InstructionFileDto, files: InstructionFileDto[]): string {
  switch (f.kind) {
    case 'project': case 'projectDotClaude': return t('projectScreen.instructions.desc.project');
    case 'local': return t('projectScreen.instructions.desc.local');
    case 'memory': return t('projectScreen.instructions.desc.memory');
    case 'agents':
      if (f.read) return t('projectScreen.instructions.desc.agentsRead');
      return t(files.some((x) => CLAUDE_KINDS.has(x.kind)) ? 'projectScreen.instructions.desc.agentsShadowed' : 'projectScreen.instructions.desc.agentsOff');
  }
}

export function presentInstructions(t: Translate, store: Store, id: string, now: number): InstructionsProps {
  const memo = store.memos[id]?.markdown ?? '';
  const legacyNote = memo.trim() !== '' ? memo : null;
  const dto = store.instructions[id];
  if (!dto) return { state: 'loading', rows: [], legacyNote };
  if (!dto.available) return { state: 'missing', rows: [], legacyNote };
  const rows = dto.files.map((f) => ({
    kind: f.kind, name: f.name, desc: descOf(t, f, dto.files), meta: t('projectScreen.instructions.meta', { size: sizeLabel(f.size), ago: relativeTime(t, f.updatedAt, now) }),
    off: !f.read, markdown: f.markdown, truncated: f.truncated,
  }));
  return { state: 'ready', rows, legacyNote };
}

/** この PC にパスの無いプロジェクトの git（サーバの GET /api/projects/:id/git も同じものを返す）。 */
const NO_PATH_GIT: ProjectGitDto = { root: null, worktrees: [], blocked: { kind: 'noPath' } };

/** プロジェクト詳細の見出しの上には、一覧へ戻るリンクを出す。 */
const parentOf = (t: Translate): ParentLink => ({ label: t('projects.heading.title'), route: { name: 'projects' } });

export function presentProject(state: State, store: Store, now: number, id: string): ProjectProps {
  const p = store.projects[id];
  const t = translatorOf(store);
  const PARENT = parentOf(t);
  // 一覧はホームと同じ部品で、このプロジェクトのセッションだけを出す。見つからないプロジェクトは行が 0 になる。
  const list = presentSessionList(state, store, now, id);
  if (!p) return { id, name: id, parent: PARENT, path: null, resolved: false, status: 'active', notFound: true, isScratch: false, list, loadMore: null, info: { sessionsText: '', lastActivity: '' }, todos: [], doneTodos: [], suggestions: [], pendingTodos: 0, instructions: { state: 'loading', rows: [], legacyNote: null }, artifacts: [], artifactAddError: null, railFolded: [], git: { state: 'nogit', root: null, rows: [], fix: null } };
  const remaining = list.total - list.rows.length;
  const all = todosOf(store, id);
  const item = (x: TodoDto): TodoItemProps => ({ id: x.id, text: x.text, done: x.done, position: x.position, candidate: presentTodoCandidate(x, store, now) });
  const todos = all.filter((x) => !x.done && !x.suggestion).map(item);
  const doneTodos = all.filter((x) => x.done && !x.suggestion).sort((a, b) => b.updatedAt - a.updatedAt || a.position - b.position).map(item);
  const suggestions = all.filter((x) => x.suggestion).sort((a, b) => a.suggestion!.at - b.suggestion!.at || a.position - b.position)
    .map((x): TodoSuggestionProps => ({ id: x.id, text: x.text, note: x.suggestion!.note, ...sessionLabel(store, x.sessionId), ago: relativeTime(t, x.suggestion!.at, now) }));
  return {
    id, name: projectDisplayName(p, translatorOf(store)), parent: PARENT, path: p.path, resolved: p.resolved, status: p.status, notFound: false, isScratch: p.isScratch,
    list,
    loadMore: list.mode === 'search' && remaining > 0 ? { remaining, step: SEARCH_STEP, loading: list.loading } : null,
    // セッションの数は、Archived も含めた全部（タブの「すべて」は Archived を除く）。
    info: { sessionsText: t('projects.row.sessions', { n: Object.values(store.sessions).filter((s) => s.projectId === id).length }), lastActivity: relativeTime(t, p.lastActivityAt, now) },
    todos, doneTodos, suggestions,
    pendingTodos: todos.filter((x) => x.candidate !== null).length,
    instructions: presentInstructions(t, store, id, now),
    artifacts: artifactsOf(store, { projectId: id }).map((a) => presentArtifactCard(t, a, now)),
    artifactAddError: store.artifactAddError?.projectId === id ? { url: store.artifactAddError.url, message: store.artifactAddError.message } : null,
    railFolded: state.projectRailFolded[id] ?? [],
    // この PC にパスが無いものは読まない（ProjectScreen も送らない）ので、届くのを待たずに noPath にする。
    git: presentProjectGit(t, p.path === null ? NO_PATH_GIT : store.projectGit[id], Object.values(store.sessions).filter((s) => s.projectId === id), store.git),
  };
}
