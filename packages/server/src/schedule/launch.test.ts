import { describe, expect, it, vi } from 'vitest';
import { MessageError } from '../i18n/message.ts';
import * as queries from '../db/queries.ts';
import * as screen from '../mcp/screenTools.ts';
import * as tools from '../mcp/tools.ts';
import type { ToolDeps } from '../mcp/tools.ts';
import * as wait from '../mcp/waitTool.ts';
import { launchScheduled, waitScheduled, worktreeForRun } from './launch.ts';

vi.mock('../db/queries.ts', async (orig) => ({ ...(await orig<typeof queries>()), getSession: vi.fn() }));
vi.mock('../mcp/screenTools.ts', async (orig) => ({ ...(await orig<typeof screen>()), sendToSessionTool: vi.fn(async () => ({})) }));
vi.mock('../mcp/tools.ts', async (orig) => ({ ...(await orig<typeof tools>()), createSessionTool: vi.fn(async () => ({ session_id: 'new1' })), resumeSessionTool: vi.fn(async () => ({})) }));
vi.mock('../mcp/waitTool.ts', async (orig) => ({ ...(await orig<typeof wait>()), waitForSessionTool: vi.fn() }));

const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
const deps = (alive: boolean) => ({ db: {}, deviceId: 'd', live: () => [], runs: { aliveRun: () => (alive ? {} : null) } }) as unknown as ToolDeps;
const PLANNED = new Date(2026, 10, 5, 9, 0).getTime();
const session = (live: string | null) => ({ id: 's1', live }) as never;
const session_ = vi.mocked(queries.getSession);

describe('予定を流す', () => {
  it('新しい会話は指示を渡して起こす。名前は指示の頭から取る', async () => {
    const r = await launchScheduled(deps(false), { prompt: 'a'.repeat(60), target: { kind: 'new', projectId: 'p', agent: 'codex' }, plannedAt: PLANNED }, clock());
    expect(r).toEqual({ sessionId: 'new1' });
    const args = vi.mocked(tools.createSessionTool).mock.calls.at(-1)![2];
    expect(args).toMatchObject({ project_id: 'p', prompt: 'a'.repeat(60), agent: 'codex' });
    expect([...(args.name as string)]).toHaveLength(40);
  });

  it.each(['busy', 'waiting', null])('既存の会話が %s なら送らず busy を返す', async (live) => {
    session_.mockReturnValue(session(live));
    vi.mocked(screen.sendToSessionTool).mockClear();
    expect(await launchScheduled(deps(true), { prompt: 'x', target: { kind: 'session', sessionId: 's1' }, plannedAt: PLANNED }, clock())).toBe('busy');
    expect(screen.sendToSessionTool).not.toHaveBeenCalled();
  });

  it('止まっている会話は再開し、入力を受けられるようになってから送る', async () => {
    session_.mockReset();
    session_.mockReturnValueOnce(session(null)).mockReturnValueOnce(session(null)).mockReturnValue(session('idle'));
    vi.mocked(screen.sendToSessionTool).mockClear();
    expect(await launchScheduled(deps(false), { prompt: 'x', target: { kind: 'session', sessionId: 's1' }, plannedAt: PLANNED }, clock())).toEqual({ sessionId: 's1' });
    expect(tools.resumeSessionTool).toHaveBeenCalled();
    expect(vi.mocked(screen.sendToSessionTool).mock.calls[0]![2]).toEqual({ session_id: 's1', text: 'x' });
  });

  it('再開しても受けられなければ、送らずに投げる', async () => {
    session_.mockReset();
    session_.mockReturnValue(session(null));
    vi.mocked(screen.sendToSessionTool).mockClear();
    await expect(launchScheduled(deps(false), { prompt: 'x', target: { kind: 'session', sessionId: 's1' }, plannedAt: PLANNED }, clock())).rejects.toThrow();
    expect(screen.sendToSessionTool).not.toHaveBeenCalled();
  });
});

describe('worktree の名前', () => {
  it('予定の時刻を手元の時刻で MMDD-HHmm にして付ける', () => {
    expect(worktreeForRun('deps-audit', new Date(2026, 10, 5, 9, 0).getTime())).toBe('deps-audit-1105-0900');
    expect(worktreeForRun('w', new Date(2026, 0, 2, 23, 7).getTime())).toBe('w-0102-2307');
  });
});

