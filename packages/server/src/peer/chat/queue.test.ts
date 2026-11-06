import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerBlobRef } from '@agent-hangar/shared';
import { PEER_QUEUE_EXPIRE_MS, PEER_QUEUE_MAX_PER_RUN, PeerQueue, type PeerQueueEvent, type TurnState } from './queue.ts';

const MAC = { deviceId: 'dev-mac', deviceName: 'Mac' };
const WIN = { deviceId: 'dev-win', deviceName: 'Win' };
const RUN = 'run-1';
const MIN = 60_000;

/** 外から渡すものを全部偽物にした組み立て。 */
function setup(opts: { turn?: TurnState; empty?: boolean } = {}) {
  const st = { turn: (opts.turn ?? 'busy') as TurnState, empty: opts.empty ?? true, deliverOk: true, delivered: [] as { runId: string; text: string; images: PeerBlobRef[] }[], deliverGate: null as null | Promise<void> };
  let n = 0;
  const q = new PeerQueue({
    now: () => Date.now(),
    turnState: () => st.turn,
    inputEmpty: async () => st.empty,
    deliver: async (runId, text, images) => {
      if (st.deliverGate) await st.deliverGate;
      st.delivered.push({ runId, text, images });
      return st.deliverOk;
    },
    newId: () => `q${++n}`,
    pollMs: 1000,
  });
  const events: PeerQueueEvent[] = [];
  q.subscribe((e) => events.push(e));
  return { q, st, events };
}

/** 偽の時計を進めて、非同期の続きも流す。 */
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.useRealTimers(); });

describe('PeerQueue：預かる', () => {
  it('作業中に来た文は預かり、渡さない。waiting で一覧に出る', async () => {
    const { q, st, events } = setup({ turn: 'busy' });
    const id = q.add(RUN, MAC, 'hello', [])!;
    await advance(5000);
    expect(st.delivered).toEqual([]);
    expect(q.list(RUN)).toEqual([{ queueId: id, from: MAC, text: 'hello', images: 0, at: 1_000_000, state: 'waiting' }]);
    expect(events.map((e) => e.type)).toEqual(['queued']);
    q.dispose();
  });

  it('画像は枚数だけを一覧に出し、渡すときは参照を渡す', async () => {
    const { q, st } = setup({ turn: 'busy' });
    const img = { name: 'a.png' } as unknown as PeerBlobRef;
    q.add(RUN, MAC, 'see', [img, img]);
    expect(q.list(RUN)[0]!.images).toBe(2);
    st.turn = 'idle';
    await advance(1000);
    expect(st.delivered).toEqual([{ runId: RUN, text: 'see', images: [img, img] }]);
    q.dispose();
  });

  it('別の会話の預かりは混ざらない', async () => {
    const { q } = setup({ turn: 'busy' });
    q.add('run-a', MAC, 'a', []);
    q.add('run-b', MAC, 'b', []);
    expect(q.list('run-a').map((i) => i.text)).toEqual(['a']);
    expect(q.list('run-b').map((i) => i.text)).toEqual(['b']);
    expect(q.list('run-c')).toEqual([]);
    q.dispose();
  });
});

