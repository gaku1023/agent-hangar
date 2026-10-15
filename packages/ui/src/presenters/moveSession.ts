import type { ProjectStatus } from '@agent-hangar/shared';
import { homePath } from '../lib/paths.ts';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { translatorOf } from './i18n.ts';
import { RECENT_COUNT } from './newSession.ts';
import { projectDisplayName } from './projectName.ts';
import { moveTargetIds } from './sessionMenu.ts';

/** 移す先の 1 行。quick はクイックセッション（絵を替える）、current はいまの所属（押せない）。 */
export type MoveSessionProject = { id: string; name: string; path: string | null; status: ProjectStatus; quick: boolean; current: boolean };

/**
 * 移す先を選ぶダイアログ（試作の 2A）。
 * projects は名前の順、recentIds は最後に使った時刻の新しい順の上位（新しいセッションのダイアログと同じ数え方）。
 * cwd は再開するフォルダで、ホームを ~ に縮めて出す。
 */
export type MoveSessionProps = { sessionId: string; name: string; cwd: string; projects: MoveSessionProject[]; recentIds: string[] };

/**
 * overlay が moveSession のときだけ props を作る。セッションが Store に無ければ（消えた直後）null にする。
 * 並べるのは移せる先（しまったプロジェクトと、ほかの PC のクイックセッションを除く）と、いまの所属である。
 * いまの所属は、しまったプロジェクトでも「現在のプロジェクト」として押せない形で並べる。
 */
export function presentMoveSession(state: State, store: Store): MoveSessionProps | null {
  if (state.overlay.kind !== 'moveSession') return null;
  const s = store.sessions[state.overlay.sessionId];
  if (!s) return null;
  const t = translatorOf(store);
  const current = s.projectId;
  const ids = new Set(moveTargetIds(store, current));
  if (current && store.projects[current]) ids.add(current);
  const list = [...ids].map((id) => store.projects[id]!);
  const projects = list
    .map((p): MoveSessionProject => ({ id: p.id, name: projectDisplayName(p, t), path: p.path, status: p.status, quick: p.isScratch, current: p.id === current }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const recentIds = list.filter((p) => p.lastActivityAt !== null).sort((a, b) => b.lastActivityAt! - a.lastActivityAt!).slice(0, RECENT_COUNT).map((p) => p.id);
  return { sessionId: s.id, name: s.name ?? t('common.label.noName'), cwd: homePath(s.cwd, store.home), projects, recentIds };
}