describe('新しい会話の起動の項目', () => {
  const acct = (id: string) => ({ id, name: id, dir: `/d/${id}` });
  const withAccounts = (o: { claude?: readonly string[]; codex?: readonly string[] } = {}) => ({
    ...deps(false),
    accounts: { store: { list: () => (o.claude ?? []).map(acct), get: (id: string) => (o.claude ?? []).includes(id) ? acct(id) : undefined, current: () => acct('cur') }, usage: { of: () => ({}) } },
    codexAccounts: { list: () => (o.codex ?? []).map(acct), get: (id: string) => (o.codex ?? []).includes(id) ? acct(id) : undefined, current: () => acct('cur') },
  }) as unknown as ToolDeps;
  const lastArgs = () => vi.mocked(tools.createSessionTool).mock.calls.at(-1)![2];

  it('Claude Code の全項目を createSessionTool の引数へ写し、worktree には予定の時刻を付ける', async () => {
    await launchScheduled(withAccounts({ claude: ['a1'] }), {
      prompt: '指示', plannedAt: PLANNED,
      target: { kind: 'new', projectId: 'p', name: '夜の点検', account: 'a1', model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits', worktree: 'w', addDirs: ['/x', '/y'], cwd: '/p/sub' },
    }, clock());
    expect(lastArgs()).toEqual({ project_id: 'p', prompt: '指示', name: '夜の点検', account: 'a1', model: 'sonnet', effort: 'high', permission_mode: 'acceptEdits', worktree: 'w-1105-0900', add_dirs: ['/x', '/y'], cwd: '/p/sub' });
  });

  it('name が無ければ今と同じく指示の頭。項目が無ければキーも付けない', async () => {
    await launchScheduled(withAccounts(), { prompt: 'abc', plannedAt: PLANNED, target: { kind: 'new', projectId: 'p' } }, clock());
    expect(lastArgs()).toEqual({ project_id: 'p', prompt: 'abc', name: 'abc' });
  });

  it('クイックセッションは scratch: true で、project_id を付けない', async () => {
    await launchScheduled(withAccounts(), { prompt: 'abc', plannedAt: PLANNED, target: { kind: 'new', projectId: null, scratch: true } }, clock());
    expect(lastArgs()).toEqual({ scratch: true, prompt: 'abc', name: 'abc' });
  });

  it('Codex の account は Codex の組の id で渡す', async () => {
    await launchScheduled(withAccounts({ claude: ['c1'], codex: ['x1'] }), { prompt: 'p', plannedAt: PLANNED, target: { kind: 'new', projectId: 'p', agent: 'codex', account: 'x1', permissionMode: 'full-access' } }, clock());
    expect(lastArgs()).toMatchObject({ agent: 'codex', account: 'x1', permission_mode: 'full-access' });
  });

  it('opencode の autoApprove と mode を渡す', async () => {
    await launchScheduled(withAccounts(), { prompt: 'p', plannedAt: PLANNED, target: { kind: 'new', projectId: 'p', agent: 'opencode', mode: 'plan', autoApprove: true } }, clock());
    expect(lastArgs()).toMatchObject({ agent: 'opencode', mode: 'plan', auto_approve: true });
  });

  it.each([['claude-code', { claude: [], codex: ['x1'] }], ['codex', { claude: ['x1'], codex: [] }]] as const)('消えた id の %s のアカウントは schedules.error.accountGone で投げ、起こさない', async (agent, sets) => {
    vi.mocked(tools.createSessionTool).mockClear();
    const err = await launchScheduled(withAccounts(sets), { prompt: 'p', plannedAt: PLANNED, target: { kind: 'new', projectId: 'p', agent, account: 'x1' } }, clock()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MessageError);
    expect((err as MessageError).text).toMatchObject({ key: 'schedules.error.accountGone' });
    expect(tools.createSessionTool).not.toHaveBeenCalled();
  });

  it('起こす口が断った理由（同名の worktree があるなど）は、そのまま投げる', async () => {
    vi.mocked(tools.createSessionTool).mockRejectedValueOnce(new Error('worktree exists'));
    await expect(launchScheduled(withAccounts(), { prompt: 'p', plannedAt: PLANNED, target: { kind: 'new', projectId: 'p', worktree: 'w' } }, clock())).rejects.toThrow('worktree exists');
  });
});

describe('終わりを待つ', () => {
  it('時間切れでは呼び直し、終わりか入力待ちで返す', async () => {
    vi.mocked(wait.waitForSessionTool).mockReset();
    vi.mocked(wait.waitForSessionTool).mockResolvedValueOnce({ state: 'timeout' } as never).mockResolvedValueOnce({ state: 'waiting' } as never);
    expect(await waitScheduled(deps(true), 's1', clock())).toEqual({ result: 'waiting' });
    expect(wait.waitForSessionTool).toHaveBeenCalledTimes(2);
  });
  it('失敗は理由を添える', async () => {
    vi.mocked(wait.waitForSessionTool).mockReset();
    vi.mocked(wait.waitForSessionTool).mockResolvedValue({ state: 'failed', reason: 'limit' } as never);
    expect(await waitScheduled(deps(true), 's1', clock())).toEqual({ result: 'failed', error: 'limit' });
  });
});
