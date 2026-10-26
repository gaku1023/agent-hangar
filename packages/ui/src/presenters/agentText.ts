import type { AgentKind, Translate } from '@agent-hangar/shared';

/**
 * エージェントごとに文言が分かれる所の i18n キーの表。能力（AGENT_UI_CAPS）ではなく言葉の違いなので、ここで引く。
 * 製品の名前そのもの（読み上げ、タブの題）は shared の AGENT_DISPLAY_NAME。
 * 新しいエージェントは、ここに 1 行足す（キーの型の和にも足す。キーが i18n に無ければ型が落ちる）。
 */
export type AgentText = {
  /** 新規ダイアログのエージェントの札と一覧の行の名前。 */
  launchLabel: 'launch.agent.claude' | 'launch.agent.opencode';
  /** 「いま」の札の、聞かれていることの見出し。 */
  questionLabel: 'session.strip.questionLabel' | 'session.strip.opencode.questionLabel';
  /** 許可の待ちの見出し。道具の名前が分かれば添える。 */
  permissionHead: (t: Translate, tool: string | null) => string;
};

export const AGENT_TEXT: Record<AgentKind, AgentText> = {
  'claude-code': { launchLabel: 'launch.agent.claude', questionLabel: 'session.strip.questionLabel', permissionHead: (t, tool) => (tool !== null ? t('stop.card.permissionHeadTool', { tool }) : t('stop.card.permissionHead')) },
  opencode: { launchLabel: 'launch.agent.opencode', questionLabel: 'session.strip.opencode.questionLabel', permissionHead: (t, tool) => (tool !== null ? t('stop.card.permissionWaitingTool', { tool }) : t('stop.card.permissionWaiting')) },
};
