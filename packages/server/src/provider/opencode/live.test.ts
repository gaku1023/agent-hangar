import { afterEach, describe, expect, it } from 'vitest';
import type { LiveSessionDto } from '@agent-hangar/shared';
import type { AgentAsk } from '../../agent/types.ts';
import { fixtureFrames, fixtureRest, startFakeEventsServe, until, type FakeEventsServe } from '../../../test/fake-opencode-events.ts';
import { opencodeAsks } from './asks.ts';
import { OpencodeLive } from './live.ts';

// 記録した 2.1.4 の流れの会話（test/fixtures/opencode/2.1.4/README.md）。
const TURN_ID = 'ses_e8ec38c04ffejXAUxlisHJOU1I';
const INTERRUPT_ID = 'ses_e8ec33071ffemdvRj4cRirznTo';
const CWD = '/work/repo';

const servers: FakeEventsServe[] = [];
const lives: OpencodeLive[] = [];
afterEach(async () => {
  for (const l of lives.splice(0)) l.stop();
  for (const s of servers.splice(0)) await s.close();
});

async function setup(o: { alive?: (pid: number) => boolean; reconnectDelaysMs?: number[]; enrich?: (l: LiveSessionDto[]) => LiveSessionDto[] } = {}) {
  const serve = await startFakeEventsServe();
  servers.push(serve);
  const live = new OpencodeLive({ pidAlive: o.alive ?? (() => true), reconnectDelaysMs: o.reconnectDelaysMs ?? [10, 20], enrich: o.enrich });
  lives.push(live);
  const changes: LiveSessionDto[][] = [];
  live.onChange((l) => changes.push(l));
  return { serve, live, changes };
}

/** 取り直しの 3 本（作業中、許可、form）が、どれも requests にあるか。 */
const resynced = (requests: string[]) => ['/api/session/active', '/api/permission/request', '/api/form'].every((p) => requests.some((r) => r.split('?')[0] === p));
/** 写しの 1 行を、変化を見るのに要る欄だけにする。 */
const shape = (l: LiveSessionDto | undefined) => (l ? { status: l.status, waitingFor: l.waitingFor ?? null, tool: l.permission?.tool ?? null } : null);
/** 続けて同じ形が出たものを 1 つにまとめる。 */
const steps = (changes: LiveSessionDto[][], id: string) => changes.map((c) => JSON.stringify(shape(c.find((l) => l.sessionId === id)))).filter((s, i, a) => i === 0 || a[i - 1] !== s).map((s) => JSON.parse(s) as ReturnType<typeof shape>);

