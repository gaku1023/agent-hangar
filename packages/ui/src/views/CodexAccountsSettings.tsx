import type { AccountSettingsProps } from '../presenters/settings.ts';
import { AccountSettings } from './AccountSettings.tsx';

/**
 * 設定の Codex の節に置く、Codex のアカウントの一覧。
 * 中身は Claude Code と同じ一覧（AccountSettings）を agent で使い回す。
 * Codex のアカウントが届いていない（codexEnabled が切、古いサーバ）ときは何も出さない。
 */
export function CodexAccountsSettings(props: { accounts?: AccountSettingsProps | null }) {
  if (!props.accounts || props.accounts.list.length === 0) return null;
  return <AccountSettings agent="codex" {...props.accounts} />;
}
