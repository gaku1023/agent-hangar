/**
 * CLI（packages/cli）が使う名前を出す入口。
 * サーバ本体（server.ts）と、その先の HTTP、MCP、tmux、node-pty をたどらない。
 * パッケージの入口（index.ts）から取ると、esbuild がサーバ全体を cli.mjs へ束ね、配布物にサーバが二重に入る。
 * ここに名前を足すときも、server.ts を import しないモジュールから取る。
 * cli.mjs がサーバを抱えていないことは apps/desktop/test/bundle-server.test.ts が確かめる。
 */
export { hangarHome, defaultClaudeDir, dbPath, ensureHome, readOrCreateToken, readOrCreateDevice, loadSettings, saveSettings } from './config/paths.ts';
export { PS_STATUSLINE_MARKER, STATUSLINE_MARKER, appendStatuslineSnippet, hasStatuslineMarker, isPowerShellScript, planStatuslineRemoval, planStatuslineSnippet, removeStatuslineSnippet, statuslineSnippetFor, type StatuslineEdit, type StatuslineRemoval, ensureStatuslineHeaderFile, resolveStatuslineScript, statuslineHeaderPath, statuslineSnippet, statuslineSnippetUpToDate, statuslineStatus, writeStatuslineHeaderFile } from './provider/claude-code/config/statusline.ts';
export { claudeJsonPath, readUserMcpServers, removeUserMcpServer, upsertUserMcpServer } from './provider/claude-code/config/claudeJson.ts';
export { readUtf8Text, utf8Problem } from './config/textEncoding.ts';
export { SHELL_MARKER, ensureShellScript, installShellHook, planShellHook, planShellUnhook, shellHookInstalled, shellHookLine, shellHookState, shellHookUpToDate, shellScriptPath, shellWrapOsSupported, shellWrapSupported, uninstallShellHook, zshrcPath, type ShellHookState, type ShellScriptOptions } from './config/shellHook.ts';
export { backupsRoot, checkCloudConfigPerms, cloudConfigPath, loadCloudConfig, parseCloudConfigV2, readCloudConfig, remoteRoot, saveCloudConfig, type CloudConfig, type CloudConfigRead } from './config/cloud.ts';
// 版 1 の cloud.json を読むのは、古いクラウドを片付ける hangar cloud teardown だけである（Task 26 が作り直す）。
// CLI は版 1 を書かない。
export { readLegacyCloudConfig, type LegacyCloudConfig } from './config/cloud.ts';
export { SyncStateStore, type SyncStateKey } from './sync/state.ts';
// 本文をどこから上げるかの床。
// 刻むのは CLI の hangar setup cloud と hangar join（cloud.json を書くのと同じ時点）である。
// setup cloud と join は、外に何かを作る前に openTranscriptsFloor で DB を開いておく（控えが取れなければそこで止まる）。
// 読むのは hangar cloud status、0 へ落とすのは hangar cloud backfill である。
export { backfillTranscripts, openTranscriptsFloor, readTranscriptsFrom } from './sync/transcriptsFrom.ts';
export { onSharedWrite } from './db/shared.ts';
// クラウドの入口。CLI の hangar cloud teardown が、R2 にしか無い本文を先に手元へ降ろすのに使う。
// 鍵の導出とパスの組み立てを写して持つと、片方だけ直されて食い違うので、ここから正面で配る。
export { CloudError, CompatError, DEFAULT_TIMEOUT_MS, DEFAULT_TRANSFER_TIMEOUT_MS, HttpCloudClient, MIN_WORKER_COMPAT, RevokedError, type CloudClient, type HttpCloudClientOptions, type WireCloudClient } from './sync/client.ts';
export { CHUNK_SIZE, decryptBuffer, decryptStream, encryptBuffer, encryptStream, sha256Hex, sha256Stream } from './sync/crypto.ts';
export { remoteTranscriptPath } from './sync/puller.ts';
export { agentOfSyncPath, AGENT_SYNC } from './sync/agentSync.ts';
// 鍵の束と名簿。CLI の hangar recover が、名簿を開いて自分を足す（条件付き更新の当て直しをサーバと同じ実装で行う）のに使う。
// 版 2 のクラウドの teardown も、封じた索引を開いて本文を降ろすのに Keyring を使う（同期と同じ開き方にする）。
export { Keyring } from './sync/keyring.ts';
export { RosterStore, type ConfigWriter } from './sync/roster.ts';
export { openSealedFile, SealedCloudClient } from './sync/sealedClient.ts';
// リカバリーキーの末尾 4 文字の正規化。CLI の setup の確認と、サーバーの再発行の確認が同じ関数で照合する。
export { normalizeRecoveryTail } from './sync/recoveryTail.ts';
// 設定の同期の適用と世代へ戻す。CLI の hangar config apply と hangar config restore、および殻の命令が呼ぶ（サーバは `~/.claude` に書かない。全体計画の D9）。
// 読むのは hangar の置き場の指示書と inbox、書くのは設定の入れ物と、基準の表（DB）だけで、サーバ本体は引かない。
export { ApplyError, planApply, planApplyFiles, planRestore, planRestoreFiles, runApply, runRestore, type PlannedFile, type PlannedFiles, type ApplyErrorCode, type ApplyPlan, type ApplyPlanItem, type ApplyResult, type RestorePlan, type RestoreResult } from './sync/config/apply.ts';
export { listBackups } from './sync/config/backups.ts';
export { listAllBackups, planRestoreTarget, planRestoreTargetFiles, runRestoreTarget, type ApplyAllPlan } from './sync/config/applyAll.ts';
export { defaultTargetPaths } from './sync/config/targets/paths.ts';
// 承諾の窓に見せる差分（hangar mcp、shell、statusline の --dry-run）。設定の同期の競合と同じ行の形で作る。
export { diffLines } from './config/jsonTextEdit.ts';
export { openDb, type Db } from './db/open.ts';
// OS の違いを吸う口。CLI の hangar open（ブラウザを開く）と hangar setup（道具を探す）が使う。
export { openTargetCommand } from './platform/browser.ts';
// パスの比べ方（区切り、Windows の大文字小文字）。
// CLI の hangar project remove が、この PC の場所のパスでプロジェクトを選ぶのに使う。
// coversHome は hangar workspace set が、サーバの POST /api/workspace/trust と同じ規則でホームとその上を断るのに使う。
export { coversHome, samePath } from './platform/paths.ts';
export { findInDirs, knownDirs, MUX_NAMES, splitPathEnv } from './platform/exec.ts';
