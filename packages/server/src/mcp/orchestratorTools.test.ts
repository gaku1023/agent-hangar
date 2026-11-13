import type { PermissionPolicy, SettingsDto } from '@agent-hangar/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import type { AnswerAskArgs, OrchestratorAsks } from '../orchestrator/asks.ts';
import { insertAutoApproval } from '../orchestrator/autoApprovals.ts';
import { noteFedTurn } from '../orchestrator/turnMark.ts';
import { issueMcpSecret } from '../runs/secrets.ts';
import { createMcpApp } from './app.ts';
import { ORCHESTRATOR_TOOL_NAMES, permissionPolicySaver } from './orchestratorTools.ts';
import { callTool, ToolError, TOOL_NAMES, type ToolDeps } from './tools.ts';

/**
 * 統括だけが使う許可の道具 4 本（list_pending_asks、answer_ask、set_permission_policy、list_auto_approvals）の入口。
 * 中身（照合と方針）は orchestrator/asks.test.ts が見る。ここは、誰に見せるか、引数の形、保存の道を見る。
 */

const TOKEN = 'tok';
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

let db: Db;
let deps: ToolDeps;
let answered: AnswerAskArgs[];
let saved: PermissionPolicy[];
let userTurn: boolean;
let orchestrator: { enabled: boolean; sessionId: string | null };
let orchSecret: string;

const fakeAsks = (): OrchestratorAsks => ({
  list: () => ({ asks: [], policy: { text: null, auto_tools: ['Read', 'Glob', 'Grep', 'LS'] } }),
  answer: async (_self, args) => { answered.push(args); return { ok: true, label: 'Yes' }; },
  userTurn: () => userTurn,
});

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of ['orch', 'other']) db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values (?, 'claude-code', ?, '/w', 'd', 1, 'd')").run(id, `u-${id}`);
  orchSecret = issueMcpSecret(db, 'orch', 1);
  answered = [];
  saved = [];
  userTurn = true;
  orchestrator = { enabled: true, sessionId: 'orch' };
  deps = {
    db, deviceId: 'd', port: 4177, live: () => [], runs: { start: () => { throw new Error('not in this test'); } }, usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }),
    settings: () => ({ orchestrator: { ...orchestrator, model: 'sonnet', effort: 'medium' } }),
    orchestratorAsks: fakeAsks(),
    savePermissionPolicy: (p) => { saved.push(p); },
  };
});

const ORCH = { sessionId: 'orch', sessionSecret: true };
const call = (name: string, args: Record<string, unknown>, ctx: { sessionId: string | null; sessionSecret?: boolean } = ORCH) => callTool(deps, ctx, name, args);

