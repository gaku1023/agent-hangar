import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

export type NewSessionProps = { projects: { id: string; name: string; path: string | null }[]; projectId: string | null; submitting: boolean; error: string | null; scratch: boolean };

/** 起動ダイアログ。overlay が newSession のときだけ props を作る。 */
export function presentNewSession(state: State, store: Store): NewSessionProps | null {
  if (state.overlay.kind !== 'newSession') return null;
  // スクラッチの擬似プロジェクトは選ばせない。絞り込みと並びはフェーズ 2 のまま。
  const projects = Object.values(store.projects).filter((p) => !p.isScratch && p.resolved && p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, name: p.name, path: p.path }));
  return { projects, projectId: state.overlay.projectId, submitting: state.launch.kind === 'submitting', error: state.launch.kind === 'failed' ? state.launch.message : null, scratch: state.overlay.scratch };
}
