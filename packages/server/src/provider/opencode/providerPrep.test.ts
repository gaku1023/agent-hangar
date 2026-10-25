import { describe, expect, it } from 'vitest';
import type { LaunchPrepDto, ProviderPrep } from '@agent-hangar/shared';
import { LaunchPrepCancelled, LaunchPreps } from '../../runs/launchPrep.ts';
import { lastLine, ProviderPrepFailed, ProviderPreps, runPrepCommand, type PrepCommandResult } from './providerPrep.ts';

/** 手で終わらせるコマンド。走らせた順に並ぶ。 */
function fakeRunner() {
  const calls: { command: string; signal: AbortSignal; finish: (r: PrepCommandResult) => void }[] = [];
  const run = (command: string, signal: AbortSignal) => new Promise<PrepCommandResult>((resolve) => {
    const call = { command, signal, finish: resolve };
    calls.push(call);
    signal.addEventListener('abort', () => resolve({ code: null, tail: '' }), { once: true });
  });
  return { calls, run };
}

/** 手で進める時計。 */
function fakeTimers() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let n = 0;
  return {
    timers,
    setTimeout: (fn: () => void, ms: number) => { timers.set(++n, { fn, ms }); return n; },
    clearTimeout: (t: unknown) => { timers.delete(t as number); },
    fire(ms: number) { for (const [k, v] of [...timers]) if (v.ms === ms) { timers.delete(k); v.fn(); } },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

function setup(preps: Record<string, ProviderPrep>) {
  const r = fakeRunner();
  const tm = fakeTimers();
  const reports: string[] = [];
  const pp = new ProviderPreps({
    preps: () => preps, run: r.run, setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout, timeoutMs: 999,
    exitReason: (code) => `exit ${code}`, timeoutReason: (m) => `timeout ${m}`, report: (id, reason) => reports.push(`${id}: ${reason}`),
  });
  const sent: LaunchPrepDto[] = [];
  const launch = new LaunchPreps({ broadcast: (ev) => { sent.push(structuredClone(ev.prep)); }, now: () => 1000 });
  return { r, tm, pp, sent, launch, reports };
}

const gpu: ProviderPrep = { start: 'gpu up', stop: 'gpu down', stopAfter: 15 };

describe('ProviderPreps', () => {
  it('準備のある接続先だけを選ぶ', () => {
    const { pp } = setup({ gpu });
    expect(pp.any()).toBe(true);
    expect(pp.configured(['lmstudio', 'gpu', 'gpu'])).toEqual(['gpu']);
  });

  it('終了コード 0 で段を済ませ、進みに command の run の段を配る', async () => {
    const { r, pp, sent, launch } = setup({ gpu });
    const prep = launch.begin('key-0001');
    const p = pp.prepare('gpu', 'My GPU', 's1', prep);
    await flush();
    expect(r.calls.map((c) => c.command)).toEqual(['gpu up']);
    r.calls[0]!.finish({ code: 0, tail: 'ok' });
    await p;
    expect(sent.at(-1)!.steps).toEqual([expect.objectContaining({ kind: 'command', action: 'run', target: 'My GPU', state: 'done' })]);
  });

  it('0 以外なら出力の最後の行を理由にして失敗する。出力が無ければ終了コードの文', async () => {
    const { r, pp, launch, sent } = setup({ gpu });
    const p = pp.prepare('gpu', 'gpu', 's1', launch.begin('key-0002'));
    await flush();
    r.calls[0]!.finish({ code: 10, tail: 'not on the campus network' });
    await expect(p).rejects.toThrow(new ProviderPrepFailed('not on the campus network'));
    expect(sent.at(-1)!.steps[0]).toEqual(expect.objectContaining({ state: 'failed', reason: 'not on the campus network' }));
    const q = pp.prepare('gpu', 'gpu', 's1', launch.begin('key-0003'));
    await flush();
    r.calls[1]!.finish({ code: 2, tail: '' });
    await expect(q).rejects.toThrow('exit 2');
  });

  it('上限を過ぎたらコマンドを止めて、上限の理由で失敗する', async () => {
    const { r, tm, pp, launch } = setup({ gpu });
    const p = pp.prepare('gpu', 'gpu', 's1', launch.begin('key-0004'));
    await flush();
    tm.fire(999);
    expect(r.calls[0]!.signal.aborted).toBe(true);
    await expect(p).rejects.toThrow('timeout 0');
  });

  it('同じ接続先の準備が並んだら 1 本にまとめる。片方がやめても、もう片方が待つ間は止めない', async () => {
    const { r, pp, launch } = setup({ gpu });
    const a = launch.begin('key-000a');
    const b = launch.begin('key-000b');
    const pa = pp.prepare('gpu', 'gpu', 's1', a);
    const pb = pp.prepare('gpu', 'gpu', 's2', b);
    await flush();
    expect(r.calls).toHaveLength(1);
    a.cancel();
    await expect(pa).rejects.toThrow(LaunchPrepCancelled);
    expect(r.calls[0]!.signal.aborted).toBe(false);
    r.calls[0]!.finish({ code: 0, tail: '' });
    await pb;
  });

  it('待つ準備が全部やめたら、コマンドを止める', async () => {
    const { r, pp, launch } = setup({ gpu });
    const a = launch.begin('key-000c');
    const pa = pp.prepare('gpu', 'gpu', 's1', a);
    await flush();
    a.cancel();
    await expect(pa).rejects.toThrow(LaunchPrepCancelled);
    expect(r.calls[0]!.signal.aborted).toBe(true);
  });

  it('使う会話が全部終わったら、止める時期の後に止めるコマンドを走らせる。間に準備が来たら止めない', async () => {
    const { r, tm, pp, launch } = setup({ gpu });
    const ready = async (sessionId: string, key: string) => {
      const p = pp.prepare('gpu', 'gpu', sessionId, launch.begin(key));
      await flush();
      r.calls.at(-1)!.finish({ code: 0, tail: '' });
      await p;
    };
    await ready('s1', 'key-0011');
    await ready('s2', 'key-0012');
    pp.release('s1');
    expect([...tm.timers.values()].some((t) => t.ms === 15 * 60_000)).toBe(false);
    pp.release('s2');
    expect([...tm.timers.values()].filter((t) => t.ms === 15 * 60_000)).toHaveLength(1);
    // 待つ間に新しい会話が来たら、止めるのをやめる。
    await ready('s3', 'key-0013');
    expect([...tm.timers.values()].some((t) => t.ms === 15 * 60_000)).toBe(false);
    pp.release('s3');
    tm.fire(15 * 60_000);
    expect(r.calls.at(-1)!.command).toBe('gpu down');
  });

  it('止めない（null）か止めるコマンドが空なら、何も走らせない', async () => {
    for (const conf of [{ ...gpu, stopAfter: null }, { ...gpu, stop: '' }]) {
      const { r, tm, pp, launch } = setup({ gpu: conf });
      const p = pp.prepare('gpu', 'gpu', 's1', launch.begin('key-0021'));
      await flush();
      r.calls[0]!.finish({ code: 0, tail: '' });
      await p;
      pp.release('s1');
      expect(tm.timers.size).toBe(0);
    }
  });

  it('止めている最中に準備が来たら、止め終わるのを待ってから走らせる', async () => {
    const { r, tm, pp, launch, reports } = setup({ gpu });
    const p = pp.prepare('gpu', 'gpu', 's1', launch.begin('key-0031'));
    await flush();
    r.calls[0]!.finish({ code: 0, tail: '' });
    await p;
    pp.release('s1');
    tm.fire(15 * 60_000);
    expect(r.calls.at(-1)!.command).toBe('gpu down');
    const q = pp.prepare('gpu', 'gpu', 's2', launch.begin('key-0032'));
    await flush();
    expect(r.calls).toHaveLength(2);
    r.calls[1]!.finish({ code: 1, tail: 'already down' });
    await flush();
    expect(reports).toEqual(['gpu: already down']);
    expect(r.calls.at(-1)!.command).toBe('gpu up');
    r.calls[2]!.finish({ code: 0, tail: '' });
    await q;
  });
});

describe('lastLine', () => {
  it('色の印を外し、最後の空でない行を返す', () => {
    expect(lastLine('starting\n\u001b[31merror: no route\u001b[0m\n\n')).toBe('error: no route');
    expect(lastLine('')).toBe('');
  });
});

describe.skipIf(process.platform === 'win32')('runPrepCommand', () => {
  it('ログインシェルで走らせ、終了コードと最後の行を返す。呼び手の印は渡さない', async () => {
    process.env.HANGAR_TEST_LEAK = 'leak';
    try {
      const r = await runPrepCommand('echo first; echo "leak=${HANGAR_TEST_LEAK:-none}" >&2; exit 3', new AbortController().signal);
      expect(r).toEqual({ code: 3, tail: 'leak=none' });
    } finally {
      delete process.env.HANGAR_TEST_LEAK;
    }
  });

  it('signal が切れたらプロセスの木ごと止める', async () => {
    const ac = new AbortController();
    const p = runPrepCommand('sleep 30; echo never', ac.signal);
    setTimeout(() => ac.abort(), 200);
    const r = await p;
    expect(r.code).not.toBe(0);
    expect(r.tail).toBe('');
  });
});
