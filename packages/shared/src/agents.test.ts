import { describe, expect, it } from 'vitest';
import { AGENT_DISPLAY_NAME, AGENT_KINDS, AGENT_UI_CAPS, isAgentKind, type AgentKind } from './agents.ts';
import { AGENT_ICON_KINDS, AGENT_LABEL, type AgentIconKind } from './agentIcons.ts';
import { AGENT_VALUES, type AgentValue } from './launchChoices.ts';
import type { LaunchParams } from './action.ts';
import type { LiveSessionDto, SessionDto } from './api.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <T extends true>(_: T): void => {};

describe('エージェントの一覧', () => {
  it('値は今の 2 種と同じ並び（先頭が既定）', () => {
    expect([...AGENT_KINDS]).toEqual(['claude-code', 'opencode']);
    expect([...AGENT_VALUES]).toEqual([...AGENT_KINDS]);
    expect([...AGENT_ICON_KINDS]).toEqual([...AGENT_KINDS]);
    expect(AGENT_LABEL).toEqual({ 'claude-code': 'Claude Code', opencode: 'opencode' });
    expect(AGENT_DISPLAY_NAME).toEqual({ 'claude-code': 'Claude Code', opencode: 'opencode' });
  });
  it('導いた型は直書きの union と等しい', () => {
    same<Equal<AgentKind, 'claude-code' | 'opencode'>>(true);
    same<Equal<AgentValue, AgentKind>>(true);
    same<Equal<AgentIconKind, AgentKind>>(true);
    same<Equal<SessionDto['provider'], AgentKind>>(true);
    same<Equal<NonNullable<LaunchParams['agent']>, AgentKind>>(true);
    same<Equal<NonNullable<LiveSessionDto['agent']>, 'opencode'>>(true);
  });
  it('isAgentKind は一覧の値だけ通す', () => {
    expect(isAgentKind('claude-code')).toBe(true);
    expect(isAgentKind('opencode')).toBe(true);
    expect(isAgentKind('codex')).toBe(false);
    expect(isAgentKind(null)).toBe(false);
  });
  it('能力の表は全種を持つ', () => {
    expect(Object.keys(AGENT_UI_CAPS).sort()).toEqual([...AGENT_KINDS].sort());
    expect(AGENT_UI_CAPS['claude-code'].promptJump).toBe(true);
    expect(AGENT_UI_CAPS.opencode.promptJump).toBe(false);
    expect(AGENT_UI_CAPS.opencode.beta).toBe(true);
  });
});
