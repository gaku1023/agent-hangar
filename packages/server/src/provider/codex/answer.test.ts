import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settleAnswers, toPeerChatAsk, type AgentAskReply, type AgentPendingAsk } from '../../agent/pendingAsk.ts';
import { writeFakeCodex } from '../../../test/fake-codex.ts';
import { codexAgentAsk, codexAnswerPayload, createCodexAskPort } from './answer.ts';
import { CodexRpc, startAppServer, stopAppServer, type AppServerProcess, type CodexServerRequest } from './appServer.ts';
import { CODEX_CHOICE_TEXT, codexPendingOf, type CodexPending } from './asks.ts';
import { codexBaseEnv } from './env.ts';
import { createCodexLive } from './live.ts';

const until = async (f: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const T = 'thread-1';
const req = (id: number | string, method: string, params: object): CodexServerRequest => ({ id, method, params: { threadId: T, turnId: 'u', itemId: 'i1', ...params } });
const pend = (id: number | string, method: string, params: object): CodexPending => codexPendingOf(req(id, method, params))!;

describe('要求の札への直し', () => {
  it('命令・ファイルの変更・権限は許可の札。命令は once・session・deny・cancel と description を持つ', () => {
    const cmd = codexAgentAsk(pend(7, 'item/commandExecution/requestApproval', { command: 'rm x', reason: 'why' }));
    expect(cmd).toMatchObject({ provider: 'codex', kind: 'permission', tool: 'Bash', input: 'rm x', description: 'why', api: { requestKey: '7', method: 'item/commandExecution/requestApproval' } });
    expect(cmd.choices.map((c) => [c.key, c.scope])).toEqual([['once', 'once'], ['session', 'session'], ['deny', 'deny'], ['cancel', 'deny-stop']]);
    expect(cmd.choices.every((c) => c.label !== '' && !!c.description)).toBe(true);
    expect(codexAgentAsk(pend(8, 'item/fileChange/requestApproval', { grantRoot: '/w' }))).toMatchObject({ tool: 'Edit', input: '/w' });
    const perm = codexAgentAsk(pend(9, 'item/permissions/requestApproval', { cwd: '/w', permissions: { network: { enabled: true } } }));
    expect(perm).toMatchObject({ tool: 'Permissions', input: 'network' });
    expect(perm.choices.map((c) => c.key)).toEqual(['once', 'session', 'deny']);
  });

  it('選べる決定の一覧があれば従い、amendment は出さない', () => {
    const a = codexAgentAsk(pend(7, 'item/commandExecution/requestApproval', { command: 'x', availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['x'] } }, 'decline', { applyNetworkPolicyAmendment: {} }] }));
    expect(a.choices.map((c) => c.key)).toEqual(['once', 'deny']);
    const none = codexAgentAsk(pend(7, 'item/commandExecution/requestApproval', { command: 'x', availableDecisions: [{ acceptWithExecpolicyAmendment: {} }] }));
    expect(none.choices).toHaveLength(4);
  });

  it('requestUserInput は問いを全部読む（見出し、選択肢と description、isOther、isSecret）', () => {
    const a = codexAgentAsk(pend(5, 'item/tool/requestUserInput', {
      questions: [
        { id: 'q1', header: 'First', question: 'Which?', options: [{ label: 'a', description: 'A' }, { label: 'b', description: 'B' }], isOther: true },
        { id: 'q2', header: 'Second', question: 'Token?', isSecret: true },
        { id: 'q3', header: 'Third', question: 'Pick', options: [{ label: 'x', description: 'X' }] },
      ],
    }));
    expect(a.kind).toBe('question');
    expect(a.questions).toHaveLength(3);
    expect(a.questions[0]).toMatchObject({ id: 'q1', header: 'First', text: 'Which?', kind: 'choice', allowText: true, options: [{ key: '1', label: 'a', description: 'A' }, { key: '2', label: 'b', description: 'B' }] });
    expect(a.questions[1]).toMatchObject({ id: 'q2', kind: 'text', secret: true, allowText: true, options: [] });
    expect(a.questions[2]).toMatchObject({ kind: 'choice', allowText: false });
  });

  it('MCP の問い合わせは、欄が無ければ 3 択、欄があれば答えられない', () => {
    const plain = codexAgentAsk(pend(6, 'mcpServer/elicitation/request', { serverName: 's', mode: 'form', message: 'Need', requestedSchema: { type: 'object', properties: {} } }));
    expect(plain.questions[0]).toMatchObject({ kind: 'choice', options: [{ key: 'accept' }, { key: 'decline' }, { key: 'cancel' }] });
    const form = codexAgentAsk(pend(6, 'mcpServer/elicitation/request', { serverName: 's', mode: 'form', message: 'Need', requestedSchema: { type: 'object', properties: { a: { type: 'string' } } } }));
    expect(form.questions[0]!.kind).toBe('external');
    expect(toPeerChatAsk(form, {}).answerable).toBe(false);
  });

  it('質問の札の input に今の問いの文が入る。許可の説明は同じ命令またはファイルに限る', () => {
    const q = toPeerChatAsk(codexAgentAsk(pend(5, 'item/tool/requestUserInput', { questions: [{ id: 'q1', header: 'H', question: 'Which language?' }, { id: 'q2', header: 'H', question: 'Which file?' }] })), {});
    expect(q.input).toBe('Which language?');
    expect(CODEX_CHOICE_TEXT.session.description).toBe('同一の命令またはファイルへの再度の操作を、この会話中に限り確認なしで許可します。');
  });

  it('5 種の要求が PeerChatAsk になる。askId は接続し直して要求の id が変わっても変わらない', () => {
    const cases: [string, object][] = [
      ['item/commandExecution/requestApproval', { command: 'x' }],
      ['item/fileChange/requestApproval', { grantRoot: '/w' }],
      ['item/permissions/requestApproval', { cwd: '/w', permissions: {} }],
      ['item/tool/requestUserInput', { questions: [{ id: 'q', header: 'H', question: 'Q?', options: [{ label: 'a', description: '' }] }] }],
      ['mcpServer/elicitation/request', { serverName: 's', mode: 'form', message: 'm', requestedSchema: {} }],
    ];
    for (const [method, params] of cases) {
      const a = toPeerChatAsk(codexAgentAsk(pend(7, method, params)), {});
      const b = toPeerChatAsk(codexAgentAsk(pend(931, method, params)), {});
      expect(a.askId, method).toMatch(/^[0-9a-f]{24}$/);
      expect(a.askId, method).toBe(b.askId);
      expect(a.options.length, method).toBeGreaterThan(0);
    }
    // approvalId があれば、itemId が違っても同じ札
    const x = toPeerChatAsk(codexAgentAsk(pend(1, 'item/commandExecution/requestApproval', { approvalId: 'ap', itemId: 'i1' })), {});
    const y = toPeerChatAsk(codexAgentAsk(pend(2, 'item/commandExecution/requestApproval', { approvalId: 'ap', itemId: 'i2' })), {});
    expect(x.askId).toBe(y.askId);
    const q = toPeerChatAsk(codexAgentAsk(pend(5, 'item/tool/requestUserInput', { questions: [{ id: 'q1', header: 'H', question: 'a' }, { id: 'q2', header: 'H', question: 'b', isSecret: true }] })), {});
    expect(q).toMatchObject({ step: { index: 1, total: 2 }, header: 'H' });
  });
});

