import type { ConfirmRequest, State } from '../mediator/types.ts';
import { accountList, type Store } from '../store/store.ts';

/** 一覧から削除するプロジェクトの名前と、未分類に戻るセッションの数。 */
export type ConfirmProjectProps = { name: string; sessions: number };
/**
 * accountName は、切り替えと削除の確認が指すアカウントの名前。
 * ほかの確認と、一覧に無い id（消えた直後など）では null で、View は id を名前の代わりにする。
 */
export type ConfirmProps = { confirm: ConfirmRequest; project: ConfirmProjectProps | null; accountName: string | null };

/**
 * 確認のダイアログ。
 * 確認の要求は Mediator が持つ id だけなので、文に要る名前と件数を store から添える。
 * 件数は store に届いているセッションで数える。
 * アカウントの確認には、指す id の名前を添える。
 */
export function presentConfirm(state: State, store: Store): ConfirmProps | null {
  if (state.overlay.kind !== 'confirm') return null;
  const confirm = state.overlay.confirm;
  if (confirm.kind === 'switchAccount' || confirm.kind === 'removeAccount') {
    return { confirm, project: null, accountName: accountList(store).find((a) => a.id === confirm.accountId)?.name ?? null };
  }
  if (confirm.kind !== 'unlinkProject') return { confirm, project: null, accountName: null };
  const id = confirm.projectId;
  const sessions = Object.values(store.sessions).filter((s) => s.projectId === id).length;
  return { confirm, project: { name: store.projects[id]?.name ?? id, sessions }, accountName: null };
}
