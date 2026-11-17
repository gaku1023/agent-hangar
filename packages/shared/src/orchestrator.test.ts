import { describe, expect, it } from 'vitest';
import { DEFAULT_ORCHESTRATOR, isOrchestratorEffort, isOrchestratorOrigin, isOrchestratorPatch, markOrchestratorText, ORCHESTRATOR_HISTORY_MAX, ORCHESTRATOR_ORIGINS, orchestratorLineage, orchestratorOf, pushOrchestratorHistory } from './orchestrator.ts';

describe('orchestratorOf', () => {
  it('無い値は、切で、Sonnet と medium の既定に寄せる', () => {
    expect(orchestratorOf(undefined)).toEqual({ enabled: false, sessionId: null, agent: 'claude-code', model: 'sonnet', effort: 'medium', account: null, history: [] });
    expect(orchestratorOf(null)).toEqual(DEFAULT_ORCHESTRATOR);
    expect(orchestratorOf('x')).toEqual(DEFAULT_ORCHESTRATOR);
  });
  it('正しい項目はそのまま通し、取れない項目だけ既定に戻す', () => {
    expect(orchestratorOf({ enabled: true, sessionId: 's1', model: 'opus', effort: 'low', account: 'acc-2' })).toEqual({ enabled: true, sessionId: 's1', model: 'opus', effort: 'low', account: 'acc-2', agent: 'claude-code', history: [] });
    expect(orchestratorOf({ enabled: 'yes', sessionId: 5, model: '--evil', effort: 'turbo' })).toEqual(DEFAULT_ORCHESTRATOR);
    expect(orchestratorOf({ enabled: true, sessionId: '' })).toEqual({ ...DEFAULT_ORCHESTRATOR, enabled: true });
  });
});

describe('orchestratorOf account', () => {
  it('空でない文字列だけを受け、それ以外は null', () => {
    expect(orchestratorOf({ account: 'acc-2' }).account).toBe('acc-2');
    for (const v of ['', 5, null, undefined, {}]) expect(orchestratorOf({ account: v }).account).toBeNull();
  });
});

describe('orchestrator agent と空の model', () => {
  it('agent は知っているアプリだけ通し、知らない値は Claude Code に戻す', () => {
    expect(orchestratorOf({ agent: 'codex' }).agent).toBe('codex');
    for (const v of ['gemini', '', 5, null, undefined]) expect(orchestratorOf({ agent: v }).agent).toBe('claude-code');
  });
  it('model の空はそのアプリの既定として残す', () => {
    expect(orchestratorOf({ model: '' }).model).toBe('');
    expect(orchestratorOf({}).model).toBe('sonnet');
  });
  it('Codex の effort は語の形だけ、Claude Code は決まった段階だけ読む', () => {
    expect(orchestratorOf({ agent: 'codex', effort: 'minimal' }).effort).toBe('minimal');
    expect(orchestratorOf({ agent: 'codex', effort: '--x' }).effort).toBe('medium');
    expect(orchestratorOf({ agent: 'claude-code', effort: 'minimal' }).effort).toBe('medium');
    expect(isOrchestratorPatch({ effort: 'minimal' })).toBe(true);
  });
  it('opencode には effort が無く、空だけを読む（ほかの値は空に戻す）', () => {
    expect(isOrchestratorEffort('opencode', '')).toBe(true);
    expect(isOrchestratorEffort('opencode', 'high')).toBe(false);
    expect(orchestratorOf({ agent: 'opencode', effort: 'medium' }).effort).toBe('');
    expect(orchestratorOf({ agent: 'opencode', effort: '' }).effort).toBe('');
  });
  it('PATCH は agent と空の model を受ける', () => {
    expect(isOrchestratorPatch({ agent: 'codex', model: '', effort: '', account: null })).toBe(true);
    expect(isOrchestratorPatch({ agent: 'gemini' })).toBe(false);
    expect(isOrchestratorPatch({ agent: 3 })).toBe(false);
  });
});

describe('isOrchestratorPatch', () => {
  it('入り切り、モデル、effort だけを受ける', () => {
    expect(isOrchestratorPatch({ enabled: true })).toBe(true);
    expect(isOrchestratorPatch({ model: 'haiku', effort: 'medium' })).toBe(true);
  });
  it('会話の id は受けない（見張りだけが書く）。形の違う値と知らない鍵、空は断る', () => {
    expect(isOrchestratorPatch({ account: 'acc-2' })).toBe(true);
    expect(isOrchestratorPatch({ account: null })).toBe(true);
    expect(isOrchestratorPatch({ account: '' })).toBe(false);
    expect(isOrchestratorPatch({ account: 3 })).toBe(false);
    expect(isOrchestratorPatch({ sessionId: 's1' })).toBe(false);
    expect(isOrchestratorPatch({ history: [] })).toBe(false);
    expect(isOrchestratorPatch({ enabled: 1 })).toBe(false);
    expect(isOrchestratorPatch({ model: '-x' })).toBe(false);
    expect(isOrchestratorPatch({ effort: 3 })).toBe(false);
    expect(isOrchestratorPatch({ effort: '--x' })).toBe(false);
    expect(isOrchestratorPatch({ extra: true })).toBe(false);
    expect(isOrchestratorPatch({})).toBe(false);
    expect(isOrchestratorPatch(null)).toBe(false);
  });
});