describe('応答の形', () => {
  const perm = (s: 'once' | 'session' | 'deny' | 'deny-stop'): AgentAskReply => ({ kind: 'permission', choice: s });
  it('命令とファイルの変更は decision', () => {
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
      const p = pend(1, method, { command: 'x' });
      expect(codexAnswerPayload(p, perm('once'))).toEqual({ decision: 'accept' });
      expect(codexAnswerPayload(p, perm('session'))).toEqual({ decision: 'acceptForSession' });
      expect(codexAnswerPayload(p, perm('deny'))).toEqual({ decision: 'decline' });
      expect(codexAnswerPayload(p, perm('deny-stop'))).toEqual({ decision: 'cancel' });
    }
  });
  it('選べない決定、種類の違う答えは作らない', () => {
    const p = pend(1, 'item/commandExecution/requestApproval', { command: 'x', availableDecisions: ['accept', 'decline'] });
    expect(codexAnswerPayload(p, perm('session'))).toBeNull();
    expect(codexAnswerPayload(p, { kind: 'question', answers: {} })).toBeNull();
    expect(codexAnswerPayload(pend(1, 'item/tool/requestUserInput', { questions: [] }), perm('once'))).toBeNull();
  });
  it('権限は、求められたものをそのまま許す。断りは空の permissions', () => {
    const permissions = { network: { enabled: true }, fileSystem: { write: ['/w/out'] } };
    const p = pend(1, 'item/permissions/requestApproval', { cwd: '/w', permissions });
    expect(codexAnswerPayload(p, perm('once'))).toEqual({ permissions, scope: 'turn' });
    expect(codexAnswerPayload(p, perm('session'))).toEqual({ permissions, scope: 'session' });
    expect(codexAnswerPayload(p, perm('deny'))).toEqual({ permissions: {}, scope: 'turn' });
  });
  it('requestUserInput は、番号を label に戻し、自由記述はそのまま送る', () => {
    const p = pend(1, 'item/tool/requestUserInput', { questions: [
      { id: 'q1', header: 'H', question: 'Q', options: [{ label: 'alpha', description: '' }, { label: 'beta', description: '' }], isOther: true },
      { id: 'q2', header: 'H', question: 'Q', isSecret: true },
    ] });
    expect(codexAnswerPayload(p, { kind: 'question', answers: { q1: '2', q2: 'tok' } })).toEqual({ answers: { q1: { answers: ['beta'] }, q2: { answers: ['tok'] } } });
    expect(codexAnswerPayload(p, { kind: 'question', answers: { q1: 'free text', q2: 'tok' } })).toEqual({ answers: { q1: { answers: ['free text'] }, q2: { answers: ['tok'] } } });
  });
  it('MCP の問い合わせは action。欄のあるものは作らない', () => {
    const p = pend(1, 'mcpServer/elicitation/request', { serverName: 's', mode: 'form', message: 'm', requestedSchema: {} });
    expect(codexAnswerPayload(p, { kind: 'question', answers: { action: 'decline' } })).toEqual({ action: 'decline' });
    expect(codexAnswerPayload(p, { kind: 'question', answers: { action: 'bogus' } })).toBeNull();
    const form = pend(1, 'mcpServer/elicitation/request', { serverName: 's', mode: 'form', message: 'm', requestedSchema: { properties: { a: {} } } });
    expect(codexAnswerPayload(form, { kind: 'question', answers: { action: 'accept' } })).toBeNull();
  });
});

