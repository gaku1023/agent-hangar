import type { ConfirmRequest, State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

/** 一覧から削除するプロジェクトの名前と、未分類に戻るセッションの数。 */
export type ConfirmProjectProps = { name: string; sessions: number };
export type ConfirmProps = { confirm: ConfirmRequest; project: ConfirmProjectProps | null };

/**
 * 確認のダイアログ。
 * 確認の要求は Mediator が持つ id だけなので、文に要る名前と件数を store から添える。
 * 件数は store に届いているセッションで数える。
 */
export function presentConfirm(state: State, store: Store): ConfirmProps | null {
  if (state.overlay.kind !== 'confirm') return null;
  const confirm = state.overlay.confirm;
  if (confirm.kind !== 'unlinkProject') return { confirm, project: null };
  const id = confirm.projectId;
  const sessions = Object.values(store.sessions).filter((s) => s.projectId === id).length;
  return { confirm, project: { name: store.projects[id]?.name ?? id, sessions } };
}