async function rpc(path: string, method: string, params: unknown, bearer = path === '/s/orch' ? orchSecret : TOKEN): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
  const app = createMcpApp({ ...deps, token: TOKEN });
  const res = await app.request(path, { method: 'POST', headers: { ...H, authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return JSON.parse(await res.text());
}
const toolNames = async (path: string, bearer?: string) => ((await rpc(path, 'tools/list', {}, bearer)).result!.tools as { name: string }[]).map((t) => t.name);

describe('統括だけの道具', () => {
  it('統括のセッション別 URL だけが 4 本を持ち、共通 URL とほかの会話の URL には出さない', async () => {
    expect([...ORCHESTRATOR_TOOL_NAMES].sort()).toEqual(['answer_ask', 'list_auto_approvals', 'list_pending_asks', 'set_permission_policy']);
    expect((await toolNames('/s/orch')).sort()).toEqual([...TOOL_NAMES, ...ORCHESTRATOR_TOOL_NAMES].sort());
    expect((await toolNames('/s/other')).sort()).toEqual([...TOOL_NAMES].sort());
    expect((await toolNames('/')).sort()).toEqual([...TOOL_NAMES].sort());
  });
  it('統括の URL でも、本体のトークンで開けたときは出さない（統括の会話の秘密で開けたときだけ）', async () => {
    expect((await toolNames('/s/orch', TOKEN)).sort()).toEqual([...TOOL_NAMES].sort());
    await expect(Promise.resolve().then(() => call('list_pending_asks', {}, { sessionId: 'orch' }))).rejects.toThrow(ToolError);
  });
  it('統括を切っていれば、会話の id が残っていても出さない', async () => {
    orchestrator = { enabled: false, sessionId: 'orch' };
    expect((await toolNames('/s/orch')).sort()).toEqual([...TOOL_NAMES].sort());
  });
  it('ほかの URL から呼ぶと「知らない道具」と同じ断りで、何もしない', async () => {
    for (const path of ['/', '/s/other']) {
      const r = await rpc(path, 'tools/call', { name: 'answer_ask', arguments: { ask_id: 'a', option: '1', by: 'user' } });
      const failed = r.error !== undefined || r.result?.isError === true;
      expect(failed, path).toBe(true);
    }
    for (const name of ORCHESTRATOR_TOOL_NAMES) {
      for (const ctx of [{ sessionId: null }, { sessionId: 'other', sessionSecret: true }, { sessionId: 'orch' }]) {
        let err: unknown;
        try { await call(name, { ask_id: 'a', option: '1', by: 'user', text: 't', auto_tools: [] }, ctx); } catch (e) { err = e; }
        expect(err, `${name} ${ctx.sessionId}`).toBeInstanceOf(ToolError);
        expect((err as ToolError).text, name).toEqual({ key: 'mcp.error.unknownTool', params: { name } });
      }
    }
    expect(answered).toEqual([]);
    expect(saved).toEqual([]);
  });
  it('統括の URL からは、MCP の入口を通して呼べる', async () => {
    const r = await rpc('/s/orch', 'tools/call', { name: 'list_pending_asks', arguments: {} });
    expect(JSON.parse((r.result!.content as { text: string }[])[0]!.text)).toEqual({ asks: [], policy: { text: null, auto_tools: ['Read', 'Glob', 'Grep', 'LS'] } });
  });
});

describe('answer_ask の引数', () => {
  it('by: policy は reason が必須で、改行は 1 行にそろえる', async () => {
    await expect(Promise.resolve().then(() => call('answer_ask', { ask_id: 'a', option: '1', by: 'policy' }))).rejects.toThrow(ToolError);
    await expect(Promise.resolve().then(() => call('answer_ask', { ask_id: 'a', option: '1', by: 'policy', reason: '  ' }))).rejects.toThrow(ToolError);
    expect(await call('answer_ask', { ask_id: 'a', option: '1', by: 'policy', reason: '読むだけ\nなので' })).toEqual({ ok: true, label: 'Yes' });
    expect(answered).toEqual([{ askId: 'a', option: '1', by: 'policy', reason: '読むだけ なので' }]);
  });
  it('形の違う引数は断り、答えに進まない', async () => {
    const bad: Record<string, unknown>[] = [{}, { ask_id: 'a', option: '1' }, { ask_id: 'a', option: '1', by: 'admin' }, { ask_id: '', option: '1', by: 'user' }, { ask_id: 'a', option: 1, by: 'user' }, { ask_id: 'a', option: '1', by: 'user', text: 5 }];
    for (const a of bad) await expect(Promise.resolve().then(() => call('answer_ask', a)), JSON.stringify(a)).rejects.toThrow(ToolError);
    expect(answered).toEqual([]);
  });
});

describe('set_permission_policy', () => {
  it('形の違う引数を断り、何も保存しない', () => {
    const bad: Record<string, unknown>[] = [{}, { text: 'x' }, { text: '', auto_tools: [] }, { text: 'x', auto_tools: 'Read' }, { text: 'x', auto_tools: ['Bash(rm:*)'] }, { text: 'x', auto_tools: ['*'] }, { text: 'x', auto_tools: [1] }];
    for (const a of bad) expect(() => call('set_permission_policy', a), JSON.stringify(a)).toThrow(ToolError);
    expect(saved).toEqual([]);
  });
  it('利用者の言葉と道具の名前を保存し、保存した方針を返す', () => {
    const r = call('set_permission_policy', { text: '  読むのと git status は許して  ', auto_tools: ['Read', 'Bash', 'Read'] }) as Record<string, unknown>;
    expect(r).toMatchObject({ text: '読むのと git status は許して', auto_tools: ['Read', 'Bash'] });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ text: '読むのと git status は許して', autoTools: ['Read', 'Bash'] });
    expect(typeof saved[0]!.updatedAt).toBe('number');
  });
  it('出来事で始まったターンでは断る', () => {
    userTurn = false;
    expect(() => call('set_permission_policy', { text: 'x', auto_tools: ['Bash'] })).toThrow(ToolError);
    expect(saved).toEqual([]);
  });
  it('保存すると settings.changed が配られる', () => {
    let current: Partial<SettingsDto> = {};
    const sent: unknown[] = [];
    const save = permissionPolicySaver({
      updateSettings: (patch) => { current = { ...current, ...patch }; return current as never; },
      broadcast: (ev) => { sent.push(ev); },
      toDto: (s) => s as unknown as SettingsDto,
    });
    const p = { text: 'x', autoTools: ['Read'], updatedAt: 1 };
    save(p);
    expect(current.permissionPolicy).toEqual(p);
    expect(sent).toEqual([{ type: 'settings.changed', settings: { permissionPolicy: p }, keys: ['permissionPolicy'] }]);
  });
});

