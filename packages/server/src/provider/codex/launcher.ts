import { CODEX_PERMISSION_FLAGS, DEFAULT_CODEX_PERMISSION, isCodexPermission, type CodexPermission } from '@agent-hangar/shared';
import type { InjectionEntry, LaunchPlan, LaunchSpec, SessionMode } from '../../agent/types.ts';

/**
 * Codex の起動の組み立て（計画の B3a、docs/design.md「Codex の起動（ベータ）」）。純粋な関数だけで、プロセスにも DB にも触らない。
 * app-server と TUI（`--remote`）は別のプロセスで、設定の効く先が違う（findings 3 節）。
 * - app-server：MCP、追記、推論、権限の既定。TUI の `-c` は app-server に効かないので、会話に効かせたい設定は app-server の起動時に `-c` で渡す。
 * - TUI：モデル、推論、`-s`、`-a`。resume なしの TUI は自分でスレッドを作る（初期プロンプトが無いとき）ので、そのスレッドへ効かせるために TUI の側にも渡す。
 * ~/.codex の設定ファイルは書かない（`-c` だけ）。
 */

/** hangar の MCP の名前。Codex の設定の `mcp_servers.<名前>` の鍵で、道具は `mcp__hangar` の名前空間に載る。 */
export const HANGAR_MCP_NAME = 'hangar';
/** MCP の bearer token を入れる環境変数の名前。値は app-server の環境にだけ置き、argv にも設定にも載せない。 */
export const MCP_TOKEN_ENV = 'HANGAR_CODEX_MCP_TOKEN';
/** ID がまだ分からない会話の仮の ID の頭（runs/manager.ts の startMaterialized が付ける）。 */
export const PENDING_PREFIX = 'pending:';

/** 起動の指定が Codex に通らない。呼び手（RunManager）は 400 にする。 */
export class CodexLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexLaunchError';
  }
}

/** TOML の基本文字列（JSON の文字列の記法で足りる）。 */
const toml = (s: string): string => JSON.stringify(s);

/** 権限の指定（LaunchSpec.mode）を 3 段のどれかにする。空は自動。知らない値は断る。 */
export function codexPermissionOf(mode: string | undefined): CodexPermission {
  const m = mode?.trim();
  if (!m) return DEFAULT_CODEX_PERMISSION;
  if (!isCodexPermission(m)) throw new CodexLaunchError(`unknown codex permission: ${m.slice(0, 40)}`);
  return m;
}

/** 推論の段階。TOML の文字列に入れるので、小文字の英数字と _ - だけを受ける。 */
export function codexEffortOf(effort: string | undefined): string | undefined {
  const e = effort?.trim();
  if (!e) return undefined;
  if (!/^[a-z0-9_-]{1,24}$/.test(e)) throw new CodexLaunchError(`unknown codex reasoning effort: ${e.slice(0, 40)}`);
  return e;
}

/** 段を区切りを足さずにつないだ 1 つの追記。段が無ければ null（渡さない）。 */
export function instructionValue(entries: readonly InjectionEntry[]): string | null {
  return entries.length ? entries.map((e) => e.text).join('') : null;
}

/** app-server の起動に足す `-c key=value`（値は TOML）。 */
export function codexAppServerConfig(spec: LaunchSpec, perm: CodexPermission): string[] {
  const flags = CODEX_PERMISSION_FLAGS[perm];
  const out = [
    `mcp_servers.${HANGAR_MCP_NAME}.url=${toml(spec.mcp.url)}`,
    `mcp_servers.${HANGAR_MCP_NAME}.bearer_token_env_var=${toml(MCP_TOKEN_ENV)}`,
    // 注釈の無い道具は既定で承認が要り、承認を待つ手が無い（never だと失敗する）。hangar の道具は承認なしで呼ばせる。
    `mcp_servers.${HANGAR_MCP_NAME}.default_tools_approval_mode="approve"`,
    `sandbox_mode=${toml(flags.sandbox)}`,
    `approval_policy=${toml(flags.approval)}`,
  ];
  const effort = codexEffortOf(spec.effort);
  if (effort) out.push(`model_reasoning_effort=${toml(effort)}`);
  if (spec.model?.trim()) out.push(`model=${toml(spec.model.trim())}`);
  const inst = instructionValue(spec.instructions);
  if (inst !== null) out.push(`developer_instructions=${toml(inst)}`);
  return out;
}

/**
 * tmux の中で起こす TUI の argv と環境。
 * 新しい会話で ID がまだ無い（pending:）ときは、resume を付けずにつなぐ。TUI が自分でスレッドを作り、hangar は `thread/started` で ID を知る。
 * token は環境変数（TUI_TOKEN_ENV）で渡し、argv に載せない。秘密の環境（secretEnv）として 0600 のファイルから包みが読んで消す（launch/secretEnv.ts）。
 * Claude だけの指定（アカウント、worktree、追加ディレクトリ、Remote Control）は捨てる。RunManager が入口で断る。
 * 起こすものへは CLAUDE 系と HANGAR_* を持ち込まない。アカウントの置き場（CLAUDE_CONFIG_DIR）と CODEX_HOME も効かせない（決定 9）。
 */
export function planCodex(bin: string, mode: SessionMode, spec: LaunchSpec, remote: { args: string[]; env: Record<string, string> }, droppedEnv: readonly string[]): LaunchPlan {
  if (mode.kind !== 'start') throw new Error(`codex cannot ${mode.kind} a session yet`);
  const flags = CODEX_PERMISSION_FLAGS[codexPermissionOf(spec.mode)];
  const argv = [bin, ...remote.args];
  if (spec.model?.trim()) argv.push('-m', spec.model.trim());
  const effort = codexEffortOf(spec.effort);
  if (effort) argv.push('-c', `model_reasoning_effort=${toml(effort)}`);
  argv.push('-s', flags.sandbox, '-a', flags.approval);
  if (!mode.id.startsWith(PENDING_PREFIX)) argv.push('resume', mode.id);
  return { argv, env: {}, secretEnv: { ...remote.env }, unset: [...new Set([...droppedEnv, 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'])] };
}
