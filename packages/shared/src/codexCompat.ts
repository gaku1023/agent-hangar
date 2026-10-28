/**
 * Codex との互換と、Codex の設定の読み方（docs/design.md「Codex の検出（ベータ）」）。
 * hangar が使う codex は利用者が入れたもの（PATH）で、確かめた範囲の外でも起動は止めず、知らせるだけにする。
 */

/**
 * 確かめた codex の版の範囲。x はその区切りを問わない。
 * 範囲を広げたら、範囲の判定（server の provider/codex/compat/version.ts）の試験もそろえる。
 */
export const CODEX_VERIFIED_RANGE = '0.165.x';

/**
 * hangar が起動する codex のシステムプロンプトへ足す指示の量。
 * minimal は hangar の MCP の使い方だけ（既定）、claude は Claude Code に足すのと同じ段、none は足さない。
 */
export type CodexInjection = 'minimal' | 'claude' | 'none';
export const CODEX_INJECTIONS: readonly CodexInjection[] = ['minimal', 'claude', 'none'];
export const DEFAULT_CODEX_INJECTION: CodexInjection = 'minimal';

export const isCodexInjection = (v: unknown): v is CodexInjection => typeof v === 'string' && (CODEX_INJECTIONS as readonly string[]).includes(v);

/** Codex を有効にするか（ベータ）。この項目を知らない古いサーバは返さないので、true のときだけ入りとして読む。 */
export const codexEnabledOf = (s: { codexEnabled?: boolean }): boolean => s.codexEnabled === true;

/** 外のターミナルの codex コマンドを hangar 経由で起動するか（シェルの包み、macOS と Linux だけ）。既定は切で、true のときだけ入りとして読む。 */
export const codexInterceptOf = (s: { codexIntercept?: boolean }): boolean => s.codexIntercept === true;

/** Claude Code の指示（CLAUDE.md）と MCP の登録を、起動のときに渡すか。指示は入、MCP は切が既定（2026-10-28 に利用者が決めた）。真偽値でない値は既定に寄せる。 */
export const codexShareOf = (s: { codexShareInstructions?: boolean; codexShareMcp?: boolean }): { instructions: boolean; mcp: boolean } => ({ instructions: s.codexShareInstructions !== false, mcp: s.codexShareMcp === true });

/** システムプロンプトへの追記。無い項目と知らない値は既定（最小限）に寄せる。 */
export const codexInjectionOf = (s: { codexInjection?: CodexInjection }): CodexInjection => (isCodexInjection(s.codexInjection) ? s.codexInjection : DEFAULT_CODEX_INJECTION);

/**
 * 手元の codex の検出の結果（server の provider/codex/compat/version.ts の LocalCodex.status）。
 * found は PATH に codex があるか、version は `codex --version` から読めた版（読めなければ null）、
 * verified は版が確かめた範囲の中にあるか（見つからないときと版が読めないときは false）、
 * loggedIn は `codex login status` が 0 で終わったか（0 以外は false、時間切れで分からないときは null、見つからないときと起こせないときは false）。
 */
export type CodexStatusDto = { found: boolean; version: string | null; verified: boolean; loggedIn: boolean | null };

/**
 * 新しい会話の権限（Codex の /approvals と同じ 3 段）。LaunchParams.permissionMode にこの値を入れる。
 * 空と未指定は auto（Codex の既定と同じ）。サンドボックスと承認の組は CODEX_PERMISSION_FLAGS が決める。
 */
export type CodexPermission = 'read-only' | 'auto' | 'full-access';
export const CODEX_PERMISSIONS: readonly CodexPermission[] = ['read-only', 'auto', 'full-access'];
export const DEFAULT_CODEX_PERMISSION: CodexPermission = 'auto';
export const isCodexPermission = (v: unknown): v is CodexPermission => typeof v === 'string' && (CODEX_PERMISSIONS as readonly string[]).includes(v);
/** 3 段それぞれの `-s`（sandbox）と `-a`（approval）。 */
export const CODEX_PERMISSION_FLAGS: Record<CodexPermission, { sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'; approval: 'on-request' | 'never' }> = {
  'read-only': { sandbox: 'read-only', approval: 'on-request' },
  auto: { sandbox: 'workspace-write', approval: 'on-request' },
  'full-access': { sandbox: 'danger-full-access', approval: 'never' },
};
