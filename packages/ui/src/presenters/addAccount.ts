import { PRIMARY_ACCOUNT_ID, type AccountDirPreviewDto } from '@agent-hangar/shared';
import { homePath } from '../lib/paths.ts';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

/**
 * 設定の「アカウントを足す…」のダイアログ（試作の 7 節の案 A）。
 * home はサーバが返したホームで、場所を ~ の形で見せるのと、「選ぶ…」の開く場所に使う。
 * preview は足す前の確かめの最後の答えで、今の欄と合うかはダイアログが見る。
 */
export type AddAccountProps = {
  /** どのエージェントのアカウントを足すか。省略は Claude Code。 */
  agent?: 'claude-code' | 'codex';
  home: string | null;
  /** 共有の元（最初のアカウントの場所）を ~ の形で。 */
  primaryDirLabel: string;
  desktop: boolean;
  picked: { path: string; n: number } | null;
  preview: AccountDirPreviewDto | null;
  submitting: boolean;
  error: string | null;
};

export function presentAddAccount(state: State, store: Store): AddAccountProps | null {
  if (state.overlay.kind !== 'addAccount') return null;
  const codex = state.overlay.agent === 'codex';
  const primary = codex
    ? store.accounts?.codex?.accounts.find((a) => a.id === PRIMARY_ACCOUNT_ID)?.dir ?? '~/.codex'
    : store.accounts?.accounts.find((a) => a.id === PRIMARY_ACCOUNT_ID)?.dir ?? store.settings?.claudeDir ?? '~/.claude';
  return {
    agent: codex ? 'codex' : 'claude-code',
    home: store.home,
    primaryDirLabel: homePath(primary, store.home),
    desktop: store.desktop,
    picked: store.pickedFolder,
    preview: store.accountPreview,
    submitting: state.accountAdd.kind === 'submitting',
    error: state.accountAdd.kind === 'failed' ? state.accountAdd.message : null,
  };
}
