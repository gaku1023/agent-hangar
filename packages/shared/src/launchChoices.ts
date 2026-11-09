import { AGENT_KINDS, type AgentKind } from './agents.ts';
import { CODEX_PERMISSIONS, isCodexPermission } from './codexCompat.ts';
/**
 * 新しい会話を起こすときに選べる値。PC の新規セッションのダイアログとスマホの画面が同じ値を使う。
 * 空は「既定」で、起動の params に含めず Claude Code の設定に従わせる。
 */
export const PERMISSION_MODE_VALUES = ['', 'plan', 'manual', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const;
export type PermissionModeValue = (typeof PERMISSION_MODE_VALUES)[number];

/**
 * Claude Code が受ける権限モードの値。新規ダイアログに出す値（PERMISSION_MODE_VALUES）に、MCP と --permission-mode が受ける default を足した一覧である。
 * 別の PC への起動の受け手の検査と、送る側の検査が同じ一覧を見る。ダイアログの値は増やさない。
 */
export const CLAUDE_PERMISSION_MODE_VALUES = [...PERMISSION_MODE_VALUES, 'default'] as const;
const CLAUDE_PERMISSION_MODES: ReadonlySet<string> = new Set(CLAUDE_PERMISSION_MODE_VALUES);

/**
 * 別の PC への起動の頼みの、権限の値が受けられるか。送る側が封をする前と、受け手が意味を検査するときに同じ関数を使う。
 * Codex の権限は mode か permissionMode のどちらかに入っていればよい（mode が先）。opencode には権限モードが無いので空だけを受ける。
 */
export function isPeerLaunchPermission(r: { agent: AgentKind; permissionMode: string; mode?: string }): boolean {
  if (r.agent === 'codex') {
    const perm = r.mode || r.permissionMode;
    return perm === '' || isCodexPermission(perm);
  }
  if (r.agent === 'opencode') return r.permissionMode === '';
  return CLAUDE_PERMISSION_MODES.has(r.permissionMode);
}

/** エージェントごとの、受けられる権限の値（空は除く）。断りの文言に並べる。opencode は空の一覧。 */
export function peerLaunchPermissionChoices(agent: AgentKind): readonly string[] {
  if (agent === 'codex') return CODEX_PERMISSIONS;
  if (agent === 'opencode') return [];
  return CLAUDE_PERMISSION_MODE_VALUES.filter((v) => v !== '');
}

/**
 * effort の選択肢。PC の新規セッションの札とスマホの画面と、スマホの依頼を受ける PC が同じ値を使う。
 * 空は「既定」で、起動の params に含めず Claude Code の設定に従わせる。
 */
export const EFFORT_VALUES = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortValue = (typeof EFFORT_VALUES)[number];

export function isEffort(v: unknown): v is EffortValue {
  return typeof v === 'string' && (EFFORT_VALUES as readonly string[]).includes(v);
}

/**
 * 起こすエージェント（新しいセッションの「エージェント」の札）。並びは札の一覧の順で、先頭が既定である。
 * opencode（ベータ）は設定で有効にしたときだけ選べる。
 */
export const AGENT_VALUES = AGENT_KINDS;
export type AgentValue = AgentKind;

export function isAgentValue(v: unknown): v is AgentValue {
  return typeof v === 'string' && (AGENT_VALUES as readonly string[]).includes(v);
}

/** opencode のモードの既定。opencode が既定で使う primary のエージェントである。 */
export const OPENCODE_DEFAULT_MODE = 'build';

/** モードの一覧から、はじめに選んでおくモード。build があれば build、無ければ先頭、一覧が空なら空（params に載せない）。 */
export function defaultOpencodeMode(modes: readonly { id: string }[]): string {
  return modes.some((m) => m.id === OPENCODE_DEFAULT_MODE) ? OPENCODE_DEFAULT_MODE : modes[0]?.id ?? '';
}

export { MODEL_CHOICES } from './summaryEngine.ts';
