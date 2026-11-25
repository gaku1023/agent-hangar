import { describe, expect, it } from 'vitest';
import {
  agentAskId,
  checkAnswer,
  evalWhen,
  settleAnswers,
  stepPlan,
  toPeerChatAsk,
  type AgentAskQuestion,
  type AgentPendingAsk,
} from './pendingAsk.ts';

const q = (over: Partial<AgentAskQuestion> & { id: string }): AgentAskQuestion => ({
  text: `問い ${over.id}`,
  kind: 'choice',
  options: [],
  multi: false,
  allowText: false,
  required: true,
  ...over,
});
const ask = (questions: AgentAskQuestion[], over: Partial<AgentPendingAsk> = {}): AgentPendingAsk => ({
  provider: 'codex',
  stableId: 'item-1',
  api: { requestKey: 'k', method: 'm' },
  kind: 'question',
  choices: [],
  questions,
  ...over,
});
const perm = (): AgentPendingAsk =>
  ask([], {
    kind: 'permission',
    tool: 'Bash',
    input: 'ls',
    description: 'list',
    choices: [
      { key: 'once', label: '1 回だけ', scope: 'once', description: 'この 1 回' },
      { key: 'session', label: '会話の間', scope: 'session' },
      { key: 'deny', label: '断る', scope: 'deny' },
      { key: 'cancel', label: '中止', scope: 'deny-stop' },
    ],
  });
const opts = (...k: string[]) => k.map((x) => ({ key: x, label: x.toUpperCase() }));

describe('toPeerChatAsk: permission', () => {
  it('carries choices with keys and descriptions', () => {
    const a = toPeerChatAsk(perm(), {});
    expect(a.kind).toBe('permission');
    expect(a.tool).toBe('Bash');
    expect(a.input).toBe('ls');
    expect(a.options.map((o) => o.key)).toEqual(['once', 'session', 'deny', 'cancel']);
    expect(a.options[0]!.description).toBe('この 1 回');
    expect(a.title).toBe('list');
    expect(a.step).toBeUndefined();
    expect(a.answerable).toBeUndefined();
  });
});

