import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORCHESTRATOR, type EndReason, type LiveStatus, type OrchestratorSetting, type RunDto } from '@agent-hangar/shared';
import { OrchestratorKeeper, RESPEC_GONE_MS, type KeeperRuns } from './keeper.ts';

const MIN = 60_000;

type Sw = {
  quiet?: (id: string) => boolean;
  /** 送った文を受けたときの動き。偽を返すと送れなかったことにする。 */
  onSend?: (id: string, text: string, keeper: OrchestratorKeeper) => boolean;
};

function rig(initial: Partial<OrchestratorSetting> = {}, o: { resumable?: boolean; failStart?: number; sw?: Sw } = {}) {
  let setting: OrchestratorSetting = { ...DEFAULT_ORCHESTRATOR, ...initial };
  let clock = 1_000_000;
  let listener: { runEnded?(r: RunDto): void } = {};
  let startFails = o.failStart ?? 0;
  const alive = new Set<string>();
  const status = new Map<string, LiveStatus>();
  const liveListeners = new Set<() => void>();
  const calls: string[] = [];
  const sent: { id: string; text: string }[] = [];
  const tokens = new Map<string, number>();
  let n = 0;
  const runs: KeeperRuns = {
    on(l) { listener = l; return () => { listener = {}; }; },
    aliveRun: (id) => (alive.has(id) ? ({ id: `run-${id}`, sessionId: id } as RunDto) : null),
    kill: vi.fn((runId: string) => { calls.push(`kill:${runId}`); const id = runId.replace('run-', ''); alive.delete(id); listener.runEnded?.({ id: runId, sessionId: id, endReason: 'killed', endedAt: clock } as RunDto); }),
    resumeWith: vi.fn(async (id: string, o?: { account?: string; stray?: string }) => { calls.push(`resume:${id}${o?.account ? `@${o.account}` : ''}${o?.stray ? `!${o.stray}` : ''}`); alive.add(id); return {}; }),
    startOrchestrator: vi.fn((o?: { account?: string }) => {
      if (startFails > 0) { startFails -= 1; calls.push('start:fail'); throw new Error('tmux'); }
      const id = `orch-${++n}`;
      calls.push(`start:${id}${o?.account ? `@${o.account}` : ''}`);
      alive.add(id);
      return { sessionId: id };
    }),
  };
  const keeper: OrchestratorKeeper = new OrchestratorKeeper({
    settings: () => setting,
    save: (patch) => { setting = { ...setting, ...patch }; },
    runs,
    resumable: () => o.resumable ?? true,
    liveStatus: (id) => status.get(id) ?? null,
    onLiveChange: (cb) => { liveListeners.add(cb); return () => { liveListeners.delete(cb); }; },
    now: () => clock,
    quiet: async (id) => (o.sw?.quiet ?? (() => true))(id),
    send: async (id, text): Promise<boolean> => { sent.push({ id, text }); return o.sw?.onSend ? o.sw.onSend(id, text, keeper) : true; },
    handoff: (h) => `handoff from ${h.previousId} memo=${h.memo ?? '-'}`,
    memoRequest: () => 'please write a memo',
    startedAt: (id) => (id.startsWith('orch-') ? 500 : null),
    contextTokens: (id) => tokens.get(id) ?? null,
    sleep: async (ms) => { clock += ms; await Promise.resolve(); },
  });
  const end = (sessionId: string, endReason: EndReason) => {
    alive.delete(sessionId);
    listener.runEnded?.({ id: `run-${sessionId}`, sessionId, endReason, endedAt: clock } as RunDto);
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const live = (id: string, st: LiveStatus) => { status.set(id, st); for (const cb of [...liveListeners]) cb(); };
  // 実行中の一覧から消える（claude が終わりきった）。止めた直後はまだ一覧に残っている。
  const gone = (id: string) => { status.delete(id); for (const cb of [...liveListeners]) cb(); };
  return { keeper, runs, calls, sent, tokens, clock: () => clock, end, settle, live, gone, setting: () => setting, set: (p: Partial<OrchestratorSetting>) => { setting = { ...setting, ...p }; }, advance: (ms: number) => { clock += ms; }, alive };
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
    expect(t.calls).toEqual(['start:orch-1', 'kill:run-orch-1']);
    t.keeper.stop();
    t.set({ enabled: true });
    t.end('orch-1', 'lost');
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1', 'kill:run-orch-1']);
  });

  it('設定を切にすると、動いている統括の run を止める。止めた終わり（killed）で起こし直さず、入れ直せば同じ会話を再開する', async () => {
    const t = rig({ enabled: true });
    t.keeper.start();
    await t.settle();
    t.set({ enabled: false });
    t.keeper.apply();
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1', 'kill:run-orch-1']);
    expect(t.alive.has('orch-1')).toBe(false);
    expect(t.setting()).toMatchObject({ enabled: false, sessionId: 'orch-1' });
    expect(t.keeper.state()).toEqual({ status: 'off' });
    t.set({ enabled: true });
    t.keeper.apply();
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1', 'kill:run-orch-1', 'resume:orch-1']);
    expect(t.keeper.state()).toEqual({ status: 'running' });
  });

  it('切のまま apply しても、止める run が無ければ何もしない', async () => {
    const t = rig();
    t.keeper.start();
    t.keeper.apply();
    await t.settle();
    expect(t.calls).toEqual([]);
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

  it('設定のアカウントで起こし、再開にも前に使ったアカウントより設定の値を渡す', async () => {
    const t = rig({ enabled: true, account: 'acc-2' });
    t.keeper.start();
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1@acc-2']);
    t.end('orch-1', 'lost');
    await t.settle();
    expect(t.calls).toEqual(['start:orch-1@acc-2', 'resume:orch-1@acc-2']);
  });

  describe('指定（account、model、effort）が変わったとき', () => {
    it('止めた claude が一覧から消えないままなら、待ちの上限を過ぎてから再開を試みる', async () => {
      vi.useFakeTimers();
      try {
        const t = rig({ enabled: true });
        t.keeper.start();
        await vi.advanceTimersByTimeAsync(0);
        t.live('orch-1', 'idle');
        t.set({ effort: 'high' });
        t.keeper.apply();
        await vi.advanceTimersByTimeAsync(RESPEC_GONE_MS - 1);
        expect(t.calls).toEqual(['start:orch-1', 'kill:run-orch-1']);
        await vi.advanceTimersByTimeAsync(1);
        expect(t.calls).toEqual(['start:orch-1', 'kill:run-orch-1', 'resume:orch-1!stop']);
      } finally { vi.useRealTimers(); }
    });

    const running = async (initial: Partial<OrchestratorSetting> = {}) => {
      const t = rig({ enabled: true, ...initial });
      t.keeper.start();
      await t.settle();
      return t;
    };

    it('idle なら、すぐ止めて同じ会話を新しい指定で再開する。入りのまま、失敗に数えない', async () => {
      const t = await running();
      t.live('orch-1', 'idle');
      t.set({ model: 'opus', account: 'acc-2' });
      t.keeper.apply();
      await t.settle();
      // 止めた claude が実行中の一覧に残っている間は再開しない（再開すると「hangar の外部で実行中」で断られる）。
      expect(t.calls).toEqual(['start:orch-1', 'kill:run-orch-1']);
      t.gone('orch-1');
      await t.settle();
      expect(t.calls).toEqual(['start:orch-1', 'kill:run-orch-1', 'resume:orch-1@acc-2!stop']);
      expect(t.setting()).toMatchObject({ enabled: true, sessionId: 'orch-1', model: 'opus' });
      expect(t.keeper.state()).toEqual({ status: 'running' });
    });

    it('busy の間は待ち、idle になったときに止めて再開する', async () => {
      const t = await running();
      t.live('orch-1', 'busy');
      t.set({ effort: 'high' });
      t.keeper.apply();
      await t.settle();
      expect(t.calls).toEqual(['start:orch-1']);
      t.live('orch-1', 'waiting');
      await t.settle();
      expect(t.calls).toEqual(['start:orch-1']);
      t.live('orch-1', 'idle');
      await t.settle();
      t.gone('orch-1');
      await t.settle();
      expect(t.calls).toEqual(['start:orch-1', 'kill:run-orch-1', 'resume:orch-1!stop']);
      // 同じ指定ではもう止めない。
      t.live('orch-1', 'idle');
      await t.settle();
      expect(t.calls).toHaveLength(3);
    });

    it('この止め方を何度繰り返しても、失敗で止まらない', async () => {
      const t = await running();
      for (const m of ['opus', 'haiku', 'sonnet', 'opus']) {
        t.live('orch-1', 'idle');
        t.set({ model: m });
        t.keeper.apply();
        await t.settle();
        t.gone('orch-1');
        await t.settle();
      }
      expect(t.calls.filter((c) => c.startsWith('kill'))).toHaveLength(4);
      expect(t.keeper.state()).toEqual({ status: 'running' });
      expect(t.setting().enabled).toBe(true);
    });

    it('待っている間に切にされたら、止めるだけで再開しない', async () => {
      const t = await running();
      t.live('orch-1', 'busy');
      t.set({ model: 'opus' });
      t.keeper.apply();
      t.set({ enabled: false });
      t.keeper.apply();
      await t.settle();
      t.live('orch-1', 'idle');
      await t.settle();
      expect(t.calls).toEqual(['start:orch-1', 'kill:run-orch-1']);
    });

    it('指定が同じなら（入り切りだけの変更でも）止めない', async () => {
      const t = await running();
      t.live('orch-1', 'idle');
      t.keeper.apply();
      await t.settle();
      expect(t.calls).toEqual(['start:orch-1']);
    });

    it('前の hangar から引き継いだ run は、起動時は触らず、設定の変更で idle なら起こし直す', async () => {
      const t = rig({ enabled: true, sessionId: 'old-1' });
      t.alive.add('old-1');
      t.keeper.start();
      await t.settle();
      t.live('old-1', 'idle');
      await t.settle();
      expect(t.calls).toEqual([]);
      t.set({ model: 'opus' });
      t.keeper.apply();
      await t.settle();
      t.gone('old-1');
      await t.settle();
      expect(t.calls).toEqual(['kill:run-old-1', 'resume:old-1!stop']);
      expect(t.setting().enabled).toBe(true);
    });
  });
});