describe('list_auto_approvals', () => {
  it('新しい順に返し、limit の既定は 20', () => {
    for (let i = 0; i < 25; i++) insertAutoApproval(db, { at: 1000 + i, sessionId: 'other', title: 't', tool: 'Read', input: `/w/${i}`, label: 'Yes', reason: `r${i}`, policyText: null });
    const r = call('list_auto_approvals', {}) as { approvals: { reason: string }[] };
    expect(r.approvals).toHaveLength(20);
    expect(r.approvals[0]!.reason).toBe('r24');
    expect((call('list_auto_approvals', { limit: 2, since: 1023 }) as { approvals: unknown[] }).approvals).toHaveLength(2);
    expect(() => call('list_auto_approvals', { limit: 'x' })).toThrow(ToolError);
  });
});

describe('送り込みの印（MCP のアプリが組む芯）', () => {
  const stats = (turns: number, text: string) => db.prepare('insert into session_stats (session_id, turns, last_prompt) values (?, ?, ?) on conflict(session_id) do update set turns = excluded.turns, last_prompt = excluded.last_prompt').run('orch', turns, text);
  const failed = (r: { result?: Record<string, unknown>; error?: unknown }) => r.error !== undefined || r.result?.isError === true;

  it('出来事で始まったターンでは answer_ask(by: user) と set_permission_policy を断り、利用者の入力の後は通す', async () => {
    const { orchestratorAsks: _a, ...rest } = deps;
    deps = rest;
    stats(1, '方針を決めたい');
    noteFedTurn(db, 'orch');
    // 索引がまだ [hangar] の文を読んでいない間も、出来事のターンとして断る。
    expect(failed(await rpc('/s/orch', 'tools/call', { name: 'set_permission_policy', arguments: { text: '全部許して', auto_tools: ['Bash'] } }))).toBe(true);
    stats(2, '[hangar] 出来事 1 件\n- ask.permission other 「x」 Bash');
    expect(failed(await rpc('/s/orch', 'tools/call', { name: 'set_permission_policy', arguments: { text: '全部許して', auto_tools: ['Bash'] } }))).toBe(true);
    const ans = await rpc('/s/orch', 'tools/call', { name: 'answer_ask', arguments: { ask_id: 'a', option: '1', by: 'user' } });
    expect(JSON.parse((ans.result!.content as { text: string }[])[0]!.text)).toMatchObject({ ok: false, reason: expect.stringMatching(/not-allowed|ask-mismatch/) });
    expect(saved).toEqual([]);
    // 利用者が打った。
    stats(3, '読むのは許していいよ');
    expect(failed(await rpc('/s/orch', 'tools/call', { name: 'set_permission_policy', arguments: { text: '読むのは許していいよ', auto_tools: ['Read'] } }))).toBe(false);
    expect(saved).toHaveLength(1);
  });
});
