import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORCHESTRATOR, type EndReason, type OrchestratorSetting, type RunDto } from '@agent-hangar/shared';
import { OrchestratorKeeper, type KeeperRuns } from './keeper.ts';

const MIN = 60_000;

function rig(initial: Partial<OrchestratorSetting> = {}, o: { resumable?: boolean; failStart?: number } = {}) {
  let setting: OrchestratorSetting = { ...DEFAULT_ORCHESTRATOR, ...initial };
  let clock = 1_000_000;
  let listener: { runEnded?(r: RunDto): void } = {};
  let startFails = o.failStart ?? 0;
  const alive = new Set<string>();
  const calls: string[] = [];
  let n = 0;
  const runs: KeeperRuns = {
    on(l) { listener = l; return () => { listener = {}; }; },
    aliveRun: (id) => (alive.has(id) ? ({ id: `run-${id}`, sessionId: id } as RunDto) : null),
    resumeWith: vi.fn(async (id: string) => { calls.push(`resume:${id}`); alive.add(id); return {}; }),
    startOrchestrator: vi.fn(() => {
      if (startFails > 0) { startFails -= 1; calls.push('start:fail'); throw new Error('tmux'); }
      const id = `orch-${++n}`;
      calls.push(`start:${id}`);
      alive.add(id);
      return { sessionId: id };
    }),
  };
  const keeper = new OrchestratorKeeper({
    settings: () => setting,
    save: (patch) => { setting = { ...setting, ...patch }; },
    runs,
    resumable: () => o.resumable ?? true,
    now: () => clock,
  });
  const end = (sessionId: string, endReason: EndReason) => {
    alive.delete(sessionId);
    listener.runEnded?.({ id: `run-${sessionId}`, sessionId, endReason, endedAt: clock } as RunDto);
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { keeper, runs, calls, end, settle, setting: () => setting, set: (p: Partial<OrchestratorSetting>) => { setting = { ...setting, ...p }; }, advance: (ms: number) => { clock += ms; }, alive };
}

describe('OrchestratorKeeper', () => {
  it('切のあいだは何も起こさない', async () => {
    const t = rig();
    t.keeper.start();
    await t.settle();
    expect(t.calls).toEqual([]);
    expect(t.keeper.state()).toEqual({ status: 'off' });
  });

  it('有効で sessionId が無ければ、新しく 1 つ起こして設定に書く。2 度有効にしても 2 つ起こさない', async () => {
    const t = rig({ enabled: true });
    t.keeper.start();
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1']);
    expect(t.setting().sessionId).toBe('orch-1');
    t.keeper.apply();
    t.keeper.apply();
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1']);
    expect(t.keeper.state()).toEqual({ status: 'running' });
  });

  it('sessionId があり run が無ければ、同じ会話を再開する', async () => {
    const t = rig({ enabled: true, sessionId: 'orch-9' });
    t.keeper.start();
    await t.settle();
    expect(t.calls).toEqual(['resume:orch-9']);
    expect(t.setting().sessionId).toBe('orch-9');
  });

  it('会話が消えている、または再開できる本文が無ければ、新しく起こして sessionId を書き換える', async () => {
    const t = rig({ enabled: true, sessionId: 'gone' }, { resumable: false });
    t.keeper.start();
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1']);
    expect(t.setting().sessionId).toBe('orch-1');
  });

  it('run が消えたら起こし直す', async () => {
    const t = rig({ enabled: true });
    t.keeper.start();
    await t.settle();
    t.end('orch-1', 'lost');
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1', 'resume:orch-1']);
  });

  it('統括でない会話の run が消えても何もしない', async () => {
    const t = rig({ enabled: true });
    t.keeper.start();
    await t.settle();
    t.end('other', 'lost');
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1']);
  });

  it('10 分に 3 回失敗したら止まり、自動では再試行しない。画面の柱が読める状態に理由を出す', async () => {
    const t = rig({ enabled: true });
    t.keeper.start();
    await t.settle();
    t.end('orch-1', 'lost');
    await t.settle();
    t.advance(MIN);
    t.end('orch-1', 'exited');
    await t.settle();
    t.advance(MIN);
    expect(t.calls).toEqual(['start:orch-1', 'resume:orch-1', 'resume:orch-1']);
    t.end('orch-1', 'lost');
    await t.settle();
    expect(t.calls).toHaveLength(3);
    expect(t.keeper.state()).toEqual({ status: 'stopped', reason: 'failures' });
    // 時間がたっても、自分では起こさない。
    t.advance(60 * MIN);
    await t.settle();
    expect(t.calls).toHaveLength(3);
    // 入れ直すと（設定を変えると）また始める。
    t.keeper.apply();
    await t.settle();
    expect(t.calls).toHaveLength(3);
    t.set({ enabled: false });
    t.keeper.apply();
    t.set({ enabled: true });
    t.keeper.apply();
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1', 'resume:orch-1', 'resume:orch-1', 'resume:orch-1']);
    expect(t.keeper.state()).toEqual({ status: 'running' });
  });

  it('10 分より前の失敗は数えない', async () => {
    const t = rig({ enabled: true });
    t.keeper.start();
    await t.settle();
    for (let i = 0; i < 4; i++) {
      t.advance(6 * MIN);
      t.end('orch-1', 'lost');
      await t.settle();
    }
    expect(t.keeper.state()).toEqual({ status: 'running' });
    expect(t.calls.filter((c) => c.startsWith('resume'))).toHaveLength(4);
  });

  it('起こすのが投げたら失敗に数える。3 回で止まる', async () => {
    const t = rig({ enabled: true }, { failStart: 5 });
    t.keeper.start();
    await t.settle();
    expect(t.calls).toEqual(['start:fail', 'start:fail', 'start:fail']);
    expect(t.keeper.state()).toEqual({ status: 'stopped', reason: 'failures' });
    expect(t.setting().sessionId).toBeNull();
  });

  it('利用者が止めたら（killed）起こし直さず、enabled を false にする', async () => {
    const t = rig({ enabled: true });
    t.keeper.start();
    await t.settle();
    t.end('orch-1', 'killed');
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1']);
    expect(t.setting().enabled).toBe(false);
    expect(t.keeper.state()).toEqual({ status: 'off' });
  });

  it('設定を切にすると、以後 run が消えても起こさない。stop すると購読を外す', async () => {
    const t = rig({ enabled: true });
    t.keeper.start();
    await t.settle();
    t.set({ enabled: false });
    t.keeper.apply();
    t.end('orch-1', 'lost');
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1']);
    t.keeper.stop();
    t.set({ enabled: true });
    t.end('orch-1', 'lost');
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1']);
  });

  it('状態が変わるたびに知らせる', async () => {
    const t = rig({ enabled: true });
    const seen: string[] = [];
    t.keeper.onState((s) => seen.push(s.status));
    t.keeper.start();
    await t.settle();
    t.set({ enabled: false });
    t.keeper.apply();
    expect(seen).toEqual(['running', 'off']);
  });
});