describe('PeerQueue：渡す', () => {
  it('ターンが止まり入力欄が空なら渡す。delivering のあと消え、delivered に送り主が付く', async () => {
    const { q, st, events } = setup({ turn: 'busy' });
    const id = q.add(RUN, MAC, 'hello', [])!;
    st.turn = 'idle';
    await advance(1000);
    expect(st.delivered.map((d) => d.text)).toEqual(['hello']);
    expect(q.list(RUN)).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['queued', 'delivering', 'delivered']);
    expect(events[2]).toMatchObject({ type: 'delivered', runId: RUN, from: MAC, item: { queueId: id } });
    q.dispose();
  });

  it('止まっていて空のところへ来た文は、すぐ（次の確認で）渡す', async () => {
    const { q, st } = setup({ turn: 'idle', empty: true });
    q.add(RUN, MAC, 'now', []);
    await advance(1000);
    expect(st.delivered.map((d) => d.text)).toEqual(['now']);
    q.dispose();
  });

  it('notifyTurnChanged は次の確認を待たずに渡す', async () => {
    const { q, st } = setup({ turn: 'busy' });
    q.add(RUN, MAC, 'hello', []);
    st.turn = 'idle';
    q.notifyTurnChanged(RUN);
    await advance(0);
    expect(st.delivered.map((d) => d.text)).toEqual(['hello']);
    q.dispose();
  });

  it('打ちかけがあれば渡さない。消えたら渡す', async () => {
    const { q, st } = setup({ turn: 'idle', empty: false });
    q.add(RUN, MAC, 'hello', []);
    await advance(30_000);
    expect(st.delivered).toEqual([]);
    expect(q.list(RUN)[0]!.state).toBe('waiting');
    st.empty = true;
    await advance(1000);
    expect(st.delivered.map((d) => d.text)).toEqual(['hello']);
    q.dispose();
  });

  it('許可や質問の札が出ている間（waiting）と、止まった会話（stopped）には渡さない', async () => {
    const { q, st } = setup({ turn: 'waiting' });
    q.add(RUN, MAC, 'hello', []);
    await advance(5000);
    st.turn = 'stopped';
    await advance(5000);
    expect(st.delivered).toEqual([]);
    q.dispose();
  });

  it('入力欄を読めなかったときは渡さない（安全側）', async () => {
    const st = { delivered: 0 };
    const q = new PeerQueue({ now: () => Date.now(), turnState: () => 'idle', inputEmpty: async () => { throw new Error('capture failed'); }, deliver: async () => { st.delivered++; return true; }, newId: () => 'q', pollMs: 1000 });
    q.add(RUN, MAC, 'hello', []);
    await advance(5000);
    expect(st.delivered).toBe(0);
    expect(q.list(RUN)).toHaveLength(1);
    q.dispose();
  });

  it('渡せなかった（deliver が偽、または投げた）ときは預かりに戻し、次の確認で試す', async () => {
    const { q, st, events } = setup({ turn: 'idle' });
    st.deliverOk = false;
    q.add(RUN, MAC, 'hello', []);
    await advance(1000);
    expect(q.list(RUN)[0]!.state).toBe('waiting');
    st.deliverOk = true;
    await advance(1000);
    expect(q.list(RUN)).toEqual([]);
    expect(events.filter((e) => e.type === 'delivered')).toHaveLength(1);
    q.dispose();
  });

  it('渡している間は delivering と見え、1 度に 1 件だけ渡す', async () => {
    const { q, st } = setup({ turn: 'idle' });
    let release!: () => void;
    st.deliverGate = new Promise<void>((r) => { release = r; });
    q.add(RUN, MAC, 'one', []);
    q.add(RUN, WIN, 'two', []);
    await advance(3000);
    expect(q.list(RUN).map((i) => i.state)).toEqual(['delivering', 'waiting']);
    expect(st.delivered).toEqual([]);
    release();
    await advance(0);
    expect(st.delivered.map((d) => d.text)).toEqual(['one']);
    q.dispose();
  });

  it('古い順に渡す。次の 1 件は、ターンがもう一度始まって止まってから', async () => {
    const { q, st } = setup({ turn: 'idle' });
    q.add(RUN, MAC, 'one', []);
    q.add(RUN, WIN, 'two', []);
    q.add(RUN, MAC, 'three', []);
    await advance(1000);
    expect(st.delivered.map((d) => d.text)).toEqual(['one']);
    // 渡した直後の idle の読みで、続けて 2 件目を渡さない
    await advance(5000);
    expect(st.delivered.map((d) => d.text)).toEqual(['one']);
    st.turn = 'busy';
    await advance(2000);
    st.turn = 'idle';
    await advance(1000);
    expect(st.delivered.map((d) => d.text)).toEqual(['one', 'two']);
    st.turn = 'busy';
    await advance(2000);
    st.turn = 'idle';
    await advance(1000);
    expect(st.delivered.map((d) => d.text)).toEqual(['one', 'two', 'three']);
    q.dispose();
  });

  it('ターンが始まらないまま（スラッシュコマンドなど）でも、しばらく待てば次を渡す', async () => {
    const { q, st } = setup({ turn: 'idle' });
    q.add(RUN, MAC, 'one', []);
    q.add(RUN, MAC, 'two', []);
    await advance(1000);
    expect(st.delivered).toHaveLength(1);
    await advance(30_000);
    expect(st.delivered.map((d) => d.text)).toEqual(['one', 'two']);
    q.dispose();
  });
});

