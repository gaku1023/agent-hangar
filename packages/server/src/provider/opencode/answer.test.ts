import { describe, expect, it } from 'vitest';
import { checkAnswer, currentQuestion, settleAnswers, stepPlan, toPeerChatAsk, type AgentPendingAsk } from '../../agent/pendingAsk.ts';
import type { OpencodeForm, OpencodeFormField, OpencodePermissionRequest } from './client.ts';
import { createOpencodeAskPort, OPENCODE_PERMISSION_CHOICES, type OpencodeAskClient } from './answer.ts';

type Calls = { kind: 'permission' | 'form'; sid: string; id: string; payload: unknown; message?: string }[];
function setup(o: { perms?: OpencodePermissionRequest[]; forms?: OpencodeForm[]; result?: 'ok' | 'gone' | 'unreachable' } = {}) {
  const calls: Calls = [];
  const client: OpencodeAskClient = {
    async replyPermission(sid, id, decision, message) { calls.push({ kind: 'permission', sid, id, payload: decision, ...(message !== undefined ? { message } : {}) }); return o.result ?? 'ok'; },
    async replyForm(sid, id, answer) { calls.push({ kind: 'form', sid, id, payload: answer }); return o.result ?? 'ok'; },
  };
  const port = createOpencodeAskPort({ pending: (sessionId) => (sessionId === 'ses_1' ? { client, perms: o.perms ?? [], forms: o.forms ?? [] } : null) });
  return { port, calls };
}
const perm = (over: Partial<OpencodePermissionRequest> = {}): OpencodePermissionRequest => ({ id: 'per_1', sessionID: 'ses_sub', action: 'shell', resources: ['rm -rf x', 'ls'], ...over });
const form = (fields: OpencodeFormField[], over: Partial<OpencodeForm> = {}): OpencodeForm => ({ id: 'frm_1', sessionID: 'ses_sub', title: '確認', fields, ...over });
const must = (a: AgentPendingAsk | null): AgentPendingAsk => { expect(a).not.toBeNull(); return a!; };

describe('opencode の許可', () => {
  it('3 つの選択肢（once・session・deny）に直す。stableId は permission id', () => {
    const { port } = setup({ perms: [perm({ message: '消すよ' })] });
    const a = must(port.current('ses_1'));
    expect(a).toMatchObject({ provider: 'opencode', stableId: 'per_1', kind: 'permission', tool: 'shell', input: 'rm -rf x\nls', description: '消すよ' });
    expect(a.api).not.toBeNull();
    expect(a.choices.map((c) => [c.key, c.scope])).toEqual([['once', 'once'], ['session', 'session'], ['deny', 'deny']]);
    expect(a.choices).toEqual(OPENCODE_PERMISSION_CHOICES);
    expect(a.choices.every((c) => c.label && c.description)).toBe(true);
    expect(toPeerChatAsk(a, {}).options.map((o) => o.key)).toEqual(['once', 'session', 'deny']);
  });

  it('会話に札が無ければ null', () => {
    expect(setup().port.current('ses_1')).toBeNull();
    expect(setup({ perms: [perm()] }).port.current('ses_other')).toBeNull();
  });

  it('once・session・deny は once・always・reject で、要求の sessionID に送る', async () => {
    for (const [scope, decision] of [['once', 'once'], ['session', 'always'], ['deny', 'reject']] as const) {
      const { port, calls } = setup({ perms: [perm()] });
      expect(await port.answer('ses_1', must(port.current('ses_1')), { kind: 'permission', choice: scope })).toBe('ok');
      expect(calls).toEqual([{ kind: 'permission', sid: 'ses_sub', id: 'per_1', payload: decision }]);
    }
  });

  it('断りの message を渡す', async () => {
    const { port, calls } = setup({ perms: [perm()] });
    await port.answer('ses_1', must(port.current('ses_1')), { kind: 'permission', choice: 'deny', message: 'だめ' });
    expect(calls[0]?.message).toBe('だめ');
  });

  it.each(['ok', 'gone', 'unreachable'] as const)('返りの %s をそのまま返す', async (r) => {
    const { port } = setup({ perms: [perm()], result: r });
    expect(await port.answer('ses_1', must(port.current('ses_1')), { kind: 'permission', choice: 'once' })).toBe(r);
  });

  it('もう無い札には送らず gone', async () => {
    const { port, calls } = setup({ perms: [] });
    const a: AgentPendingAsk = { provider: 'opencode', stableId: 'per_9', api: { requestKey: 'per_9', method: 'POST' }, kind: 'permission', choices: OPENCODE_PERMISSION_CHOICES, questions: [] };
    expect(await port.answer('ses_1', a, { kind: 'permission', choice: 'once' })).toBe('gone');
    expect(calls).toEqual([]);
  });

  it('許可が先、form は後に見せる', () => {
    const { port } = setup({ perms: [perm()], forms: [form([{ key: 'q0', type: 'string' }])] });
    expect(port.current('ses_1')?.kind).toBe('permission');
  });
});

