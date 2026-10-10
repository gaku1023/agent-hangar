/**
 * CLI（packages/cli）が使う名前を出す入口。
 * サーバ本体（server.ts）と、その先の HTTP、MCP、tmux、node-pty をたどらない。
 * パッケージの入口（index.ts）から取ると、esbuild がサーバ全体を cli.mjs へ束ね、配布物にサーバが二重に入る。
 * ここに名前を足すときも、server.ts を import しないモジュールから取る。
 * cli.mjs がサーバを抱えていないことは apps/desktop/test/bundle-server.test.ts が確かめる。
 */
export { hangarHome, defaultClaudeDir, dbPath, ensureHome, readOrCreateToken, readOrCreateDevice, loadSettings, saveSettings } from './config/paths.ts';
export { STATUSLINE_MARKER, appendStatuslineSnippet, ensureStatuslineHeaderFile, resolveStatuslineScript, statuslineHeaderPath, statuslineSnippet, statuslineSnippetUpToDate, statuslineStatus, writeStatuslineHeaderFile } from './provider/claude-code/config/statusline.ts';
export { claudeJsonPath, upsertUserMcpServer } from './provider/claude-code/config/claudeJson.ts';
export { SHELL_MARKER, ensureShellScript, installShellHook, shellHookInstalled, shellHookLine, shellHookState, shellHookUpToDate, shellScriptPath, shellWrapOsSupported, shellWrapSupported, uninstallShellHook, zshrcPath, type ShellHookState, type ShellScriptOptions } from './config/shellHook.ts';
export { backupsRoot, cloudConfigPath, loadCloudConfig, readCloudConfig, remoteRoot, saveCloudConfig, type CloudConfig, type CloudConfigRead } from './config/cloud.ts';
export { SyncStateStore, type SyncStateKey } from './sync/state.ts';
// 本文をどこから上げるかの床。
// 刻むのは CLI の hangar setup cloud と hangar join（cloud.json を書くのと同じ時点）である。
// setup cloud と join は、外に何かを作る前に openTranscriptsFloor で DB を開いておく（控えが取れなければそこで止まる）。
// 読むのは hangar cloud status、0 へ落とすのは hangar cloud backfill である。
export { backfillTranscripts, openTranscriptsFloor, readTranscriptsFrom } from './sync/transcriptsFrom.ts';
export { onSharedWrite } from './db/shared.ts';
// クラウドの入口。CLI の hangar cloud teardown が、R2 にしか無い本文を先に手元へ降ろすのに使う。
// 鍵の導出とパスの組み立てを写して持つと、片方だけ直されて食い違うので、ここから正面で配る。
export { CloudError, DEFAULT_TIMEOUT_MS, DEFAULT_TRANSFER_TIMEOUT_MS, HttpCloudClient, goneFloor, type CloudClient, type HttpCloudClientOptions } from './sync/client.ts';
export { CHUNK_SIZE, decryptBuffer, decryptStream, deriveFileKey, encryptBuffer, encryptStream, sha256Hex, sha256Stream } from './sync/crypto.ts';
export { remoteTranscriptPath } from './sync/puller.ts';
// 設定の同期の適用と世代へ戻す。CLI の hangar config apply と hangar config restore、および殻の命令が呼ぶ（サーバは `~/.claude` に書かない。全体計画の D9）。
// 読むのは hangar の置き場の指示書と inbox、書くのは設定の入れ物と、基準の表（DB）だけで、サーバ本体は引かない。
export { ApplyError, planApply, planRestore, runApply, runRestore, type ApplyErrorCode, type ApplyPlan, type ApplyPlanItem, type ApplyResult, type RestorePlan, type RestoreResult } from './sync/config/apply.ts';
export { listBackups } from './sync/config/backups.ts';
export { openDb, type Db } from './db/open.ts';
// OS の違いを吸う口。CLI の hangar open（ブラウザを開く）と hangar setup（道具を探す）が使う。
export { openTargetCommand } from './platform/browser.ts';
export { findInDirs, knownDirs, MUX_NAMES, splitPathEnv } from './platform/exec.ts';