describe('OpencodeLive', () => {
  it('記録した 1 ターンの流れ（2.1.4）を流すと、作業中 → 許可待ち（shell）→ 作業中 → 問い待ち → 作業中 → 休み と変わる', async () => {
    const { serve, live, changes } = await setup();
    live.track({ providerSessionId: TURN_ID, cwd: CWD, serve });
    live.start();
    await until(() => serve.open() === 1 && serve.requests.some((r) => r.startsWith('/api/form')));
    await until(() => live.current().length === 1);
    for (const f of fixtureFrames('events-turn.sse')) serve.send(f);
    await until(() => changes.length > 0 && changes.at(-1)!.find((l) => l.sessionId === TURN_ID)?.status === 'idle' && steps(changes, TURN_ID).length >= 6);
    expect(steps(changes, TURN_ID)).toEqual([
      { status: 'idle', waitingFor: null, tool: null },
      { status: 'busy', waitingFor: null, tool: null },
      { status: 'waiting', waitingFor: 'permission', tool: 'shell' },
      { status: 'busy', waitingFor: null, tool: null },
      { status: 'waiting', waitingFor: 'question', tool: null },
      { status: 'busy', waitingFor: null, tool: null },
      { status: 'idle', waitingFor: null, tool: null },
    ]);
  });

  it('許可待ちの行は、道具と命令を permission に持ち、opencode の印と serve の pid を付ける', async () => {
    const { serve, live } = await setup();
    live.track({ providerSessionId: TURN_ID, cwd: CWD, serve });
    live.start();
    await until(() => serve.open() === 1);
    for (const f of fixtureFrames('events-turn.sse')) {
      serve.send(f);
      if (f.includes('"permission.asked"')) break;
    }
    await until(() => live.current()[0]?.waitingFor === 'permission');
    const row = live.current()[0]!;
    expect(row).toMatchObject({ sessionId: TURN_ID, status: 'waiting', waitingFor: 'permission', cwd: CWD, pid: serve.pid, agent: 'opencode', name: null, nameSource: null });
    expect(row.permission).toEqual({ tool: 'shell', input: 'echo hangar-capture', description: null });
    expect(typeof row.statusAt).toBe('number');
  });

  it('許可の待ちの途中で interrupt した流れでは、答えの知らせが無くても待ちを外して休みに戻る', async () => {
    const { serve, live, changes } = await setup();
    live.track({ providerSessionId: INTERRUPT_ID, cwd: CWD, serve });
    live.start();
    await until(() => serve.open() === 1);
    await until(() => live.current().length === 1);
    for (const f of fixtureFrames('events-interrupt.sse')) serve.send(f);
    await until(() => steps(changes, INTERRUPT_ID).length >= 4);
    expect(steps(changes, INTERRUPT_ID)).toEqual([
      { status: 'idle', waitingFor: null, tool: null },
      { status: 'busy', waitingFor: null, tool: null },
      { status: 'waiting', waitingFor: 'permission', tool: 'shell' },
      { status: 'idle', waitingFor: null, tool: null },
    ]);
    expect(live.current()[0]!.permission).toBeUndefined();
  });

  it('つないだときに取り直す。流れの頭には状態が来ないので、記録した取り直しの答えから許可待ちを組む', async () => {
    const { serve, live } = await setup();
    const rest = fixtureRest();
    for (const id of Object.keys(rest.running.data)) serve.state.active.add(id);
    serve.state.permissions = rest.permission.data;
    live.track({ providerSessionId: TURN_ID, cwd: CWD, serve });
    live.start();
    await until(() => live.current()[0]?.status === 'waiting');
    expect(live.current()[0]).toMatchObject({ status: 'waiting', waitingFor: 'permission', permission: { tool: 'shell', input: 'echo hangar-capture', description: null } });
    expect(serve.requests).toContain('/api/session/active');
    expect(serve.requests).toContain(`/api/permission/request?${encodeURIComponent('location[directory]')}=${encodeURIComponent(CWD)}`);
    expect(serve.requests).toContain(`/api/form?${encodeURIComponent('location[directory]')}=${encodeURIComponent(CWD)}`);
  });

  it('切れたら間をあけてつなぎ直し、切れている間の変化を取り直しで拾う', async () => {
    const { serve, live } = await setup();
    live.track({ providerSessionId: TURN_ID, cwd: CWD, serve });
    live.start();
    // つないだときの取り直しの 3 本が serve に届くまで待つ。
    // 届く前に下で state を変えると、その取り直しが変化を拾ってしまい、つなぎ直しの取り直しを確かめられない（CPU が遅いときに起きた）。
    await until(() => serve.open() === 1 && resynced(serve.requests));
    expect(live.current()[0]!.status).toBe('idle');
    const before = serve.requests.length;
    serve.drop();
    // 切れている間に、作業が始まって問いが出た（流れには載らない）。
    serve.state.active.add(TURN_ID);
    serve.state.forms = fixtureRest().form.data;
    await until(() => live.current()[0]?.status === 'waiting');
    expect(live.current()[0]).toMatchObject({ status: 'waiting', waitingFor: 'question' });
    // 問い待ちは、つなぎ直してからの取り直しで拾ったものである。
    const after = serve.requests.slice(before);
    expect(after[0]).toBe('/api/event');
    expect(resynced(after)).toBe(true);
    expect(serve.opened()).toBe(2);
  });

  it('kick で取り直す。流れに載らなかった変化も写しに入る', async () => {
    const { serve, live } = await setup();
    live.track({ providerSessionId: TURN_ID, cwd: CWD, serve });
    live.start();
    await until(() => live.current().length === 1);
    serve.state.active.add(TURN_ID);
    live.kick(0);
    await until(() => live.current()[0]?.status === 'busy');
    serve.state.active.clear();
    live.kick(0);
    await until(() => live.current()[0]?.status === 'idle');
  });

  it('serve が消えた（pid が生きていない）なら、つなぎ直さずに行を外す', async () => {
    let alive = true;
    const { serve, live } = await setup({ alive: () => alive });
    live.track({ providerSessionId: TURN_ID, cwd: CWD, serve });
    live.start();
    await until(() => serve.open() === 1 && live.current().length === 1);
    alive = false;
    serve.drop();
    await until(() => live.current().length === 0);
    await new Promise((r) => setTimeout(r, 60));
    expect(serve.opened()).toBe(1);
    expect(live.isRunning(TURN_ID, serve.pid)).toBe(false);
  });

  it('isRunning は、その会話を serve の pid で持っているかで答える', async () => {
    const { serve, live } = await setup();
    live.track({ providerSessionId: TURN_ID, cwd: CWD, serve });
    expect(live.isRunning(TURN_ID, serve.pid)).toBe(true);
    expect(live.isRunning(TURN_ID, serve.pid + 1)).toBe(false);
    expect(live.isRunning('ses_other', serve.pid)).toBe(false);
  });

  it('untrack で流れを閉じ、行を外す', async () => {
    const { serve, live } = await setup();
    live.track({ providerSessionId: TURN_ID, cwd: CWD, serve });
    live.start();
    await until(() => serve.open() === 1 && live.current().length === 1);
    live.untrack(TURN_ID);
    expect(live.current()).toEqual([]);
    await until(() => serve.open() === 0);
    expect(live.isRunning(TURN_ID, serve.pid)).toBe(false);
  });

  it('変わらなければ同じ配列を返し、onChange を出さない。読み直しのたびに enrich を通す', async () => {
    let enriched = 0;
    const { serve, live, changes } = await setup({ enrich: (l) => { enriched++; return l; } });
    live.track({ providerSessionId: TURN_ID, cwd: CWD, serve });
    live.start();
    await until(() => live.current().length === 1);
    const before = live.current();
    const n = changes.length;
    const e = enriched;
    serve.send(': heartbeat');
    live.kick(0);
    await until(() => enriched > e);
    await new Promise((r) => setTimeout(r, 30));
    expect(live.current()).toBe(before);
    expect(changes.length).toBe(n);
  });

  it('許可と問いを subscribe に流す（記録した 1 ターン）', async () => {
    const { serve, live } = await setup();
    const asks: AgentAsk[] = [];
    const off = opencodeAsks(live).subscribe!((a) => asks.push(a));
    live.track({ providerSessionId: TURN_ID, cwd: CWD, serve });
    live.start();
    await until(() => serve.open() === 1 && live.current().length === 1);
    for (const f of fixtureFrames('events-turn.sse')) serve.send(f);
    await until(() => asks.length >= 3);
    expect(asks).toEqual([
      { kind: 'permission', providerSessionId: TURN_ID, ask: { tool: 'shell', input: 'echo hangar-capture', description: null } },
      { kind: 'question', providerSessionId: TURN_ID, hook: { kind: 'asked', providerSessionId: TURN_ID, toolId: 'call_question_5', summary: 'Which color do you prefer?', question: 'Which color do you prefer?' } },
      { kind: 'question', providerSessionId: TURN_ID, hook: { kind: 'answered', providerSessionId: TURN_ID, toolId: 'call_question_5' } },
    ]);
    off();
  });

  it('取り直しで見つけた問いも 1 度だけ流し、消えたら答えたと流す', async () => {
    const { serve, live } = await setup();
    const asks: AgentAsk[] = [];
    opencodeAsks(live).subscribe!((a) => asks.push(a));
    serve.state.active.add(TURN_ID);
    serve.state.forms = fixtureRest().form.data;
    live.track({ providerSessionId: TURN_ID, cwd: CWD, serve });
    live.start();
    await until(() => asks.length === 1);
    live.kick(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(asks).toHaveLength(1);
    serve.state.forms = [];
    live.kick(0);
    await until(() => asks.length === 2);
    expect(asks[1]).toEqual({ kind: 'question', providerSessionId: TURN_ID, hook: { kind: 'answered', providerSessionId: TURN_ID, toolId: 'call_question_5' } });
  });
});