describe('統括へ送る文の由来と印', () => {
  it('強い声は [voice]、弱い声は [voice:window] を付け、打鍵は付けない', () => {
    expect(markOrchestratorText('進み具合は', 'typed')).toBe('進み具合は');
    for (const o of ['voice-held', 'voice-called', 'voice-toggle-first'] as const) expect(markOrchestratorText('進み具合は', o)).toBe('[voice] 進み具合は');
    for (const o of ['voice-window', 'voice-toggle-rest'] as const) expect(markOrchestratorText('進み具合は', o)).toBe('[voice:window] 進み具合は');
  });
  it('本文の頭の [hangar] と [voice…] の印は、重なっていても剥がしてから付ける', () => {
    expect(markOrchestratorText('[hangar] 出来事 1 件', 'typed')).toBe('出来事 1 件');
    expect(markOrchestratorText('  [voice] [hangar]  [voice:window] 許可して', 'voice-window')).toBe('[voice:window] 許可して');
    expect(markOrchestratorText('[VOICE:x]止めて', 'voice-held')).toBe('[voice] 止めて');
    expect(markOrchestratorText('[voice]', 'typed')).toBe('');
    // 頭にない印は本文として残す。
    expect(markOrchestratorText('ログに [hangar] とある', 'typed')).toBe('ログに [hangar] とある');
  });
  it('知らない由来は由来と認めない', () => {
    expect(ORCHESTRATOR_ORIGINS).toEqual(['typed', 'voice-held', 'voice-called', 'voice-toggle-first', 'voice-window', 'voice-toggle-rest']);
    expect(isOrchestratorOrigin('voice-held')).toBe(true);
    expect(isOrchestratorOrigin('voice')).toBe(false);
    expect(isOrchestratorOrigin(undefined)).toBe(false);
  });
});

describe('統括の系譜（history）', () => {
  const e = (id: string, reason = 'fresh') => ({ sessionId: id, startedAt: 1, endedAt: 2, reason });
  it('形の正しい項目だけを読み、知らない reason と壊れた項目は捨てる', () => {
    const o = orchestratorOf({ history: [e('a'), e('b', 'auto'), e('c', 'agent'), e('d', 'gone'), e('x', 'nope'), { sessionId: '' }, 5, null] });
    expect(o.history.map((h) => h.sessionId)).toEqual(['a', 'b', 'c', 'd']);
    expect(orchestratorOf({ history: 'x' }).history).toEqual([]);
    expect(orchestratorOf({ history: [{ sessionId: 'a', startedAt: null, endedAt: 3, reason: 'fresh' }] }).history).toEqual([{ sessionId: 'a', startedAt: null, endedAt: 3, reason: 'fresh' }]);
  });
  it('読むときも上限の 20 件に切り、新しい方を残す', () => {
    const many = Array.from({ length: 25 }, (_, i) => e(`s${i}`));
    const h = orchestratorOf({ history: many }).history;
    expect(h).toHaveLength(ORCHESTRATOR_HISTORY_MAX);
    expect(h[0]!.sessionId).toBe('s5');
    expect(h.at(-1)!.sessionId).toBe('s24');
  });
  it('足すと末尾に積み、21 件目で最古が落ちる', () => {
    let h: ReturnType<typeof orchestratorOf>['history'] = [];
    for (let i = 0; i < 21; i++) h = pushOrchestratorHistory(h, { sessionId: `s${i}`, startedAt: i, endedAt: i + 1, reason: 'fresh' });
    expect(h).toHaveLength(20);
    expect(h[0]!.sessionId).toBe('s1');
    expect(h.at(-1)!.sessionId).toBe('s20');
  });
  it('系譜の id は今の会話と過去の会話（重なりなし）', () => {
    expect(orchestratorLineage(orchestratorOf({ sessionId: 'now', history: [e('a'), e('b'), e('now')] }))).toEqual(['now', 'a', 'b']);
    expect(orchestratorLineage(orchestratorOf({}))).toEqual([]);
  });
});
