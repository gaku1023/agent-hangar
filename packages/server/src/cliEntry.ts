/**
 * CLI（packages/cli）が使う名前を出す入口。
 * サーバ本体（server.ts）と、その先の HTTP、MCP、tmux、node-pty をたどらない。
 * パッケージの入口（index.ts）から取ると、esbuild がサーバ全体を cli.mjs へ束ね、配布物にサーバが二重に入る。
 * ここに名前を足すときも、server.ts を import しないモジュールから取る。
 * cli.mjs がサーバを抱えていないことは apps/desktop/test/bundle-server.test.ts が確かめる。
 */
export { hangarHome, defaultClaudeDir, ensureHome, readOrCreateToken, readOrCreateDevice, loadSettings, saveSettings } from './config/paths.ts';
export { STATUSLINE_MARKER, appendStatuslineSnippet, ensureStatuslineHeaderFile, resolveStatuslineScript, statuslineHeaderPath, statuslineSnippet, statuslineSnippetUpToDate, statuslineStatus, writeStatuslineHeaderFile } from './config/statusline.ts';
export { claudeJsonPath, upsertUserMcpServer } from './config/claudeJson.ts';
export { SHELL_MARKER, ensureShellScript, installShellHook, shellHookInstalled, shellHookLine, shellHookState, shellHookUpToDate, shellScriptPath, shellWrapSupported, uninstallShellHook, zshrcPath, type ShellHookState, type ShellScriptOptions } from './config/shellHook.ts';
export { backupsRoot, cloudConfigPath, loadCloudConfig, readCloudConfig, remoteRoot, saveCloudConfig, type CloudConfig, type CloudConfigRead } from './config/cloud.ts';
export { SyncStateStore, type SyncStateKey } from './sync/state.ts';
// 本文をどこから上げるかの床。
// 刻むのは CLI の hangar setup cloud と hangar join（cloud.json を書くのと同じ時点）である。
// 読むのは hangar cloud status、0 へ落とすのは hangar cloud backfill である。
export { backfillTranscripts, readTranscriptsFrom, stampTranscriptsFrom } from './sync/transcriptsFrom.ts';
export { onSharedWrite } from './db/shared.ts';
// クラウドの入口。CLI の hangar cloud teardown が、R2 にしか無い本文を先に手元へ降ろすのに使う。
// 鍵の導出とパスの組み立てを写して持つと、片方だけ直されて食い違うので、ここから正面で配る。
export { CloudError, DEFAULT_TIMEOUT_MS, DEFAULT_TRANSFER_TIMEOUT_MS, HttpCloudClient, goneFloor, type CloudClient, type HttpCloudClientOptions } from './sync/client.ts';
export { CHUNK_SIZE, decryptBuffer, decryptStream, deriveFileKey, encryptBuffer, encryptStream, sha256Hex, sha256Stream } from './sync/crypto.ts';
export { remoteTranscriptPath } from './sync/puller.ts';
