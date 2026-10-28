import type { ShareSettingsProps } from '../presenters/share.ts';

/** 試験用の、2 つとも切（一覧なし）の「Claude Code の指示 / MCP を渡す」の props。 */
export const shareOff = (agent: ShareSettingsProps['agent']): ShareSettingsProps => ({
  agent,
  instructions: { on: false, desc: '起動時に CLAUDE.md の内容を渡します。', list: null },
  mcp: { on: false, desc: '起動時に MCP サーバを変換して渡します。', list: null },
});
