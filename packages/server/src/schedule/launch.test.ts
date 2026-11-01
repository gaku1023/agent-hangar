import { describe, expect, it, vi } from 'vitest';
import * as queries from '../db/queries.ts';
import * as screen from '../mcp/screenTools.ts';
import * as tools from '../mcp/tools.ts';
import type { ToolDeps } from '../mcp/tools.ts';
import * as wait from '../mcp/waitTool.ts';
import { launchScheduled, waitScheduled } from './launch.ts';

vi.mock('../db/queries.ts', async (orig) => ({ ...(await orig<typeof queries>()), getSession: vi.fn() }));
vi.mock('../mcp/screenTools.ts', async (orig) => ({ ...(await orig<typeof screen>()), sendToSessionTool: vi.fn(async () => ({})) }));
vi.mock('../mcp/tools.ts', async (orig) => ({ ...(await orig<typeof tools>()), createSessionTool: vi.fn(async () => ({ session_id: 'new1' })), resumeSessionTool: vi.fn(async () => ({})) }));
vi.mock('../mcp/waitTool.ts', async (orig) => ({ ...(await orig<typeof wait>()), waitForSessionTool: vi.fn() }));

const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
const deps = (alive: boolean) => ({ db: {}, deviceId: 'd', live: () => [], runs: { aliveRun: () => (alive ? {} : null) } }) as unknown as ToolDeps;
const session = (live: string | null) => ({ id: 's1', live }) as never;
const session_ = vi.mocked(queries.getSession);

describe('予定を流す', () => {
  it('新しい会話は指示を渡して起こす。名前は指示の頭から取る', async () => {
    const r = await launchScheduled(deps(false), { prompt: 'a'.repeat(60), target: { kind: 'new', projectId: 'p', agent: 'codex' } }, clock());
    expect(r).toEqual({ sessionId: 'new1' });
    const args = vi.mocked(tools.createSessionTool).mock.calls.at(-1)![2];
    expect(args).toMatchObject({ project_id: 'p', prompt: 'a'.repeat(60), agent: 'codex' });
    expect([...(args.name as string)]).toHaveLength(40);
  });

  it.each(['busy', 'waiting', null])('既存の会話が %s なら送らず busy を返す', async (live) => {
    session_.mockReturnValue(session(live));
    vi.mocked(screen.sendToSessionTool).mockClear();
    expect(await launchScheduled(deps(true), { prompt: 'x', target: { kind: 'session', sessionId: 's1' } }, clock())).toBe('busy');
    expect(screen.sendToSessionTool).not.toHaveBeenCalled();
  });

  it('止まっている会話は再開し、入力を受けられるようになってから送る', async () => {
    session_.mockReset();
    session_.mockReturnValueOnce(session(null)).mockReturnValueOnce(session(null)).mockReturnValue(session('idle'));
    vi.mocked(screen.sendToSessionTool).mockClear();
    expect(await launchScheduled(deps(false), { prompt: 'x', target: { kind: 'session', sessionId: 's1' } }, clock())).toEqual({ sessionId: 's1' });
    expect(tools.resumeSessionTool).toHaveBeenCalled();
    expect(vi.mocked(screen.sendToSessionTool).mock.calls[0]![2]).toEqual({ session_id: 's1', text: 'x' });
  });

  it('再開しても受けられなければ、送らずに投げる', async () => {
    session_.mockReset();
    session_.mockReturnValue(session(null));
    vi.mocked(screen.sendToSessionTool).mockClear();
    await expect(launchScheduled(deps(false), { prompt: 'x', target: { kind: 'session', sessionId: 's1' } }, clock())).rejects.toThrow();
    expect(screen.sendToSessionTool).not.toHaveBeenCalled();
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