describe('PeerQueue：10 分で捨てる（U11）', () => {
  it('時計は預けた時刻でなく、ターンが止まった時刻から数える', async () => {
    const { q, st, events } = setup({ turn: 'busy', empty: false });
    q.add(RUN, MAC, 'hello', []);
    await advance(30 * MIN);
    st.turn = 'idle';
    await advance(PEER_QUEUE_EXPIRE_MS - 5000);
    expect(q.list(RUN)).toHaveLength(1);
    await advance(10_000);
    expect(q.list(RUN)).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['queued', 'expired']);
    expect(events[1]).toMatchObject({ type: 'expired', runId: RUN, reason: 'queue-expired', item: { text: 'hello', from: MAC } });
    q.dispose();
  });

  it('途中でターンがまた始まれば、時計は数え直す', async () => {
    const { q, st } = setup({ turn: 'idle', empty: false });
    q.add(RUN, MAC, 'hello', []);
    await advance(9 * MIN);
    st.turn = 'busy';
    await advance(2000);
    st.turn = 'idle';
    await advance(9 * MIN);
    expect(q.list(RUN)).toHaveLength(1);
    await advance(2 * MIN);
    expect(q.list(RUN)).toEqual([]);
    q.dispose();
  });

  it('止まっている会話に打ちかけのまま来た文は、預けた時刻から 10 分待つ（すぐには捨てない）', async () => {
    const { q, st } = setup({ turn: 'idle', empty: false });
    await advance(3 * 60 * MIN);
    q.add(RUN, MAC, 'hello', []);
    await advance(PEER_QUEUE_EXPIRE_MS - 5000);
    expect(q.list(RUN)).toHaveLength(1);
    st.empty = true;
    await advance(1000);
    expect(st.delivered.map((d) => d.text)).toEqual(['hello']);
    q.dispose();
  });

  it('10 分の直前に入力欄が空になれば渡し、捨てない', async () => {
    const { q, st, events } = setup({ turn: 'idle', empty: false });
    q.add(RUN, MAC, 'hello', []);
    await advance(PEER_QUEUE_EXPIRE_MS - 2000);
    st.empty = true;
    await advance(1000);
    expect(events.map((e) => e.type)).toEqual(['queued', 'delivering', 'delivered']);
    q.dispose();
  });

  it('許可の札が出ている間は、止まったとみなさず時計も進めない', async () => {
    const { q } = setup({ turn: 'waiting', empty: false });
    q.add(RUN, MAC, 'hello', []);
    await advance(30 * MIN);
    expect(q.list(RUN)).toHaveLength(1);
    q.dispose();
  });
});

describe('PeerQueue：取り消し', () => {
  it('送った PC だけが取り消せ、文が返る。預かりから消える', () => {
    const { q, events } = setup({ turn: 'busy' });
    const id = q.add(RUN, MAC, 'oops', [])!;
    expect(q.cancel(id, WIN.deviceId)).toEqual({ ok: false, reason: 'not-sender' });
    expect(q.list(RUN)).toHaveLength(1);
    expect(q.cancel(id, MAC.deviceId)).toEqual({ ok: true, text: 'oops' });
    expect(q.list(RUN)).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['queued', 'cancelled']);
    expect(events[1]).toMatchObject({ type: 'cancelled', runId: RUN, item: { queueId: id, text: 'oops' } });
    q.dispose();
  });

  it('無い ID と、すでに渡した預かりは取り消せない', async () => {
    const { q, st } = setup({ turn: 'idle' });
    expect(q.cancel('nope', MAC.deviceId)).toEqual({ ok: false, reason: 'not-found' });
    const id = q.add(RUN, MAC, 'x', [])!;
    await advance(1000);
    expect(st.delivered).toHaveLength(1);
    expect(q.cancel(id, MAC.deviceId)).toEqual({ ok: false, reason: 'not-found' });
    q.dispose();
  });

  it('渡している最中（delivering）は取り消せない', async () => {
    const { q, st } = setup({ turn: 'idle' });
    let release!: () => void;
    st.deliverGate = new Promise<void>((r) => { release = r; });
    const id = q.add(RUN, MAC, 'x', [])!;
    await advance(1000);
    expect(q.cancel(id, MAC.deviceId)).toEqual({ ok: false, reason: 'delivering' });
    release();
    await advance(0);
    q.dispose();
  });

  it('取り消した文は、あとで止まっても渡さない', async () => {
    const { q, st } = setup({ turn: 'busy' });
    const id = q.add(RUN, MAC, 'oops', [])!;
    q.cancel(id, MAC.deviceId);
    st.turn = 'idle';
    await advance(5000);
    expect(st.delivered).toEqual([]);
    q.dispose();
  });
});

