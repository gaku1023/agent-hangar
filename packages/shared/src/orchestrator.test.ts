import { describe, expect, it } from 'vitest';
import { DEFAULT_ORCHESTRATOR, isOrchestratorPatch, orchestratorOf } from './orchestrator.ts';

describe('orchestratorOf', () => {
  it('無い値は、切で、Sonnet と medium の既定に寄せる', () => {
    expect(orchestratorOf(undefined)).toEqual({ enabled: false, sessionId: null, model: 'sonnet', effort: 'medium' });
    expect(orchestratorOf(null)).toEqual(DEFAULT_ORCHESTRATOR);
    expect(orchestratorOf('x')).toEqual(DEFAULT_ORCHESTRATOR);
  });
  it('正しい項目はそのまま通し、取れない項目だけ既定に戻す', () => {
    expect(orchestratorOf({ enabled: true, sessionId: 's1', model: 'opus', effort: 'low' })).toEqual({ enabled: true, sessionId: 's1', model: 'opus', effort: 'low' });
    expect(orchestratorOf({ enabled: 'yes', sessionId: 5, model: '--evil', effort: 'turbo' })).toEqual(DEFAULT_ORCHESTRATOR);
    expect(orchestratorOf({ enabled: true, sessionId: '' })).toEqual({ ...DEFAULT_ORCHESTRATOR, enabled: true });
  });
});

describe('isOrchestratorPatch', () => {
  it('入り切り、モデル、effort だけを受ける', () => {
    expect(isOrchestratorPatch({ enabled: true })).toBe(true);
    expect(isOrchestratorPatch({ model: 'haiku', effort: 'medium' })).toBe(true);
  });
  it('会話の id は受けない（見張りだけが書く）。形の違う値と知らない鍵、空は断る', () => {
    expect(isOrchestratorPatch({ sessionId: 's1' })).toBe(false);
    expect(isOrchestratorPatch({ enabled: 1 })).toBe(false);
    expect(isOrchestratorPatch({ model: '-x' })).toBe(false);
    expect(isOrchestratorPatch({ effort: 'turbo' })).toBe(false);
    expect(isOrchestratorPatch({ extra: true })).toBe(false);
    expect(isOrchestratorPatch({})).toBe(false);
    expect(isOrchestratorPatch(null)).toBe(false);
  });
});
