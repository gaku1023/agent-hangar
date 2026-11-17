import { describe, expect, it } from 'vitest';
import type { SettingsDto, TranscriptEvent } from '@agent-hangar/shared';
import { applyServerEvent, initialStore, type Store } from './store.ts';

const ev: TranscriptEvent = { kind: 'assistant', seq: 1, text: 'a' };
function withOrch(sessionId: string): Store {
  const s = initialStore();
  s.settings = { orchestrator: { enabled: true, sessionId, model: 'sonnet', effort: 'medium' } } as SettingsDto;
  s.orchestrator = { events: [ev], approvals: [], loaded: true, sending: false, keeper: { status: 'running' } };
  return s;
}
const changed = (s: Store, sessionId: string) => applyServerEvent(s, { type: 'settings.changed', settings: { ...s.settings!, orchestrator: { ...s.settings!.orchestrator!, sessionId } } as SettingsDto, keys: ['orchestrator'] });

describe('統括の柱の Store', () => {
  it('orchestrator.state で見張りの状態を置き換える', () => {
    const s = applyServerEvent(withOrch('o1'), { type: 'orchestrator.state', state: { status: 'stopped', reason: 'user' } });
    expect(s.orchestrator.keeper).toEqual({ status: 'stopped', reason: 'user' });
  });
  it('統括の会話の id が変わったら、前の会話の本文を捨てて読み直しを待つ', () => {
    const s = changed(withOrch('o1'), 'o2');
    expect(s.orchestrator.events).toEqual([]);
    expect(s.orchestrator.loaded).toBe(false);
    expect(s.orchestrator.keeper).toEqual({ status: 'running' });
  });
  it('id が同じなら本文は残す', () => {
    const s = changed(withOrch('o1'), 'o1');
    expect(s.orchestrator.events).toEqual([ev]);
  });
});