describe('PeerQueue：メモリだけ・後始末', () => {
  it('作り直した PeerQueue は空（再起動で預かりは残らない）', () => {
    const a = setup({ turn: 'busy' });
    a.q.add(RUN, MAC, 'x', []);
    a.q.dispose();
    const b = setup({ turn: 'busy' });
    expect(b.q.list(RUN)).toEqual([]);
    b.q.dispose();
  });

  it('預かりが空なら確認の時計を止める。dispose のあとは何も渡さない', async () => {
    const { q, st } = setup({ turn: 'busy' });
    expect(vi.getTimerCount()).toBe(0);
    const id = q.add(RUN, MAC, 'x', [])!;
    expect(vi.getTimerCount()).toBe(1);
    q.cancel(id, MAC.deviceId);
    expect(vi.getTimerCount()).toBe(0);
    q.add(RUN, MAC, 'y', []);
    q.dispose();
    expect(vi.getTimerCount()).toBe(0);
    st.turn = 'idle';
    await advance(5000);
    expect(st.delivered).toEqual([]);
  });

  it('購読は外せる。購読した側が投げても預かりは壊れない', async () => {
    const { q, st } = setup({ turn: 'idle' });
    const seen: string[] = [];
    const off = q.subscribe((e) => seen.push(e.type));
    q.subscribe(() => { throw new Error('boom'); });
    q.add(RUN, MAC, 'x', []);
    off();
    await advance(1000);
    expect(seen).toEqual(['queued']);
    expect(st.delivered).toHaveLength(1);
    q.dispose();
  });
});