describe('toPeerChatAsk: questions', () => {
  const three = ask([
    q({ id: 'a', header: 'H', options: opts('x', 'y') }),
    q({ id: 'b', kind: 'text', secret: true, allowText: true, options: [] }),
    q({ id: 'c', options: opts('p', 'q'), multi: true }),
  ]);
  it('shows one question per step and submits on the last', () => {
    const s1 = toPeerChatAsk(three, {});
    expect(s1.step).toEqual({ index: 1, total: 3 });
    expect(s1.header).toBe('H');
    const s2 = toPeerChatAsk(three, { a: 'x' });
    expect(s2.step).toEqual({ index: 2, total: 3 });
    expect(s2.secret).toBe(true);
    expect(s2.allowText).toBe(true);
    const s3 = toPeerChatAsk(three, { a: 'x', b: 's' });
    expect(s3.step).toEqual({ index: 3, total: 3, submit: true });
    expect(s3.multi).toBe(true);
    expect(new Set([s1.askId, s2.askId, s3.askId]).size).toBe(3);
  });
  it('omits step for a single question', () => {
    expect(toPeerChatAsk(ask([q({ id: 'a', options: opts('x') })]), {}).step).toBeUndefined();
  });
  it('maps boolean to two choices', () => {
    const a = toPeerChatAsk(ask([q({ id: 'a', kind: 'boolean' })]), {});
    expect(a.options.map((o) => o.key)).toEqual(['true', 'false']);
  });
  it('carries number fields', () => {
    const a = toPeerChatAsk(ask([q({ id: 'a', kind: 'integer', allowText: true, min: 1, max: 5 })]), {});
    expect(a.textKind).toBe('integer');
    expect(a.min).toBe(1);
    expect(a.max).toBe(5);
    expect(toPeerChatAsk(ask([q({ id: 'a', kind: 'number', allowText: true })]), {}).textKind).toBe('number');
  });
  it('marks external as not answerable', () => {
    expect(toPeerChatAsk(ask([q({ id: 'a', kind: 'external' })]), {}).answerable).toBe(false);
  });
  it('does not mark asks without api (screen path decides)', () => {
    expect(toPeerChatAsk(ask([q({ id: 'a', options: opts('x') })], { api: null }), {}).answerable).toBeUndefined();
  });
  it('skips when-mismatched and hidden questions, counting only visible', () => {
    const a = ask([
      q({ id: 'a', options: opts('x', 'y') }),
      q({ id: 'h', hidden: true, default: 'd' }),
      q({ id: 'b', kind: 'text', allowText: true, when: [{ key: 'a', op: 'eq', value: 'x' }] }),
      q({ id: 'c', options: opts('p') }),
    ]);
    expect(stepPlan(a, {}).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(stepPlan(a, { a: 'y' }).map((x) => x.id)).toEqual(['a', 'c']);
    const s = toPeerChatAsk(a, { a: 'y' });
    expect(s.step).toEqual({ index: 2, total: 2, submit: true });
    expect(s.options.map((o) => o.key)).toEqual(['p']);
  });
});

describe('askId', () => {
  it('depends on stable id and step, not on the connection', () => {
    const a = ask([q({ id: 'a', options: opts('x') })], { api: { requestKey: '7', method: 'm' } });
    const b = ask([q({ id: 'a', options: opts('x') })], { api: { requestKey: '99', method: 'm' } });
    expect(toPeerChatAsk(a, {}).askId).toBe(toPeerChatAsk(b, {}).askId);
    expect(toPeerChatAsk(a, {}).askId).toMatch(/^[0-9a-f]{24}$/);
    expect(agentAskId('codex', 'permission', 'i', undefined)).not.toBe(agentAskId('opencode', 'permission', 'i', undefined));
    expect(agentAskId('codex', 'question', 'i', { index: 1, total: 2 })).not.toBe(agentAskId('codex', 'question', 'i', { index: 2, total: 2 }));
    expect(agentAskId('codex', 'question', 'i', { index: 2, total: 2 })).not.toBe(agentAskId('codex', 'question', 'i', { index: 2, total: 2, submit: true }));
  });
});

describe('evalWhen', () => {
  it('compares with types matched', () => {
    expect(evalWhen([{ key: 'k', op: 'eq', value: 1 }], { k: 1 })).toBe(true);
    expect(evalWhen([{ key: 'k', op: 'eq', value: 1 }], { k: '1' })).toBe(false);
    expect(evalWhen([{ key: 'k', op: 'neq', value: 1 }], { k: '1' })).toBe(true);
    expect(evalWhen([{ key: 'k', op: 'eq', value: true }], { k: true })).toBe(true);
    expect(evalWhen([{ key: 'k', op: 'eq', value: 'a' }], {})).toBe(false);
    expect(evalWhen([{ key: 'k', op: 'neq', value: 'a' }], {})).toBe(true);
    expect(evalWhen([{ key: 'k', op: 'eq', value: ['a', 'b'] }], { k: ['b', 'a'] })).toBe(true);
  });
  it('requires all conditions', () => {
    expect(evalWhen([{ key: 'a', op: 'eq', value: 1 }, { key: 'b', op: 'eq', value: 2 }], { a: 1, b: 3 })).toBe(false);
    expect(evalWhen(undefined, {})).toBe(true);
  });
});

describe('settleAnswers', () => {
  it('fills defaults for hidden and skipped questions', () => {
    const a = ask([
      q({ id: 'a', options: opts('x', 'y') }),
      q({ id: 'h', hidden: true, default: 7, kind: 'number' }),
      q({ id: 'b', kind: 'text', allowText: true, default: 'dflt', when: [{ key: 'a', op: 'eq', value: 'x' }] }),
    ]);
    expect(settleAnswers(a, { a: 'y' })).toEqual({ a: 'y', h: 7, b: 'dflt' });
    expect(settleAnswers(a, { a: 'x', b: 'mine' })).toEqual({ a: 'x', h: 7, b: 'mine' });
  });
  it('leaves skipped questions without default out', () => {
    const a = ask([q({ id: 'a', options: opts('x') }), q({ id: 'b', kind: 'text', allowText: true, when: [{ key: 'a', op: 'eq', value: 'z' }] })]);
    expect(settleAnswers(a, { a: 'x' })).toEqual({ a: 'x' });
  });
});

describe('checkAnswer', () => {
  const bad = { ok: false, reason: 'ask-mismatch' };
  it('choice: key must exist, text only when allowed', () => {
    const c = q({ id: 'a', options: opts('x', 'y') });
    expect(checkAnswer(c, ['x'])).toEqual({ ok: true, value: 'x' });
    expect(checkAnswer(c, ['z'])).toEqual(bad);
    expect(checkAnswer(c, ['x', 'y'])).toEqual(bad);
    expect(checkAnswer(c, [], 'free')).toEqual(bad);
    expect(checkAnswer({ ...c, allowText: true }, [], 'free')).toEqual({ ok: true, value: 'free' });
    expect(checkAnswer(c, [])).toEqual(bad);
    expect(checkAnswer({ ...c, required: false }, [])).toEqual({ ok: true, value: undefined });
  });
  it('multi: minItems and maxItems', () => {
    const c = q({ id: 'a', options: opts('x', 'y', 'z'), multi: true, minItems: 1, maxItems: 2 });
    expect(checkAnswer(c, ['x', 'y'])).toEqual({ ok: true, value: ['x', 'y'] });
    expect(checkAnswer(c, [])).toEqual(bad);
    expect(checkAnswer(c, ['x', 'y', 'z'])).toEqual(bad);
    expect(checkAnswer(c, ['x', 'x'])).toEqual(bad);
    expect(checkAnswer(c, ['q'])).toEqual(bad);
  });
  it('number and integer: range and integrality', () => {
    const n = q({ id: 'a', kind: 'number', allowText: true, min: 0, max: 10 });
    expect(checkAnswer(n, [], '2.5')).toEqual({ ok: true, value: 2.5 });
    expect(checkAnswer(n, [], '11')).toEqual(bad);
    expect(checkAnswer(n, [], '-1')).toEqual(bad);
    expect(checkAnswer(n, [], 'abc')).toEqual(bad);
    expect(checkAnswer(n, [], '')).toEqual(bad);
    expect(checkAnswer(n, [], 'Infinity')).toEqual(bad);
    const i = q({ id: 'a', kind: 'integer', allowText: true });
    expect(checkAnswer(i, [], '3')).toEqual({ ok: true, value: 3 });
    expect(checkAnswer(i, [], '3.5')).toEqual(bad);
  });
  it('boolean: true or false key', () => {
    const b = q({ id: 'a', kind: 'boolean' });
    expect(checkAnswer(b, ['true'])).toEqual({ ok: true, value: true });
    expect(checkAnswer(b, ['false'])).toEqual({ ok: true, value: false });
    expect(checkAnswer(b, ['maybe'])).toEqual(bad);
  });
  it('text: required means non-empty; external never answerable', () => {
    const t = q({ id: 'a', kind: 'text', allowText: true });
    expect(checkAnswer(t, [], 'hi')).toEqual({ ok: true, value: 'hi' });
    expect(checkAnswer(t, [], '')).toEqual(bad);
    expect(checkAnswer(q({ id: 'a', kind: 'external' }), ['x'])).toEqual(bad);
  });
});
