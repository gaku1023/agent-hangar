/**
 * hangar が起こせるエージェントの一覧。種類、表示名、UI の分岐で要る能力は、ここを正本にする。
 * 型の直書き（'claude-code' | 'opencode'）を各所に書かず、ここから導く。
 * 並びは札の一覧の順で、先頭が既定である。値は sessions.provider の列に入る値と同じ。
 */
export const AGENT_KINDS = ['claude-code', 'codex', 'opencode'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** 既定のエージェント（札の先頭）。前回の選択が無いとき、設定で他が無効なときに使う。 */
export const DEFAULT_AGENT_KIND: AgentKind = AGENT_KINDS[0];
/** 既定でないエージェント。前回の選択や、実行中の写しや、タブの印で「既定ではない」と言うときの型。 */
export type NonDefaultAgentKind = Exclude<AgentKind, 'claude-code'>;

export function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === 'string' && (AGENT_KINDS as readonly string[]).includes(v);
}

/** 製品の名前。読み上げとツールチップ、タブの題に使う。訳さない。 */
export const AGENT_DISPLAY_NAME: Record<AgentKind, string> = { 'claude-code': 'Claude Code', opencode: 'opencode', codex: 'Codex' };

/**
 * UI が出し分けに使う能力。server の AgentCaps（driver が持つ能力）とは別で、画面の札と欄の有無だけを持つ。
 * accounts・effort・permissionMode・worktree・addDirs は新規ダイアログの札（LaunchParams の同名の欄）。
 * modelText は自由入力のモデルの札、recallLine は前回の詳細をまとめた行、trustNote はフォルダを信頼する注意、digestIntent は意図を digest から読むか（無ければ依頼の冒頭を出す）。
 * modelList はエージェントが返すモデルの一覧から選ぶ札の組（モデル、推論、権限の 3 枚。Codex）で、effort と permissionMode は Claude Code の自由な値の札なので、この組には使わない。
 * modes は mode と autoApprove の札、promptJump は目次から左の画面を跳ばせるか、usagePanel は会話の使用量の欄を自前で組むか、beta は設定で有効にしたときだけ選べるか。
 */
export type AgentUiCaps = {
  accounts: boolean;
  effort: boolean;
  permissionMode: boolean;
  worktree: boolean;
  addDirs: boolean;
  modelText: boolean;
  recallLine: boolean;
  trustNote: boolean;
  digestIntent: boolean;
  modes: boolean;
  promptJump: boolean;
  usagePanel: boolean;
  modelList: boolean;
  beta: boolean;
};

export const AGENT_UI_CAPS: Record<AgentKind, AgentUiCaps> = {
  'claude-code': { accounts: true, effort: true, permissionMode: true, worktree: true, addDirs: true, modelText: true, recallLine: true, trustNote: true, digestIntent: true, modes: false, promptJump: true, usagePanel: false, modelList: false, beta: false },
  opencode: { accounts: false, effort: false, permissionMode: false, worktree: false, addDirs: false, modelText: false, recallLine: false, trustNote: false, digestIntent: false, modes: true, promptJump: false, usagePanel: true, modelList: false, beta: true },
  // Codex の新規ダイアログの札は、モデルの一覧から選ぶ組（modelList）。自由入力のモデル、Claude の effort と権限モード、アカウント、worktree の札は出さない。右欄の面は段 C の続きで足す。
  codex: { accounts: false, effort: false, permissionMode: false, worktree: false, addDirs: false, modelText: false, recallLine: false, trustNote: false, digestIntent: false, modes: false, promptJump: false, usagePanel: true, modelList: true, beta: true },
};

export type AgentUiCap = keyof AgentUiCaps;

/** その能力を持つエージェントの一覧（AGENT_KINDS の順）。画面の札が「どのエージェントのとき出すか」の正本。 */
export function agentsWithCap(cap: AgentUiCap): AgentKind[] {
  return AGENT_KINDS.filter((k) => AGENT_UI_CAPS[k][cap]);
}