describe('PeerQueue：外の口が投げたとき', () => {
  it('turnState が投げたら、止まった（stopped）とみなす。例外を外へ出さず、渡さず、10 分で捨てる', async () => {
    const unhandled: unknown[] = [];
    const onRejection = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onRejection);
    try {
      const delivered: string[] = [];
      const q = new PeerQueue({
        now: () => Date.now(),
        turnState: () => { throw new Error('live read failed'); },
        inputEmpty: async () => true,
        deliver: async (_r, text) => { delivered.push(text); return true; },
        newId: () => 'q1',
        pollMs: 1000,
      });
      const events: string[] = [];
      q.subscribe((e) => events.push(e.type));
      q.add(RUN, MAC, 'hello', []);
      q.notifyTurnChanged(RUN);
      await advance(PEER_QUEUE_EXPIRE_MS - 5000);
      expect(delivered).toEqual([]);
      expect(q.list(RUN)).toHaveLength(1);
      await advance(10_000);
      expect(q.list(RUN)).toEqual([]);
      expect(events).toEqual(['queued', 'expired']);
      await advance(0);
      expect(unhandled).toEqual([]);
      q.dispose();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('now が投げても、確認の時計から例外を外へ出さない', async () => {
    const unhandled: unknown[] = [];
    const onRejection = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onRejection);
    try {
      let broken = false;
      const q = new PeerQueue({
        now: () => { if (broken) throw new Error('clock'); return Date.now(); },
        turnState: () => 'busy',
        inputEmpty: async () => true,
        deliver: async () => true,
        newId: () => 'q1',
        pollMs: 1000,
      });
      q.add(RUN, MAC, 'hello', []);
      broken = true;
      await advance(5000);
      q.notifyTurnChanged(RUN);
      await advance(0);
      expect(unhandled).toEqual([]);
      q.dispose();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('PeerQueue：渡す直前の確かめ', () => {
  it('入力欄を読んでから渡すまでの間に打ちかけが現れたら、渡さず預かりに残す', async () => {
    const reads: boolean[] = [true, false];
    const delivered: string[] = [];
    const q = new PeerQueue({
      now: () => Date.now(),
      turnState: () => 'idle',
      // 1 回目は空、渡す直前の 2 回目は打ちかけ。以降は空
      inputEmpty: async () => (reads.length > 0 ? reads.shift()! : true),
      deliver: async (_r, text) => { delivered.push(text); return true; },
      newId: () => 'q1',
      pollMs: 1000,
    });
    const events: string[] = [];
    q.subscribe((e) => events.push(e.type));
    q.add(RUN, MAC, 'hello', []);
    await advance(0);
    expect(delivered).toEqual([]);
    expect(q.list(RUN)[0]!.state).toBe('waiting');
    expect(events).toEqual(['queued']);
    await advance(1000);
    expect(delivered).toEqual(['hello']);
    expect(events).toEqual(['queued', 'delivering', 'delivered']);
    q.dispose();
  });

  it('確かめている間にターンが動き出したら（idle でなくなったら）渡さない', async () => {
    let turn: TurnState = 'idle';
    let calls = 0;
    const delivered: string[] = [];
    const q = new PeerQueue({
      now: () => Date.now(),
      turnState: () => turn,
      inputEmpty: async () => { calls++; if (calls === 2) turn = 'busy'; return true; },
      deliver: async (_r, text) => { delivered.push(text); return true; },
      newId: () => 'q1',
      pollMs: 1000,
    });
    q.add(RUN, MAC, 'hello', []);
    await advance(0);
    expect(delivered).toEqual([]);
    expect(q.list(RUN)[0]!.state).toBe('waiting');
    q.dispose();
  });
});

describe('PeerQueue：後始末のあと・上限・会話の消去', () => {
  it('dispose のあとの add は預からず null を返す', () => {
    const { q } = setup({ turn: 'busy' });
    q.dispose();
    expect(q.add(RUN, MAC, 'late', [])).toBeNull();
    expect(q.list(RUN)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('1 つの会話に預かれるのは PEER_QUEUE_MAX_PER_RUN 件まで。超えたら null を返し、ほかの会話は預かる', () => {
    const { q, events } = setup({ turn: 'busy' });
    const ids: (string | null)[] = [];
    for (let i = 0; i < PEER_QUEUE_MAX_PER_RUN; i++) ids.push(q.add(RUN, MAC, `m${i}`, []));
    expect(ids.every((x) => typeof x === 'string')).toBe(true);
    expect(q.add(RUN, MAC, 'one too many', [])).toBeNull();
    expect(q.list(RUN)).toHaveLength(PEER_QUEUE_MAX_PER_RUN);
    expect(events.filter((e) => e.type === 'queued')).toHaveLength(PEER_QUEUE_MAX_PER_RUN);
    expect(typeof q.add('run-2', MAC, 'other run', [])).toBe('string');
    // 取り消せば空きができる
    q.cancel(ids[0]!, MAC.deviceId);
    expect(typeof q.add(RUN, MAC, 'fits again', [])).toBe('string');
    q.dispose();
  });

  it('dropRun は、その会話の預かりを全部消し、1 件ごとに dropped を出す（送り主へ早く返せる）', async () => {
    const { q, st, events } = setup({ turn: 'busy' });
    q.add(RUN, MAC, 'a', []);
    q.add(RUN, WIN, 'b', []);
    q.add('run-2', MAC, 'other', []);
    expect(q.dropRun(RUN)).toBe(2);
    expect(q.list(RUN)).toEqual([]);
    expect(q.list('run-2')).toHaveLength(1);
    const dropped = events.filter((e) => e.type === 'dropped');
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toMatchObject({ type: 'dropped', runId: RUN, item: { text: 'a', from: MAC } });
    expect(dropped[1]).toMatchObject({ type: 'dropped', runId: RUN, item: { text: 'b', from: WIN } });
    // 消したあとに止まっても渡さない
    st.turn = 'idle';
    await advance(5000);
    expect(st.delivered.map((d) => d.text)).toEqual(['other']);
    expect(q.dropRun('nothing')).toBe(0);
    q.dispose();
  });

  it('dropRun は渡している最中の 1 件には触らない', async () => {
    const { q, st, events } = setup({ turn: 'idle' });
    let release!: () => void;
    st.deliverGate = new Promise<void>((r) => { release = r; });
    q.add(RUN, MAC, 'one', []);
    q.add(RUN, MAC, 'two', []);
    await advance(1000);
    expect(q.dropRun(RUN)).toBe(1);
    expect(q.list(RUN).map((i) => i.text)).toEqual(['one']);
    release();
    await advance(0);
    expect(st.delivered.map((d) => d.text)).toEqual(['one']);
    expect(events.filter((e) => e.type === 'dropped').map((e) => (e as { item: { text: string } }).item.text)).toEqual(['two']);
    q.dispose();
  });
});
