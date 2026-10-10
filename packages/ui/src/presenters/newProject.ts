import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

export type NewProjectProps = { dirs: { name: string; path: string }[]; workspaceRoot: string | null; desktop: boolean; picked: { path: string; n: number } | null; submitting: boolean; error: string | null };

/** プロジェクト画面の作成のダイアログ。未登録の一覧からは、store にあるプロジェクトのパスを除く（作った直後に残らないように）。 */
export function presentNewProject(state: State, store: Store): NewProjectProps | null {
  if (state.overlay.kind !== 'newProject') return null;
  const taken = new Set(Object.values(store.projects).map((p) => p.path).filter((p): p is string => !!p));
  return {
    dirs: (store.workspaceDirs ?? []).filter((d) => !taken.has(d.path)),
    workspaceRoot: store.settings?.workspaceRoot ?? null,
    desktop: store.desktop,
    picked: store.pickedFolder,
    submitting: state.projectCreate.kind === 'submitting',
    error: state.projectCreate.kind === 'failed' ? state.projectCreate.message : null,
  };
}
