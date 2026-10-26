import { describe, expect, it } from 'vitest';
import { AGENT_KINDS } from '@agent-hangar/shared';
import { AGENT_ENTRY, agentSettingsKeys } from './entry.ts';

describe('AGENT_ENTRY', () => {
  it('has a row for every agent kind', () => {
    for (const k of AGENT_KINDS) expect(AGENT_ENTRY[k]).toBeDefined();
  });

  it('claude-code is always enabled and has no intercept or separate binary', () => {
    const e = AGENT_ENTRY['claude-code'];
    expect(e.enabled({})).toBe(true);
    expect(e.intercept({ opencodeIntercept: true })).toBe(false);
    expect(e.bin()).toBeNull();
  });

  it('opencode follows opencodeEnabled and opencodeIntercept', () => {
    const e = AGENT_ENTRY.opencode;
    expect(e.enabled({})).toBe(false);
    expect(e.enabled({ opencodeEnabled: true })).toBe(true);
    expect(e.intercept({ opencodeIntercept: true })).toBe(true);
    expect(e.intercept({})).toBe(false);
    expect(e.enabledLabelKey).toBe('settings.label.opencodeEnabled');
    expect(e.interceptLabelKey).toBe('settings.label.opencodeIntercept');
  });

  it('codex follows codexEnabled and codexIntercept, and is off by default', () => {
    const e = AGENT_ENTRY.codex;
    expect(e.enabled({})).toBe(false);
    expect(e.enabled({ opencodeEnabled: true })).toBe(false);
    expect(e.enabled({ codexEnabled: true })).toBe(true);
    expect(e.intercept({})).toBe(false);
    expect(e.intercept({ codexIntercept: true })).toBe(true);
    expect(e.enabledLabelKey).toBe('settings.label.codexEnabled');
    expect(e.interceptLabelKey).toBe('settings.label.codexIntercept');
    expect(agentSettingsKeys('enabled')).toContain('codexEnabled');
    expect(agentSettingsKeys('shell')).toEqual(expect.arrayContaining(['codexEnabled', 'codexIntercept']));
  });

  it('lists the settings keys that change an agent', () => {
    expect(agentSettingsKeys('enabled')).toContain('opencodeEnabled');
    expect(agentSettingsKeys('shell')).toEqual(expect.arrayContaining(['opencodeEnabled', 'opencodeIntercept']));
  });
});
