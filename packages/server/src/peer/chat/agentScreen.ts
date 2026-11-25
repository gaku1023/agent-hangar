import type { PaneKey } from '../../tmux/pane.ts';
import type { AgentAskReply, AgentPendingAsk } from '../../agent/pendingAsk.ts';
import type { AgentProvider, AgentScreenAnswer } from './agentAsk.ts';
import { codexScreenKeys } from './codexDialog.ts';
import { opencodeScreenKeys } from './opencodeDialog.ts';
import type { ScreenKey } from './dialogScreen.ts';

/**
 * Codex と opencode の札へ、画面の道（capture-pane -p -e で読み、キーを打つ）で答える口（boot が screenAnswer に差す）。
 * 読み手（codexDialog.ts、opencodeDialog.ts）が照合してキー列を返す。null なら何も打たない。
 * 名前のあるキーは sendKey、1 文字は sendText で打つ（tmux と psmux で同じ口）。
 */
export type AgentScreenPane = {
  captureStyled(): Promise<string | null>;
  sendKey(key: PaneKey): void;
  sendText(text: string): void;
};

const NAMED: Record<string, PaneKey> = { enter: 'enter', escape: 'escape', down: 'down', up: 'up', left: 'left', right: 'right', tab: 'tab' };

export function createAgentScreenAnswer(deps: { pane: (sessionId: string) => AgentScreenPane | null }): AgentScreenAnswer {
  return async (provider: AgentProvider, sessionId: string, ask: AgentPendingAsk, reply: AgentAskReply) => {
    const pane = deps.pane(sessionId);
    if (!pane) return 'mismatch';
    const screen = await pane.captureStyled();
    if (screen === null) return 'mismatch';
    const keys: ScreenKey[] | null = (provider === 'codex' ? codexScreenKeys : opencodeScreenKeys)(screen, ask, reply);
    if (!keys || keys.length === 0) return 'mismatch';
    for (const k of keys) {
      const named = NAMED[k];
      if (named) pane.sendKey(named);
      else pane.sendText(k);
    }
    return 'ok';
  };
}
