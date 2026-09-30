import type { ProjectStatus } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { relativeTime } from './format.ts';

export type NewSessionProject = { id: string; name: string; path: string | null; status: ProjectStatus; lastActivity: string };
export type NewSessionProps = { projects: NewSessionProject[]; recentIds: string[]; projectId: string | null; submitting: boolean; error: string | null; scratch: boolean };

/** 一覧の「最近」に置く件数。 */
export const RECENT_COUNT = 5;

/** 新規セッションのダイアログを開くときに、最初から選んでおくもの。session.new.open にそのまま載せる。 */
export type NewSessionTarget = { projectId?: string; scratch?: boolean };

/**
 * ⌘N とヘッダーの新規ボタンで開くダイアログの、最初の選択。
 * プロジェクトの画面ならそのプロジェクト、セッションの画面ならそのセッションのプロジェクトを選ぶ。
 * スクラッチの擬似プロジェクトは選べないので、その画面の「新規」と同じくスクラッチで開く。
 * ほかの画面とプロジェクトの無いセッションでは何も選ばない。
 */
export function newSessionTarget(state: State, store: Store): NewSessionTarget {
  const s = state.screen;
  const projectId = s.name === 'project' ? s.id : s.name === 'session' ? store.sessions[s.id]?.projectId ?? null : null;
  if (!projectId) return {};
  return store.projects[projectId]?.isScratch ? { scratch: true } : { projectId };
}

/** 起動ダイアログ。overlay が newSession のときだけ props を作る。 */
export function presentNewSession(state: State, store: Store, now: number): NewSessionProps | null {
  if (state.overlay.kind !== 'newSession') return null;
  // スクラッチの擬似プロジェクトは選ばせない。
  const live = Object.values(store.projects).filter((p) => !p.isScratch && p.resolved && p.status !== 'archived');
  const projects = [...live].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, name: p.name, path: p.path, status: p.status, lastActivity: p.lastActivityAt === null ? '' : relativeTime(p.lastActivityAt, now) }));
  // 最近は最後に使った時刻の新しい順。使ったことのないプロジェクトは入れない。
  const recentIds = live.filter((p) => p.lastActivityAt !== null).sort((a, b) => b.lastActivityAt! - a.lastActivityAt!).slice(0, RECENT_COUNT).map((p) => p.id);
  return { projects, recentIds, projectId: state.overlay.projectId, submitting: state.launch.kind === 'submitting', error: state.launch.kind === 'failed' ? state.launch.message : null, scratch: state.overlay.scratch };
}
