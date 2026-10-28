import { describe, expect, it } from 'vitest';
import { en } from './en.ts';
import { ja } from './ja.ts';

/*
 * opencode の文の英語（ベータ 1 の終わりの文面の直し、2026-10-25）。
 * Gemini に 2 回当てて決めた英語を見張る。日本語は変えない（です・ます調のまま）。
 */
const DECIDED: Record<string, string> = {
  'settings.opencode.enabledDesc': 'Let new sessions use opencode.',
  'settings.label.opencodeIntercept': 'Launch the opencode command through hangar',
  'settings.opencode.intercept.desc': 'Running opencode in your shell starts it as a hangar session. When hangar is not running, plain opencode starts. To run once without wrapping, use command opencode.',
  'settings.opencode.version.unverifiedNote': 'This version is unverified. API changes may cause status and permission checks to display incorrectly.',
  'settings.opencode.injection.claudeNote': 'Some models may confirm status proposals without asking you.',
  'toasts.opencodeVersion.body': 'Verified: {range}. API changes may cause status and permission checks to display incorrectly.',
  'launch.opencode.loading': 'Loading the list from opencode…',
  'launch.opencode.failed': 'Could not load the list from opencode.',
  'launch.opencode.modelReset': 'The previous model {model} is no longer listed; reverted to the default.',
  'launch.autoApprove.onNote': 'Allow all except deny',
  'launch.model.search': 'Filter by model name (e.g., qwen, glm)',
  'system.opencode.disabled': 'opencode is disabled.',
  'run.agent.disabled': 'opencode is disabled. Turn on "{label}" in Settings',
  'system.opencode.providers.modelsUnreachable': 'Failed to load models from /v1/models. Check the URL and API key.',
  'session.strip.opencode.intentMeta': 'Written by opencode, {time}, {n} subsequent tool {n|call|calls}',
  'session.ended.opencode': 'opencode has exited. Use "{action}" to resume.',
  'session.ended.codex': 'Codex has exited. Use "{action}" to resume.',
  'session.ended.codex.pending': 'This conversation has no first message yet, so it cannot be resumed.',
  'run.agent.codex.loggedOut': 'You are not logged in to codex (run codex login in a terminal)',
};

describe('opencode の文の英語', () => {
  it.each(Object.entries(DECIDED))('%s は決めた英語', (key, text) => {
    expect((en as Record<string, string>)[key]).toBe(text);
  });
  it('日本語は残してある（同じ鍵がある）', () => {
    for (const key of Object.keys(DECIDED)) expect((ja as Record<string, string>)[key]).toBeTruthy();
  });
});