describe('偽の app-server に対して答える', () => {
  let dir: string;
  let work: string;
  let log: string;
  const servers: AppServerProcess[] = [];
  const rpcs: CodexRpc[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxan-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxaw-'));
    log = path.join(dir, 'rpc.log');
  });
  afterEach(async () => {
    for (const r of rpcs.splice(0)) r.close();
    for (const s of servers.splice(0)) await stopAppServer(s, { graceMs: 500 });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const responses = (): { id: number; result?: unknown }[] =>
    (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.ev === 'response');

  async function setup(prompt: string, resolveWaitMs = 600): Promise<{ sid: string; live: ReturnType<typeof createCodexLive>['live']; port: ReturnType<typeof createCodexAskPort>; rpc: CodexRpc }> {
    const bin = writeFakeCodex(path.join(dir, 'bin'), { rpcLogFile: log });
    const s = await startAppServer({ bin, env: codexBaseEnv(bin), directory: work, tokenDir: path.join(dir, 'tok') });
    servers.push(s);
    const rpc = await CodexRpc.connect({ url: s.url, token: s.token });
    rpcs.push(rpc);
    const { live } = createCodexLive();
    const t = await rpc.threadStart({ cwd: work });
    live.track({ providerSessionId: t.thread.id, cwd: work, pid: s.pid, rpc, subscribed: true });
    const port = createCodexAskPort(live, { resolveWaitMs });
    await rpc.turnStart({ threadId: t.thread.id, input: [{ type: 'text', text: prompt }] });
    await until(() => port.current(t.thread.id) !== null);
    return { sid: t.thread.id, live, port, rpc };
  }

  it('許可に答えると、正しい形の応答が書かれ、resolved で ok になる', async () => {
    const { sid, port, live } = await setup('ask:command');
    const ask = port.current(sid)!;
    expect(ask).toMatchObject({ kind: 'permission', tool: 'Bash', input: 'rm -rf build' });
    expect(await port.answer(sid, ask, { kind: 'permission', choice: 'session' })).toBe('ok');
    expect(responses()).toEqual([expect.objectContaining({ id: 101, result: { decision: 'acceptForSession' } })]);
    await until(() => port.current(sid) === null);
    await until(() => live.current()[0]?.status === 'idle');
  });

  it('権限の追加も、求めたものがそのまま返る', async () => {
    const { sid, port } = await setup('ask:perm');
    expect(await port.answer(sid, port.current(sid)!, { kind: 'permission', choice: 'once' })).toBe('ok');
    expect(responses()[0]!.result).toEqual({ permissions: { network: { enabled: true }, fileSystem: { write: ['/w/out'] } }, scope: 'turn' });
  });

  it('resolved が来なければ unreachable（要求が残っている）', async () => {
    const { sid, port } = await setup('ask:command:noresolve', 300);
    expect(await port.answer(sid, port.current(sid)!, { kind: 'permission', choice: 'once' })).toBe('unreachable');
    expect(responses()).toHaveLength(1);
    expect(port.current(sid)).not.toBeNull();
  });

  it('先に別の接続で解かれていたら gone。応答は書かない', async () => {
    const { sid, port } = await setup('ask:command:preempt');
    const ask = port.current(sid)!;
    await until(() => port.current(sid) === null);
    expect(await port.answer(sid, ask, { kind: 'permission', choice: 'once' })).toBe('gone');
    expect(responses()).toEqual([]);
  });

  it('問い 3 つの requestUserInput は、貯めた答えを最後に 1 回だけ応答する', async () => {
    const { sid, port } = await setup('ask:input3');
    const ask = port.current(sid)!;
    expect(ask.questions).toHaveLength(3);
    // 貯めるのは元の PC の host。ここでは settleAnswers を通した形で 1 回だけ渡す。
    const stored = settleAnswers(ask, { q1: '2', q2: 'secret', q3: '1' });
    expect(responses()).toEqual([]);
    expect(await port.answer(sid, ask, { kind: 'question', answers: stored })).toBe('ok');
    expect(responses()).toEqual([expect.objectContaining({ id: 101, result: { answers: { q1: { answers: ['b'] }, q2: { answers: ['secret'] }, q3: { answers: ['x'] } } } })]);
  });

  it('MCP の問い合わせ（欄なし）は action で答える', async () => {
    const { sid, port } = await setup('ask:mcp');
    const ask = port.current(sid)!;
    expect(await port.answer(sid, ask, { kind: 'question', answers: { action: 'decline' } })).toBe('ok');
    expect(responses()[0]!.result).toEqual({ action: 'decline' });
  });

  it('接続が閉じていれば unreachable、api が無い札も unreachable', async () => {
    const { sid, port, rpc } = await setup('ask:command');
    const ask = port.current(sid)!;
    const noApi: AgentPendingAsk = { ...ask, api: null };
    expect(await port.answer(sid, noApi, { kind: 'permission', choice: 'once' })).toBe('unreachable');
    rpc.close();
    expect(await port.answer(sid, ask, { kind: 'permission', choice: 'once' })).toBe('unreachable');
    expect(port.current('no-such-thread')).toBeNull();
    expect(await port.answer('no-such-thread', ask, { kind: 'permission', choice: 'once' })).toBe('unreachable');
  });
});
