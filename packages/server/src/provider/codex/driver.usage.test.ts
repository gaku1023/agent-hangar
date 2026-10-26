import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { LaunchSpec } from '../../agent/types.ts';
import { writeFakeCodex } from '../../../test/fake-codex.ts';
import { posixDescribe } from '../../../test/platform.ts';
import { AgentUsageTracker } from '../../usage/agentUsage.ts';
import { LaunchQueue } from '../opencode/serve/queue.ts';
import { createCodexDriver, type CodexDriver } from './driver.ts';
import { createCodexUsage } from './usage.ts';
import { openDb } from '../../db/open.ts';

const until = async (f: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const SNAP = { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 4_000_000_000 }, secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 4_000_500_000 }, planType: 'plus' };

// 起こした会話の接続から枠を読む（driver が codexUsage.track / untrack を呼ぶ位置）。
posixDescribe('Codex の driver と使用量のつなぎ（B7b）', () => {
  let dir: string;
  let cwd: string;
  const drivers: CodexDriver[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxu-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxuw-'));
  });
  afterEach(async () => {
    for (const d of drivers.splice(0)) await d.launch.release({ sessionId: 's1', providerSessionId: '', cwd }, 'killed');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const make = () => {
    const bin = writeFakeCodex(path.join(dir, 'bin'), { turnMs: 30_000, knownThreads: [{ id: 'ext-thread', cwd }], rateLimits: SNAP });
    const tracker = new AgentUsageTracker();
    const usage = createCodexUsage({ db: openDb(':memory:'), tracker });
    const tracked: string[] = [];
    const untracked: string[] = [];
    const d = createCodexDriver({
      bin: () => bin, home: path.join(dir, 'home'), droppedEnv: [], graceMs: 500, mcpPollMs: 10, mcpWaitMs: 1000, queue: new LaunchQueue(), report: () => undefined,
      usage: () => ({
        track: (t) => { tracked.push(t.providerSessionId); usage.track(t); },
        untrack: (id) => { untracked.push(id); usage.untrack(id); },
      }),
    });
    drivers.push(d);
    return { d, tracker, tracked, untracked };
  };
  const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({ cwd, hangarSessionId: 's1', instructions: [], mcp: { url: 'http://127.0.0.1:4177/mcp/s/s1', secret: 's' }, env: {}, ...over });

  it('初期プロンプトあり：起こした会話の枠が載り、止めたら untrack する', async () => {
    const { d, tracker, tracked, untracked } = make();
    const r = (await d.launch.materialize!({ kind: 'start' }, spec({ prompt: 'work' }))) as { providerSessionId: string };
    await until(() => tracker.of('codex') !== null);
    expect(tracker.of('codex')).toMatchObject({ fiveHour: { usedPercent: 12 }, sevenDay: { usedPercent: 3 }, plan: 'plus' });
    expect(tracked).toEqual([r.providerSessionId]);
    await d.launch.release({ sessionId: 's1', providerSessionId: r.providerSessionId, cwd }, 'killed');
    expect(untracked).toEqual([r.providerSessionId]);
  });

  it('再開：既にある会話でも track する', async () => {
    const { d, tracker, tracked } = make();
    await d.launch.materialize!({ kind: 'resume', id: 'ext-thread' }, spec());
    await until(() => tracker.of('codex') !== null);
    expect(tracked).toEqual(['ext-thread']);
  });

  it('hangar を起こし直したあと：つなぎ直した接続で枠を読む', async () => {
    const a = make();
    const r = (await a.d.launch.materialize!({ kind: 'start' }, spec({ prompt: 'work' }))) as { providerSessionId: string };
    await until(() => a.tracker.of('codex') !== null);
    const b = make();
    expect(b.d.launch.reattach!({ sessionId: 's1', providerSessionId: r.providerSessionId, cwd })).toBe(true);
    await until(() => b.tracker.of('codex') !== null);
    expect(b.tracked).toEqual([r.providerSessionId]);
    await b.d.launch.release({ sessionId: 's1', providerSessionId: r.providerSessionId, cwd }, 'killed');
    expect(b.untracked).toEqual([r.providerSessionId]);
  });
});
