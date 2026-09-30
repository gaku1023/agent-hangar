import type { ArtifactDto, ProjectStatus, TodoDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import { artifactsOf, todosOf, type Store } from '../store/store.ts';
import { relativeTime } from './format.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

/** 候補の TODO の表示。sessionId は、そのセッションが手元にあって開けるときだけ入る。 */
export type TodoCandidateProps = { note: string; sessionId: string | null; sessionName: string; ago: string };
export type TodoItemProps = { id: string; text: string; done: boolean; candidate: TodoCandidateProps | null };
export type ArtifactCardProps = { id: string; title: string; description: string | null; favicon: string; url: string; lastPublished: string; versionCount: number; canOpenEditor: boolean };
export type ProjectProps = { id: string; name: string; path: string | null; resolved: boolean; status: ProjectStatus; sessions: SessionRowProps[]; notFound: boolean; isScratch: boolean; todos: TodoItemProps[]; memo: { markdown: string; updatedAt: number } | null; artifacts: ArtifactCardProps[] };

const NO_NOTE = '根拠は書かれていません';
const UNKNOWN_SESSION = '不明なセッション';

/**
 * 候補の TODO を表示用の文にする。候補でなければ null。
 * 出したセッションが手元に無い（削除済み、同期前、セッション別でない URL から出た）ときは、開けないので名前の代わりに決まりの文を出す。
 * 完了の行は候補を持たないものとして扱う。サーバは null にして返すが、古いサーバの値でも Home に出さないためである。
 */
export function presentTodoCandidate(t: TodoDto, store: Store, now: number): TodoCandidateProps | null {
  const c = t.candidate;
  if (!c || t.done) return null;
  const s = c.sessionId ? store.sessions[c.sessionId] : undefined;
  return { note: c.note ?? NO_NOTE, sessionId: s ? s.id : null, sessionName: s ? s.name ?? '（名前なし）' : UNKNOWN_SESSION, ago: relativeTime(c.at, now) };
}

/** アーティファクト 1 件分のカード。題名が無い手動追加は URL の末尾を出す。 */
export function presentArtifactCard(a: ArtifactDto, now: number): ArtifactCardProps {
  return {
    id: a.id, title: a.title ?? a.url.split('/').filter(Boolean).at(-1) ?? a.url, description: a.description, favicon: a.favicon ?? '📄',
    url: a.url, lastPublished: relativeTime(a.lastPublishedAt, now), versionCount: a.versionCount, canOpenEditor: a.filePath !== null && a.fileExists,
  };
}

export function presentProject(_state: State, store: Store, now: number, id: string): ProjectProps {
  const p = store.projects[id];
  if (!p) return { id, name: id, path: null, resolved: false, status: 'active', sessions: [], notFound: true, isScratch: false, todos: [], memo: null, artifacts: [] };
  const sessions = sortSessions(Object.values(store.sessions).filter((s) => s.projectId === id)).map((s) => presentSessionRow(s, store, now));
  const memo = store.memos[id];
  return {
    id, name: p.name, path: p.path, resolved: p.resolved, status: p.status, sessions, notFound: false, isScratch: p.isScratch,
    todos: todosOf(store, id).map((t) => ({ id: t.id, text: t.text, done: t.done, candidate: presentTodoCandidate(t, store, now) })),
    memo: memo ? { markdown: memo.markdown, updatedAt: memo.updatedAt } : null,
    artifacts: artifactsOf(store, { projectId: id }).map((a) => presentArtifactCard(a, now)),
  };
}