describe('opencode の form', () => {
  const ask = (fields: OpencodeFormField[], over: Partial<OpencodeForm> = {}) => { const { port, calls } = setup({ forms: [form(fields, over)] }); return { port, calls, a: must(port.current('ses_1')) }; };

  it('question の道具の form（options 付き string）は単一選択。説明が問いの文、title が header', () => {
    const { a } = ask([{ key: 'q0', type: 'string', title: 'Color', description: 'Which?', options: [{ value: 'Red', label: 'Red', description: 'warm' }, { value: 'Blue', label: 'Blue' }] }], { metadata: { kind: 'question' } });
    expect(a).toMatchObject({ kind: 'question', stableId: 'frm_1' });
    const q = a.questions[0]!;
    expect(q).toMatchObject({ id: 'q0', kind: 'choice', multi: false, allowText: false, required: true, header: 'Color', text: 'Which?' });
    expect(q.options).toEqual([{ key: 'Red', label: 'Red', description: 'warm' }, { key: 'Blue', label: 'Blue' }]);
  });

  it('custom: true の options 付き string は自由記述も受ける', async () => {
    const { a, port, calls } = ask([{ key: 'q0', type: 'string', options: [{ value: 'A', label: 'A' }], custom: true }]);
    expect(a.questions[0]).toMatchObject({ kind: 'choice', allowText: true });
    const c = checkAnswer(a.questions[0]!, [], '自分の答え');
    expect(c).toEqual({ ok: true, value: '自分の答え' });
    await port.answer('ses_1', a, { kind: 'question', answers: { q0: '自分の答え' } });
    expect(calls[0]).toEqual({ kind: 'form', sid: 'ses_sub', id: 'frm_1', payload: { q0: '自分の答え' } });
  });

  it('options の無い string は text', async () => {
    const { a, port, calls } = ask([{ key: 'name', type: 'string', title: '名前' }]);
    expect(a.questions[0]).toMatchObject({ kind: 'text', allowText: true, required: false, text: '名前' });
    await port.answer('ses_1', a, { kind: 'question', answers: { name: 'abc' } });
    expect(calls[0]?.payload).toEqual({ name: 'abc' });
  });

  it('number と integer は allowText の数の欄で、min・max を持つ。送るのは数', async () => {
    const { a, port, calls } = ask([{ key: 'n', type: 'number', min: 0.5, max: 2 }, { key: 'i', type: 'integer', min: 1, max: 9 }]);
    expect(a.questions.map((q) => [q.kind, q.allowText, q.min, q.max])).toEqual([['number', true, 0.5, 2], ['integer', true, 1, 9]]);
    expect(checkAnswer(a.questions[1]!, [], '2.5')).toMatchObject({ ok: false });
    expect(checkAnswer(a.questions[1]!, [], '10')).toMatchObject({ ok: false });
    const v = checkAnswer(a.questions[1]!, [], '5');
    expect(v).toEqual({ ok: true, value: 5 });
    await port.answer('ses_1', a, { kind: 'question', answers: { n: 1.5, i: 5 } });
    expect(calls[0]?.payload).toEqual({ n: 1.5, i: 5 });
    // 文字で貯まっていても数に直す
    await port.answer('ses_1', a, { kind: 'question', answers: { n: '1.5', i: '5' } });
    expect(calls[1]?.payload).toEqual({ n: 1.5, i: 5 });
  });

  it('boolean は options 空で、true・false の選択肢で見せ、boolean を送る', async () => {
    const { a, port, calls } = ask([{ key: 'ok', type: 'boolean', title: '進める？' }]);
    const q = a.questions[0]!;
    expect(q).toMatchObject({ kind: 'boolean', options: [], multi: false });
    expect(toPeerChatAsk(a, {}).options.map((o) => o.key)).toEqual(['true', 'false']);
    expect(checkAnswer(q, ['false'])).toEqual({ ok: true, value: false });
    await port.answer('ses_1', a, { kind: 'question', answers: { ok: false } });
    expect(calls[0]?.payload).toEqual({ ok: false });
    await port.answer('ses_1', a, { kind: 'question', answers: { ok: 'true' } });
    expect(calls[1]?.payload).toEqual({ ok: true });
  });

  it('multiselect は複数選択で、minItems・maxItems を守り、配列を送る', async () => {
    const { a, port, calls } = ask([{ key: 'm', type: 'multiselect', required: true, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }], minItems: 1, maxItems: 2 }]);
    const q = a.questions[0]!;
    expect(q).toMatchObject({ kind: 'choice', multi: true, minItems: 1, maxItems: 2, allowText: false });
    expect(checkAnswer(q, [])).toMatchObject({ ok: false });
    expect(checkAnswer(q, ['a', 'b', 'c'])).toMatchObject({ ok: false });
    expect(checkAnswer(q, ['a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] });
    await port.answer('ses_1', a, { kind: 'question', answers: { m: ['a', 'b'] } });
    expect(calls[0]?.payload).toEqual({ m: ['a', 'b'] });
  });

  it('when（eq・neq）は問いに写り、貯めた答えで見せる問いが決まる。飛ばした問いは送らない', async () => {
    const { a, port, calls } = ask([
      { key: 'kind', type: 'string', required: true, options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] },
      { key: 'onlyX', type: 'string', when: [{ key: 'kind', op: 'eq', value: 'x' }] },
      { key: 'notX', type: 'string', when: [{ key: 'kind', op: 'neq', value: 'x' }] },
    ]);
    expect(a.questions[1]!.when).toEqual([{ key: 'kind', op: 'eq', value: 'x' }]);
    expect(a.questions[2]!.when).toEqual([{ key: 'kind', op: 'neq', value: 'x' }]);
    expect(stepPlan(a, { kind: 'x' }).map((q) => q.id)).toEqual(['kind', 'onlyX']);
    expect(stepPlan(a, { kind: 'y' }).map((q) => q.id)).toEqual(['kind', 'notX']);
    expect(currentQuestion(a, { kind: 'y' })?.question.id).toBe('notX');
    await port.answer('ses_1', a, { kind: 'question', answers: settleAnswers(a, { kind: 'y', onlyX: '捨てる', notX: 'ok' }) });
    expect(calls[0]?.payload).toEqual({ kind: 'y', notX: 'ok' });
  });

  it('when の値は数と真偽もそのまま写し、型を合わせて比べる', () => {
    const { a } = ask([
      { key: 'n', type: 'integer' },
      { key: 'b', type: 'boolean' },
      { key: 'p', type: 'string', when: [{ key: 'n', op: 'eq', value: 3 }, { key: 'b', op: 'eq', value: true }] },
    ]);
    expect(stepPlan(a, { n: 3, b: true }).map((q) => q.id)).toEqual(['n', 'b', 'p']);
    expect(stepPlan(a, { n: 3, b: false }).map((q) => q.id)).toEqual(['n', 'b']);
    expect(stepPlan(a, { n: '3', b: true }).map((q) => q.id)).toEqual(['n', 'b']);
  });

  it('hidden は飛ばして default を送る。default の無い hidden は送らない', async () => {
    const { a, port, calls } = ask([
      { key: 'vis', type: 'string', required: true },
      { key: 'h1', type: 'string', hidden: true, default: 'secret' },
      { key: 'h2', type: 'integer', hidden: true },
    ]);
    expect(a.questions[1]).toMatchObject({ hidden: true, default: 'secret' });
    expect(stepPlan(a, {}).map((q) => q.id)).toEqual(['vis']);
    await port.answer('ses_1', a, { kind: 'question', answers: settleAnswers(a, { vis: 'v' }) });
    expect(calls[0]?.payload).toEqual({ vis: 'v', h1: 'secret' });
  });

  it('answer の中で settleAnswers を通すので、貯めた生の答えでも hidden の default が入る', async () => {
    const { a, port, calls } = ask([{ key: 'vis', type: 'string' }, { key: 'h1', type: 'string', hidden: true, default: 'd' }]);
    await port.answer('ses_1', a, { kind: 'question', answers: { vis: 'v' } });
    expect(calls[0]?.payload).toEqual({ vis: 'v', h1: 'd' });
  });

  it('欄の default と required・minItems の無い multiselect は required なし', () => {
    const { a } = ask([{ key: 'm', type: 'multiselect', options: [{ value: 'a', label: 'A' }], default: ['a'] }]);
    expect(a.questions[0]).toMatchObject({ required: false, default: ['a'] });
  });

  it('external の欄は answerable: false で、送らない', async () => {
    const { a, port, calls } = ask([{ key: 'auth', type: 'external', url: 'https://example.test/login', title: 'ログイン' }]);
    expect(a.questions[0]).toMatchObject({ kind: 'external' });
    expect(toPeerChatAsk(a, {}).answerable).toBe(false);
    expect(await port.answer('ses_1', a, { kind: 'question', answers: {} })).toBe('unreachable');
    expect(calls).toEqual([]);
  });

  it('type の無い古い欄（2.1.4）は string の text', () => {
    const { a } = ask([{ key: 'q0', title: 'T', description: 'D' }]);
    expect(a.questions[0]).toMatchObject({ kind: 'text', text: 'D' });
  });

  it('答えの返りの 204・409・404・つながらないを ok・gone・gone・unreachable にする', async () => {
    for (const r of ['ok', 'gone', 'unreachable'] as const) {
      const { port } = setup({ forms: [form([{ key: 'q0', type: 'string' }])], result: r });
      expect(await port.answer('ses_1', must(port.current('ses_1')), { kind: 'question', answers: { q0: 'x' } })).toBe(r);
    }
  });

  it('もう無い form には送らず gone', async () => {
    const { port, calls } = setup();
    const a: AgentPendingAsk = { provider: 'opencode', stableId: 'frm_9', api: { requestKey: 'frm_9', method: 'POST' }, kind: 'question', choices: [], questions: [] };
    expect(await port.answer('ses_1', a, { kind: 'question', answers: {} })).toBe('gone');
    expect(calls).toEqual([]);
  });

  it('許可の返事を form に、form の返事を許可に送らない', async () => {
    const { port, calls } = setup({ forms: [form([{ key: 'q0', type: 'string' }])] });
    const a = must(port.current('ses_1'));
    expect(await port.answer('ses_1', a, { kind: 'permission', choice: 'once' })).toBe('gone');
    expect(calls).toEqual([]);
  });
});
