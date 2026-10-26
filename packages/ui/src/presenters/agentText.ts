import type { AgentKind, Translate } from '@agent-hangar/shared';

/**
 * エージェントごとに文言が分かれる所の i18n キーの表。能力（AGENT_UI_CAPS）ではなく言葉の違いなので、ここで引く。
 * 製品の名前そのもの（読み上げ、タブの題）は shared の AGENT_DISPLAY_NAME。
 * 新しいエージェントは、ここに 1 行足す（キーの型の和にも足す。キーが i18n に無ければ型が落ちる）。
 */
/** 終わった画面の 1 行の種類。訳文の鍵は ENDED_LINE_KEY で引く。 */
export type EndedLine = 'opencode' | 'codex' | 'codex-pending';
export const ENDED_LINE_KEY: Record<EndedLine, 'session.ended.opencode' | 'session.ended.codex' | 'session.ended.codex.pending'> = {
  opencode: 'session.ended.opencode', codex: 'session.ended.codex', 'codex-pending': 'session.ended.codex.pending',
};

export type AgentText = {
  /** 新規ダイアログのエージェントの札と一覧の行の名前。 */
  launchLabel: 'launch.agent.claude' | 'launch.agent.opencode' | 'launch.agent.codex';
  /** 「いま」の札の、聞かれていることの見出し。 */
  questionLabel: 'session.strip.questionLabel' | 'session.strip.opencode.questionLabel' | 'session.strip.codex.questionLabel';
  /** 「いま」の札の、このターンの意図の見出しと、その title（意図を書くのは MCP を呼んだモデル）。 */
  intentLabel: 'session.strip.opencode.intentLabel' | 'session.strip.codex.intentLabel';
  intentMeta: 'session.strip.opencode.intentMeta' | 'session.strip.codex.intentMeta';
  /** 終わった画面の本文の最後の 1 行（再開できるとき）。Claude Code は付けない。 */
  endedLine: EndedLine | null;
  /** 最初の入力の前に終わった会話の 1 行（再開を出さない）。無ければ null。 */
  endedPending: EndedLine | null;
  /** 許可の待ちの見出し。道具の名前が分かれば添える。 */
  permissionHead: (t: Translate, tool: string | null) => string;
};

export const AGENT_TEXT: Record<AgentKind, AgentText> = {
  'claude-code': { launchLabel: 'launch.agent.claude', questionLabel: 'session.strip.questionLabel', intentLabel: 'session.strip.opencode.intentLabel', intentMeta: 'session.strip.opencode.intentMeta', endedLine: null, endedPending: null, permissionHead: (t, tool) => (tool !== null ? t('stop.card.permissionHeadTool', { tool }) : t('stop.card.permissionHead')) },
  opencode: { launchLabel: 'launch.agent.opencode', questionLabel: 'session.strip.opencode.questionLabel', intentLabel: 'session.strip.opencode.intentLabel', intentMeta: 'session.strip.opencode.intentMeta', endedLine: 'opencode', endedPending: null, permissionHead: (t, tool) => (tool !== null ? t('stop.card.permissionWaitingTool', { tool }) : t('stop.card.permissionWaiting')) },
  codex: { launchLabel: 'launch.agent.codex', questionLabel: 'session.strip.codex.questionLabel', intentLabel: 'session.strip.codex.intentLabel', intentMeta: 'session.strip.codex.intentMeta', endedLine: 'codex', endedPending: 'codex-pending', permissionHead: (t, tool) => (tool !== null ? t('stop.card.permissionWaitingTool', { tool }) : t('stop.card.permissionWaiting')) },
};
