import { describe, expect, it } from 'vitest';
import type { AgentPendingAsk } from '../../agent/pendingAsk.ts';
import { createAgentScreenAnswer, type AgentScreenPane } from './agentScreen.ts';
import { CODEX_EXEC_ASK } from './dialogs.codex.fixtures.ts';
import { OPENCODE_PERM_ASK } from './dialogs.opencode.fixtures.ts';

const CHOICES = [
  { key: 'once', label: 'once', scope: 'once' as const },
  { key: 'deny-stop', label: 'cancel', scope: 'deny-stop' as const },
];
const codexAsk: AgentPendingAsk = { provider: 'codex', stableId: 'x', api: null, kind: 'permission', tool: 'Bash', input: 'echo hi > a.txt', choices: CHOICES, questions: [] };
const wrongAsk: AgentPendingAsk = { ...codexAsk, input: 'rm -rf /' };

function fake(screen: string | null) {
  const sent: string[] = [];
  const pane: AgentScreenPane = {
    captureStyled: async () => screen,
    sendKey: (k) => { sent.push(`key:${k}`); },
    sendText: (t) => { sent.push(`text:${t}`); },
  };
  return { sent, answer: createAgentScreenAnswer({ pane: (id) => (id === 's1' ? pane : null) }) };
}

describe('createAgentScreenAnswer', () => {
  it('Codex の札に合えば、1 文字のキーは sendText で打つ', async () => {
    const f = fake(CODEX_EXEC_ASK);
    expect(await f.answer('codex', 's1', codexAsk, { kind: 'permission', choice: 'once' })).toBe('ok');
    expect(f.sent).toEqual(['text:y']);
  });
  it('名前のあるキーは sendKey で打つ', async () => {
    const f = fake(CODEX_EXEC_ASK);
    expect(await f.answer('codex', 's1', codexAsk, { kind: 'permission', choice: 'deny-stop' })).toBe('ok');
    expect(f.sent).toEqual(['key:escape']);
  });
  it('照合が外れたら何も打たず mismatch', async () => {
    const f = fake(CODEX_EXEC_ASK);
    expect(await f.answer('codex', 's1', wrongAsk, { kind: 'permission', choice: 'once' })).toBe('mismatch');
    expect(f.sent).toEqual([]);
  });
  it('画面が読めない、画面が無いときは mismatch', async () => {
    const a = fake(null);
    expect(await a.answer('codex', 's1', codexAsk, { kind: 'permission', choice: 'once' })).toBe('mismatch');
    expect(await a.answer('codex', 'none', codexAsk, { kind: 'permission', choice: 'once' })).toBe('mismatch');
    expect(a.sent).toEqual([]);
  });
  it('opencode は opencode の読み手で照合し、右キーも打つ', async () => {
    const oc: AgentPendingAsk = { ...codexAsk, provider: 'opencode', tool: 'shell' };
    const f = fake(OPENCODE_PERM_ASK);
    expect(await f.answer('opencode', 's1', oc, { kind: 'permission', choice: 'session' })).toBe('ok');
    expect(f.sent).toEqual(['key:right', 'key:enter']);
    const g = fake(OPENCODE_PERM_ASK);
    expect(await g.answer('opencode', 's1', { ...oc, input: 'rm -rf /' }, { kind: 'permission', choice: 'once' })).toBe('mismatch');
    expect(g.sent).toEqual([]);
  });
});
