import type { ConfigPreviewDto, FileEntry } from '@agent-hangar/shared';
import type { ConfigSyncApi } from '../http/deps.ts';

/**
 * Claude Code 設定の同期を、HTTP が触る形に包む。
 * ClaudeConfigSync に pull() は無いので、確認を立ててから applyPull(pendingRemote()) を呼ぶ形にする。
 * 同期を設定していない端末（null）では null を返す。そのとき設定の経路は 404 を返す。
 */
export function configSyncApi(configSync: {
  preview(): ConfigPreviewDto;
  pendingRemote(): FileEntry[];
  confirm(): void;
  applyPull(entries: FileEntry[]): Promise<{ applied: number; conflicts: number }>;
} | null): ConfigSyncApi | null {
  if (!configSync) return null;
  return {
    preview: () => configSync.preview(),
    pull: async () => { const entries = configSync.pendingRemote(); configSync.confirm(); return configSync.applyPull(entries); },
  };
}
