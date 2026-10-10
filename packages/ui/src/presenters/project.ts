import type { ArtifactDto, ProjectStatus, TodoDto, Translate } from '@agent-hangar/shared';
import { SEARCH_STEP } from '../mediator/screen.ts';
import type { State } from '../mediator/types.ts';
import { artifactsOf, todosOf, type Store } from '../store/store.ts';
import { relativeTime } from './format.ts';
import type { ParentLink } from './heading.ts';
import { translatorOf } from './i18n.ts';
import { projectDisplayName } from './projectName.ts';
import { presentSessionList, type SessionListProps } from './sessions.ts';

/** 候補の TODO の表示。sessionId は、そのセッションが手元にあって開けるときだけ入る。 */
export type TodoCandidateProps = { note: string; sessionId: string | null; sessionName: string; ago: string };
export type TodoItemProps = { id: string; text: string; done: boolean; candidate: TodoCandidateProps | null };
export type ArtifactCardProps = { id: string; title: string; description: string | null; favicon: string; url: string; lastPublished: string; versionCount: number; canOpenEditor: boolean };
/** 見出しの (i) のポップオーバーに出す値。プロジェクトは作成日を持たないので、出さない。 */
export type ProjectInfoProps = { sessionsText: string; lastActivity: string };
/**
 * 1 つのプロジェクトの画面（Q3）。
 * list は、左の一覧（ホームと同じ部品）に渡すもので、このプロジェクトのセッションだけを持つ。loadMore は語で検索しているときの「さらに読み込む」。
 * pendingTodos は TODO の見出しに出す、完了の候補が付いた未完の TODO の数。
 */
export type ProjectProps = {
  id: string; name: string; parent: ParentLink; path: string | null; resolved: boolean; status: ProjectStatus; notFound: boolean; isScratch: boolean;
  list: SessionListProps; loadMore: { remaining: number; step: number; loading: boolean } | null; info: ProjectInfoProps;
  todos: TodoItemProps[]; pendingTodos: number; note: { text: string; filled: boolean }; artifacts: ArtifactCardProps[];
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
  const s = c.sessionId ? store.sessions[c.sessionId] : undefined;
  return { note: c.note ?? tr('projectScreen.todo.noNote'), sessionId: s ? s.id : null, sessionName: s ? s.name ?? tr('projectScreen.todo.noName') : tr('projectScreen.todo.unknownSession'), ago: relativeTime(tr, c.at, now) };
}

/** アーティファクト 1 件分のカード。題名が無い手動追加は URL の末尾を出す。 */
export function presentArtifactCard(t: Translate, a: ArtifactDto, now: number): ArtifactCardProps {
  return {
    id: a.id, title: a.title ?? a.url.split('/').filter(Boolean).at(-1) ?? a.url, description: a.description, favicon: a.favicon ?? '📄',
    url: a.url, lastPublished: relativeTime(t, a.lastPublishedAt, now), versionCount: a.versionCount, canOpenEditor: a.filePath !== null && a.fileExists,
  };
}

/** プロジェクト詳細の見出しの上には、一覧へ戻るリンクを出す。 */
const parentOf = (t: Translate): ParentLink => ({ label: t('projects.heading.title'), route: { name: 'projects' } });

export function presentProject(state: State, store: Store, now: number, id: string): ProjectProps {
  const p = store.projects[id];
  const t = translatorOf(store);
  const PARENT = parentOf(t);
  // 一覧はホームと同じ部品で、このプロジェクトのセッションだけを出す。見つからないプロジェクトは行が 0 になる。
  const list = presentSessionList(state, store, now, id);
  if (!p) return { id, name: id, parent: PARENT, path: null, resolved: false, status: 'active', notFound: true, isScratch: false, list, loadMore: null, info: { sessionsText: '', lastActivity: '' }, todos: [], pendingTodos: 0, note: { text: '', filled: false }, artifacts: [] };
  const remaining = list.total - list.rows.length;
  const todos = todosOf(store, id).map((x) => ({ id: x.id, text: x.text, done: x.done, candidate: presentTodoCandidate(x, store, now) }));
  const memo = store.memos[id]?.markdown ?? '';
  return {
    id, name: projectDisplayName(p, translatorOf(store)), parent: PARENT, path: p.path, resolved: p.resolved, status: p.status, notFound: false, isScratch: p.isScratch,
    list,
    loadMore: list.mode === 'search' && remaining > 0 ? { remaining, step: SEARCH_STEP, loading: list.loading } : null,
    // セッションの数は、Archived も含めた全部（タブの「すべて」は Archived を除く）。
    info: { sessionsText: t('projects.row.sessions', { n: Object.values(store.sessions).filter((s) => s.projectId === id).length }), lastActivity: relativeTime(t, p.lastActivityAt, now) },
    todos,
    pendingTodos: todos.filter((x) => x.candidate !== null).length,
    note: { text: memo, filled: memo.trim() !== '' },
    artifacts: artifactsOf(store, { projectId: id }).map((a) => presentArtifactCard(t, a, now)),
  };
}
