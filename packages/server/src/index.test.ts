import { describe, expect, it } from 'vitest';
import * as api from './index.ts';

/**
 * CLI はこのパッケージの内側へ deep import せず、ここから取る。
 * 名前が消えると CLI の hangar cloud teardown が「R2 にしか無い本文を降ろす」経路ごと落ちるので、
 * 輸出の一覧を検査として置いておく。
 */
describe('パッケージの入口', () => {
  it('CLI が使う名前を出している', () => {
    for (const name of ['HttpCloudClient', 'deriveFileKey', 'decryptStream', 'sha256Stream', 'remoteTranscriptPath'] as const) {
      expect(api[name], name).toBeTypeOf('function');
    }
  });
  it('これまでの名前を落としていない', () => {
    for (const name of ['startServer', 'VERSION', 'hangarHome', 'defaultClaudeDir', 'ensureHome', 'readOrCreateToken', 'readOrCreateDevice', 'loadSettings', 'saveSettings', 'STATUSLINE_MARKER', 'appendStatuslineSnippet', 'ensureStatuslineHeaderFile', 'resolveStatuslineScript', 'statuslineHeaderPath', 'statuslineSnippet', 'statuslineSnippetUpToDate', 'statuslineStatus', 'writeStatuslineHeaderFile', 'claudeJsonPath', 'upsertUserMcpServer', 'backupsRoot', 'cloudConfigPath', 'loadCloudConfig', 'readCloudConfig', 'remoteRoot', 'saveCloudConfig', 'SyncStateStore', 'onSharedWrite'] as const) {
      expect(api[name], name).toBeDefined();
    }
  });
  it('暗号の対も出している', () => {
    for (const name of ['CloudError', 'goneFloor', 'CHUNK_SIZE', 'encryptStream', 'encryptBuffer', 'decryptBuffer', 'sha256Hex', 'DEFAULT_TIMEOUT_MS', 'DEFAULT_TRANSFER_TIMEOUT_MS'] as const) {
      expect(api[name], name).toBeDefined();
    }
  });
});
