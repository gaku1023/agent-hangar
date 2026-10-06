import type { ArtifactDto, ProjectStatus, TodoDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import { artifactsOf, todosOf, type Store } from '../store/store.ts';
import { projectPageKey } from '../mediator/paging.ts';
import { relativeTime } from './format.ts';
import type { ParentLink } from './heading.ts';
import { pagerOf, type PagerProps } from './pager.ts';
import { presentSessionRow, sortForSections } from './row.ts';
import { DONE_HEAD, sectionRows, type ListItem } from './sections.ts';

/** 候補の TODO の表示。sessionId は、そのセッションが手元にあって開けるときだけ入る。 */
export type TodoCandidateProps = { note: string; sessionId: string | null; sessionName: string; ago: string };
export type TodoItemProps = { id: string; text: string; done: boolean; candidate: TodoCandidateProps | null };
export type ArtifactCardProps = { id: string; title: string; description: string | null; favicon: string; url: string; lastPublished: string; versionCount: number; canOpenEditor: boolean };
/** items はセッションの一覧で、節の見出しと行の並び（P3）。pager は広げた節のページ送りで、広げていないか収まるなら null。 */
export type ProjectProps = { id: string; name: string; parent: ParentLink; path: string | null; resolved: boolean; status: ProjectStatus; items: ListItem[]; pager: PagerProps | null; notFound: boolean; isScratch: boolean; todos: TodoItemProps[]; memo: { markdown: string; updatedAt: number } | null; artifacts: ArtifactCardProps[] };

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

/**
 * 広げた節（Done の「ほか N 件」と Archived の「表示」）の行をページに分ける。
 * 広げた節は何百件にもなるので、その行だけを数えて切り出し、上の節（今日戻る・動いている・続き）の行と、節の見出しは毎ページ出す。
 * 広げた節の行がいちばん小さい件数に収まるなら、分けない。
 */
function pageExpanded(items: ListItem[], expanded: Set<string>, page: number, size: number): { items: ListItem[]; pager: PagerProps | null } {
  let section: string | null = null;
  const inExpanded = items.map((it) => { if (it.kind === 'head') section = it.id; return it.kind === 'row' && section !== null && expanded.has(section); });
  const pager = pagerOf(page, size, inExpanded.filter(Boolean).length);
  if (!pager) return { items, pager };
  let k = 0;
  return { items: items.filter((_, i) => !inExpanded[i] || (++k >= pager.from && k <= pager.to)), pager };
}

/** プロジェクト詳細の見出しの上には、一覧へ戻るリンクを出す。 */
const PARENT: ParentLink = { label: 'プロジェクト', route: { name: 'projects' } };

export function presentProject(state: State, store: Store, now: number, id: string): ProjectProps {
  const p = store.projects[id];
  if (!p) return { id, name: id, parent: PARENT, path: null, resolved: false, status: 'active', items: [], pager: null, notFound: true, isScratch: false, todos: [], memo: null, artifacts: [] };
  // 節で読む（P3）。広げた節はプロジェクトごとに Mediator が覚えている（mediator/sections.ts）。
  const rows = sortForSections(Object.values(store.sessions).filter((s) => s.projectId === id)).map((s) => presentSessionRow(s, store, now));
  const expanded = new Set<string>(state.sectionsOpen[id] ?? []);
  const { items, pager } = pageExpanded(sectionRows(rows, 'project', { now, doneHead: DONE_HEAD, expanded }), expanded, state.listPages[projectPageKey(id)] ?? 1, state.pageSize);
  const memo = store.memos[id];
  return {
    id, name: p.name, parent: PARENT, path: p.path, resolved: p.resolved, status: p.status, items, pager, notFound: false, isScratch: p.isScratch,
    todos: todosOf(store, id).map((t) => ({ id: t.id, text: t.text, done: t.done, candidate: presentTodoCandidate(t, store, now) })),
    memo: memo ? { markdown: memo.markdown, updatedAt: memo.updatedAt } : null,
    artifacts: artifactsOf(store, { projectId: id }).map((a) => presentArtifactCard(a, now)),
  };
}
