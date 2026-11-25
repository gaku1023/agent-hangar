import { describe, expect, it, vi } from 'vitest';
import { IDLE_STOP_MS, PlamoTranslator, PlamoUnavailableError, type PlamoDeps, type PlamoProc } from './plamo.ts';

type World = {
  deps: PlamoDeps;
  spawned: PlamoProc[];
  killed: number[];
  /** 待ち受けているポート（居るサーバ）。 */
  live: Set<number>;
  configPort: number | null;
  clock: { t: number };
  exit(i: number): void;
};

function world(over: Partial<PlamoDeps> = {}, opts: { readyAfterSleeps?: number; port?: number; hold?: boolean } = {}): World {
  const spawned: PlamoProc[] = [];
  const killed: number[] = [];
  const live = new Set<number>();
  const clock = { t: 1_000_000 };
  const exits: (() => void)[] = [];
  const w: World = {
    spawned, killed, live, clock, configPort: null,
    exit: (i) => exits[i]?.(),
    deps: {
      platform: 'darwin',
      find: () => '/Users/u/.local/bin/plamo-translate',
      spawn: () => {
        let resolve!: () => void;
        const exited = new Promise<void>((r) => { resolve = r; });
        const pid = 100 + spawned.length;
        let sleeps = opts.readyAfterSleeps ?? 2;
        const port = opts.port ?? 30000;
        // 何回か待つとモデルを載せ終え、ポートを書いて待ち受ける。
        w.deps.sleep = async (ms) => {
          clock.t += ms;
          // hold なら、終わるまで載せ終えない（起動中に終わる場面）。
          if (opts.hold) { await exited; return; }
          if (--sleeps === 0) { w.configPort = port; live.add(port); }
        };
        exits.push(() => { live.delete(port); resolve(); });
        const proc: PlamoProc = { pid, exited, kill: () => { killed.push(pid); live.delete(port); resolve(); } };
        spawned.push(proc);
        return proc;
      },
      readPort: () => w.configPort,
      probe: async (port) => live.has(port),
      call: async (port, text) => {
        if (!live.has(port)) throw new Error('ECONNREFUSED');
        return `訳:${text}`;
      },
      now: () => clock.t,
      sleep: async (ms) => { clock.t += ms; },
      ...over,
    },
  };
  return w;
}

describe('PlamoTranslator', () => {
  it('サーバが居なければ起こし、ポートが書かれて応答したら訳す', async () => {
    const w = world();
    const t = new PlamoTranslator(w.deps);
    await expect(t.translate('Hello world')).resolves.toBe('訳:Hello world');
    expect(w.spawned).toHaveLength(1);
  });

  it('利用者が起こしたサーバがすでに居れば、それを使い、起こさない。見回りでも止めない', async () => {
    const w = world();
    w.configPort = 30001;
    w.live.add(30001);
    const t = new PlamoTranslator(w.deps);
    await expect(t.translate('Hello')).resolves.toBe('訳:Hello');
    expect(w.spawned).toHaveLength(0);
    w.clock.t += IDLE_STOP_MS + 1;
    t.tick();
    expect(w.killed).toEqual([]);
  });

  it('同時に頼まれても起こすのは 1 回だけ', async () => {
    const w = world();
    const t = new PlamoTranslator(w.deps);
    const out = await Promise.all([t.translate('a'), t.translate('b'), t.translate('c')]);
    expect(out).toEqual(['訳:a', '訳:b', '訳:c']);
    expect(w.spawned).toHaveLength(1);
  });

  it('待っている翻訳は、新しく頼まれたものから訳す', async () => {
    const w = world();
    const order: string[] = [];
    const call = w.deps.call;
    w.deps.call = async (port, text) => { order.push(text); return call(port, text); };
    const t = new PlamoTranslator(w.deps);
    await Promise.all([t.translate('a'), t.translate('b'), t.translate('c')]);
    // a は先に走り出す。待っていた b と c は、新しい c から訳す。
    expect(order).toEqual(['a', 'c', 'b']);
  });

  it('使わない時間が長くなったら、hangar が起こしたサーバを止める', async () => {
    const w = world();
    const t = new PlamoTranslator(w.deps);
    await t.translate('Hello');
    t.tick();
    expect(w.killed).toEqual([]);
    w.clock.t += IDLE_STOP_MS + 1;
    t.tick();
    expect(w.killed).toEqual([100]);
  });

  it('設定が切になったら、次の見回りで止める', async () => {
    const w = world();
    let on = true;
    const t = new PlamoTranslator(w.deps, () => on);
    await t.translate('Hello');
    on = false;
    t.tick();
    expect(w.killed).toEqual([100]);
  });

  it('止めたあとにまた頼まれたら起こし直す', async () => {
    const w = world();
    const t = new PlamoTranslator(w.deps);
    await t.translate('a');
    t.stop();
    expect(w.killed).toEqual([100]);
    await expect(t.translate('b')).resolves.toBe('訳:b');
    expect(w.spawned).toHaveLength(2);
  });

  it('plamo-translate が無ければ PlamoUnavailableError で断り、Windows では使えないとみなす', async () => {
    const none = new PlamoTranslator(world({ find: () => null }).deps);
    expect(none.available()).toBe(false);
    await expect(none.translate('Hello')).rejects.toBeInstanceOf(PlamoUnavailableError);
    expect(new PlamoTranslator(world({ platform: 'win32' }).deps).available()).toBe(false);
  });

  it('起動中にサーバが終わったら断る', async () => {
    const w = world({}, { hold: true });
    const t = new PlamoTranslator(w.deps);
    const job = t.translate('Hello');
    await vi.waitFor(() => expect(w.spawned).toHaveLength(1));
    w.exit(0);
    await expect(job).rejects.toThrow(/exited while starting/);
  });

  it('訳す途中でサーバが落ちていたら、1 度だけ起こし直してやり直す', async () => {
    const w = world();
    const t = new PlamoTranslator(w.deps);
    await t.translate('a');
    let first = true;
    const call = w.deps.call;
    w.deps.call = async (port, text) => {
      if (first) { first = false; w.exit(0); throw new Error('ECONNRESET'); }
      return call(port, text);
    };
    await expect(t.translate('b')).resolves.toBe('訳:b');
    expect(w.spawned).toHaveLength(2);
  });
});