describe('OrchestratorKeeper の切り替え（fresh）', () => {
  it('切り替えると、前の id が history に移り、新しい id が sessionId になる。引き継ぎを新しい統括へ送る', async () => {
    const t = rig({ enabled: true, sessionId: 'orch-old' }, { sw: { onSend: (id, text, k) => { if (text === 'please write a memo') k.receiveHandoff(id, '申し送り'); return true; } } });
    t.alive.add('orch-old');
    t.keeper.start();
    await t.settle();
    const r = t.keeper.fresh('fresh');
    expect(r.ok).toBe(true);
    expect(t.keeper.state()).toMatchObject({ status: 'running', switching: true });
    const id = r.ok ? await r.done : null;
    expect(id).toBe('orch-1');
    expect(t.setting().sessionId).toBe('orch-1');
    expect(t.setting().history).toEqual([{ sessionId: 'orch-old', startedAt: 500, endedAt: expect.any(Number), reason: 'fresh' }]);
    expect(t.calls).toEqual(['kill:run-orch-old', 'start:orch-1']);
    expect(t.sent).toEqual([{ id: 'orch-old', text: 'please write a memo' }, { id: 'orch-1', text: 'handoff from orch-old memo=申し送り' }]);
    expect(t.keeper.state()).toEqual({ status: 'running' });
    // 自分で止めた古い run の終わりで、入り切りを切にしない。
    expect(t.setting().enabled).toBe(true);
  });

  it('21 回切り替えると、history は 20 件で最古が落ちる', async () => {
    const t = rig({ enabled: true, sessionId: 'orch-0' });
    t.alive.add('orch-0');
    t.keeper.start();
    await t.settle();
    for (let i = 0; i < 21; i++) { const r = t.keeper.fresh('auto'); if (r.ok) await r.done; }
    const h = t.setting().history;
    expect(h).toHaveLength(20);
    expect(h[0]!.sessionId).toBe('orch-1');
    expect(h.at(-1)!.sessionId).toBe('orch-20');
    expect(t.setting().sessionId).toBe('orch-21');
  });

  it('古い統括がメモを 90 秒書かなければ、メモ無しで切り替わる', async () => {
    const t = rig({ enabled: true, sessionId: 'orch-old' });
    t.alive.add('orch-old');
    t.keeper.start();
    await t.settle();
    const before = t.clock();
    const r = t.keeper.fresh('fresh');
    if (r.ok) await r.done;
    expect(t.clock() - before).toBeGreaterThanOrEqual(90_000);
    expect(t.clock() - before).toBeLessThan(100_000);
    expect(t.sent.at(-1)).toEqual({ id: 'orch-1', text: 'handoff from orch-old memo=-' });
  });

  it('古い統括が busy のまま 30 秒を過ぎても、手動の切り替えは進む', async () => {
    const t = rig({ enabled: true, sessionId: 'orch-old' }, { sw: { quiet: (id) => id !== 'orch-old', onSend: (id, text, k) => { if (text === 'please write a memo') k.receiveHandoff(id, 'm'); return true; } } });
    t.alive.add('orch-old');
    t.keeper.start();
    await t.settle();
    const before = t.clock();
    const r = t.keeper.fresh('fresh');
    if (r.ok) await r.done;
    expect(t.clock() - before).toBeGreaterThanOrEqual(30_000);
    expect(t.setting().sessionId).toBe('orch-1');
  });

  it('メモの頼みが入力欄に入れられなければ、待たずにメモ無しで進む', async () => {
    const t = rig({ enabled: true, sessionId: 'orch-old' }, { sw: { onSend: (id) => id !== 'orch-old' } });
    t.alive.add('orch-old');
    t.keeper.start();
    await t.settle();
    const before = t.clock();
    const r = t.keeper.fresh('fresh');
    if (r.ok) await r.done;
    expect(t.clock() - before).toBeLessThan(5_000);
    expect(t.setting().sessionId).toBe('orch-1');
  });

  it('頼んでいないメモと、古い統括でない会話のメモは受けない', async () => {
    const t = rig({ enabled: true, sessionId: 'orch-old' }, { sw: { onSend: (id, text, k) => { if (text === 'please write a memo') expect(k.receiveHandoff('other', 'x')).toBe(false); return true; } } });
    t.alive.add('orch-old');
    t.keeper.start();
    await t.settle();
    expect(t.keeper.receiveHandoff('orch-old', 'x')).toBe(false);
    const r = t.keeper.fresh('fresh');
    if (r.ok) await r.done;
    expect(t.sent.at(-1)!.text).toContain('memo=-');
  });

  it('切のときと、切り替え中は断る', async () => {
    const off = rig();
    expect(off.keeper.fresh('fresh')).toEqual({ ok: false, error: 'off' });
    const t = rig({ enabled: true, sessionId: 'orch-old' });
    t.alive.add('orch-old');
    t.keeper.start();
    await t.settle();
    const r = t.keeper.fresh('fresh');
    expect(t.keeper.fresh('fresh')).toEqual({ ok: false, error: 'switching' });
    if (r.ok) await r.done;
  });

  it('統括が動いていなくても（止まっていても）始め直せる。待ちもメモも無い', async () => {
    const t = rig({ enabled: true, sessionId: 'orch-old' }, { failStart: 0 });
    t.keeper.start();
    await t.settle();
    t.keeper.stopByUser();
    await t.settle();
    const r = t.keeper.fresh('agent');
    const id = r.ok ? await r.done : null;
    expect(id).toBe('orch-1');
    expect(t.setting().history.at(-1)).toMatchObject({ sessionId: 'orch-old', reason: 'agent' });
    expect(t.keeper.state()).toEqual({ status: 'running' });
    expect(t.sent.map((x) => x.id)).toEqual(['orch-1']);
  });

  it('会話が消えて新しく起こしたときは、reason gone で history に残す', async () => {
    const t = rig({ enabled: true, sessionId: 'lost' }, { resumable: false });
    t.keeper.start();
    await t.settle();
    expect(t.setting().sessionId).toBe('orch-1');
    expect(t.setting().history).toEqual([{ sessionId: 'lost', startedAt: null, endedAt: expect.any(Number), reason: 'gone' }]);
  });
});

