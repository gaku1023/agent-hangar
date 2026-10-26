/**
 * hangar が起こせるエージェントの一覧。種類、表示名、UI の分岐で要る能力は、ここを正本にする。
 * 型の直書き（'claude-code' | 'opencode'）を各所に書かず、ここから導く。
 * 並びは札の一覧の順で、先頭が既定である。値は sessions.provider の列に入る値と同じ。
 */
export const AGENT_KINDS = ['claude-code', 'opencode'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === 'string' && (AGENT_KINDS as readonly string[]).includes(v);
}

/** 製品の名前。読み上げとツールチップ、タブの題に使う。訳さない。 */
export const AGENT_DISPLAY_NAME: Record<AgentKind, string> = { 'claude-code': 'Claude Code', opencode: 'opencode' };

/**
 * UI が出し分けに使う能力。server の AgentCaps（driver が持つ能力）とは別で、画面の札と欄の有無だけを持つ。
 * accounts・effort・permissionMode・worktree・addDirs は新規ダイアログの札（LaunchParams の同名の欄）。
 * modes は mode と autoApprove の札、promptJump は目次から左の画面を跳ばせるか、usagePanel は会話の使用量の欄を自前で組むか、beta は設定で有効にしたときだけ選べるか。
 */
export type AgentUiCaps = {
  accounts: boolean;
  effort: boolean;
  permissionMode: boolean;
  worktree: boolean;
  addDirs: boolean;
  modes: boolean;
  promptJump: boolean;
  usagePanel: boolean;
  beta: boolean;
};

export const AGENT_UI_CAPS: Record<AgentKind, AgentUiCaps> = {
  'claude-code': { accounts: true, effort: true, permissionMode: true, worktree: true, addDirs: true, modes: false, promptJump: true, usagePanel: false, beta: false },
  opencode: { accounts: false, effort: false, permissionMode: false, worktree: false, addDirs: false, modes: true, promptJump: false, usagePanel: true, beta: true },
};
