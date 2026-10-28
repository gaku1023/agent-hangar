/**
 * opencode との互換と、opencode の設定の読み方（docs/design.md「opencode の検出（ベータ）」）。
 * hangar が使う opencode は利用者が入れたもので、確かめた範囲の外でも起動は止めず、知らせるだけにする。
 */

/**
 * 確かめた opencode の版の範囲。x はその区切りを問わない。
 * 範囲を広げたら、範囲の判定（server の provider/opencode/compat/version.ts）の試験もそろえる。
 */
export const OPENCODE_VERIFIED_RANGE = '2.2.x';

/**
 * hangar が起動する opencode のシステムプロンプトへ足す指示の量。
 * minimal は hangar の MCP の使い方だけ（既定）、claude は Claude Code に足すのと同じ段、none は足さない。
 */
export type OpencodeInjection = 'minimal' | 'claude' | 'none';
export const OPENCODE_INJECTIONS: readonly OpencodeInjection[] = ['minimal', 'claude', 'none'];
export const DEFAULT_OPENCODE_INJECTION: OpencodeInjection = 'minimal';

export const isOpencodeInjection = (v: unknown): v is OpencodeInjection => typeof v === 'string' && (OPENCODE_INJECTIONS as readonly string[]).includes(v);

/** opencode を有効にするか（ベータ）。この項目を知らない古いサーバは返さないので、true のときだけ入りとして読む。 */
export const opencodeEnabledOf = (s: { opencodeEnabled?: boolean }): boolean => s.opencodeEnabled === true;

/** 外のターミナルの opencode コマンドを hangar 経由で起動するか（シェルの包み、macOS と Linux だけ）。既定は切で、true のときだけ入りとして読む。 */
export const opencodeInterceptOf = (s: { opencodeIntercept?: boolean }): boolean => s.opencodeIntercept === true;

/** hangar が起動する opencode に許可のひな形を重ねるか。既定は入りで、false のときだけ切として読む。 */
export const opencodePermissionPresetOf = (s: { opencodePermissionPreset?: boolean }): boolean => s.opencodePermissionPreset !== false;

/** Claude Code の指示（CLAUDE.md）と MCP の登録を、起動のときに渡すか。指示は入、MCP は切が既定（2026-10-28 に利用者が決めた）。真偽値でない値は既定に寄せる。 */
export const opencodeShareOf = (s: { opencodeShareInstructions?: boolean; opencodeShareMcp?: boolean }): { instructions: boolean; mcp: boolean } => ({ instructions: s.opencodeShareInstructions !== false, mcp: s.opencodeShareMcp === true });

/** システムプロンプトへの追記。無い項目と知らない値は既定（最小限）に寄せる。 */
export const opencodeInjectionOf = (s: { opencodeInjection?: OpencodeInjection }): OpencodeInjection => (isOpencodeInjection(s.opencodeInjection) ? s.opencodeInjection : DEFAULT_OPENCODE_INJECTION);

/**
 * GET /api/opencode/status。
 * found は PATH と既知の置き場に opencode があるか、version は `opencode --version` から読めた版（読めなければ null）、
 * verified は版が確かめた範囲の中にあるか。見つからないときと版が読めないときは false である。
 * configPermissions は設定の画面が、許可のひな形のスイッチを無効にして注記を出すのに使う。
 */
export type OpencodeStatusDto = { found: boolean; version: string | null; verified: boolean; /** 利用者の opencode.json の上の段に許可の規則（permission、permissions、tools）があるか。あれば許可のひな形は重ねない。この項目を知らない古いサーバは返さない。 */ configPermissions?: boolean };