describe('OrchestratorKeeper の止める・起こす', () => {
  it('stop で stopped: user になり、enabled は変わらない。起こし直さない', async () => {
    const t = rig({ enabled: true, sessionId: 'orch-9' });
    t.keeper.start();
    await t.settle();
    expect(t.keeper.stopByUser()).toEqual({ ok: true });
    await t.settle();
    expect(t.keeper.state()).toEqual({ status: 'stopped', reason: 'user' });
    expect(t.setting().enabled).toBe(true);
    expect(t.alive.has('orch-9')).toBe(false);
    expect(t.calls).toEqual(['resume:orch-9', 'kill:run-orch-9']);
  });

  it('wake で止まった状態を捨てて同じ会話を再開し、running に戻る', async () => {
    const t = rig({ enabled: true, sessionId: 'orch-9' });
    t.keeper.start();
    await t.settle();
    t.keeper.stopByUser();
    await t.settle();
    expect(t.keeper.wake()).toEqual({ ok: true });
    await t.settle();
    expect(t.keeper.state()).toEqual({ status: 'running' });
    expect(t.calls.at(-1)).toBe('resume:orch-9');
  });

  it('切のときは stop も wake も断る', () => {
    const t = rig();
    expect(t.keeper.stopByUser()).toEqual({ ok: false, error: 'off' });
    expect(t.keeper.wake()).toEqual({ ok: false, error: 'off' });
  });

  it('文脈の量を状態に添える', async () => {
    const t = rig({ enabled: true, sessionId: 'orch-9' });
    t.tokens.set('orch-9', 120_000);
    t.keeper.start();
    await t.settle();
    expect(t.keeper.state()).toEqual({ status: 'running', contextTokens: 120_000 });
  });
});
