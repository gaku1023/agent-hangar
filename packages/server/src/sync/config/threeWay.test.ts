import { describe, expect, it } from 'vitest';
import { judge, type RemoteSnapshot } from './threeWay.ts';

const snap = (deviceId: string, at: number, items: Record<string, string>): RemoteSnapshot => ({ deviceId, at, items: new Map(Object.entries(items).map(([id, sha256]) => [id, { sha256 }])) });
const m = (o: Record<string, string>) => new Map(Object.entries(o));
const run = (local: Record<string, string>, base: Record<string, string>, remotes: RemoteSnapshot[]) => judge({ local: m(local), base: m(base), remotes });
const ops = (j: ReturnType<typeof judge>) => Object.fromEntries(j.actions.map((a) => [a.id, a.op]));

describe('3 方向の判定（自分、相手、前回の共通）', () => {
  it('手元だけにあるものは何もしない（送るだけ）', () => {
    const j = run({ a: 'x' }, {}, [snap('B', 10, {})]);
    expect(j.actions).toEqual([]);
    expect(j.agreed.size).toBe(0);
  });

  it('相手だけにあるものは create', () => {
    const j = run({}, {}, [snap('B', 10, { a: 'x' })]);
    expect(j.actions).toEqual([{ id: 'a', op: 'create', fromDeviceId: 'B', remoteSha256: 'x', localSha256: null }]);
  });

  it('同じ中身なら何もせず、共通の中身として覚える', () => {
    const j = run({ a: 'x' }, {}, [snap('B', 10, { a: 'x' })]);
    expect(j.actions).toEqual([]);
    expect([...j.agreed]).toEqual([['a', 'x']]);
  });

  it('相手だけが変えたら overwrite', () => {
    const j = run({ a: 'x' }, { a: 'x' }, [snap('B', 10, { a: 'y' })]);
    expect(j.actions).toEqual([{ id: 'a', op: 'overwrite', fromDeviceId: 'B', remoteSha256: 'y', localSha256: 'x' }]);
  });

  it('手元だけが変えたら何もしない（手元が新しいので送るだけ）', () => {
    const j = run({ a: 'y' }, { a: 'x' }, [snap('B', 10, { a: 'x' })]);
    expect(j.actions).toEqual([]);
    expect(j.agreed.size).toBe(0);
  });

  it('両方が別々に変えたら conflict', () => {
    const j = run({ a: 'y' }, { a: 'x' }, [snap('B', 10, { a: 'z' })]);
    expect(j.actions).toEqual([{ id: 'a', op: 'conflict', fromDeviceId: 'B', remoteSha256: 'z', localSha256: 'y' }]);
  });

  it('共通の記録が無いまま中身が違えば conflict', () => {
    const j = run({ a: 'y' }, {}, [snap('B', 10, { a: 'z' })]);
    expect(ops(j)).toEqual({ a: 'conflict' });
  });

  it('相手の目録から消えたもの：手元が前回のままなら delete', () => {
    const j = run({ a: 'x' }, { a: 'x' }, [snap('B', 10, {})]);
    expect(j.actions).toEqual([{ id: 'a', op: 'delete', fromDeviceId: 'B', remoteSha256: null, localSha256: 'x' }]);
  });

  it('相手の目録から消えたもの：手元が前回から変わっていれば conflict', () => {
    const j = run({ a: 'y' }, { a: 'x' }, [snap('B', 10, {})]);
    expect(j.actions).toEqual([{ id: 'a', op: 'conflict', fromDeviceId: 'B', remoteSha256: null, localSha256: 'y' }]);
  });

  it('手元で消したもの：相手が前回のままなら何もしない（消した側が送る）', () => {
    const j = run({}, { a: 'x' }, [snap('B', 10, { a: 'x' })]);
    expect(j.actions).toEqual([]);
  });

  it('手元で消したもの：相手が変えていたら conflict（相手を採るか、消したままにするか）', () => {
    const j = run({}, { a: 'x' }, [snap('B', 10, { a: 'y' })]);
    expect(j.actions).toEqual([{ id: 'a', op: 'conflict', fromDeviceId: 'B', remoteSha256: 'y', localSha256: null }]);
  });

  it('どこにも無くなったものの共通の記録は捨てる', () => {
    const j = run({}, { a: 'x' }, [snap('B', 10, {})]);
    expect(j.forget).toEqual(['a']);
    expect(j.actions).toEqual([]);
  });

  it('相手が 1 台もいなければ何も判定しない', () => {
    const j = run({ a: 'x' }, { a: 'x', gone: 'z' }, []);
    expect(j).toEqual({ actions: [], agreed: new Map(), forget: [] });
  });

  describe('相手が 2 台以上のとき', () => {
    it('同じ項目は新しい束の方だけを見る（行き来で振動しない）', () => {
      const j = run({ a: 'x' }, { a: 'x' }, [snap('B', 10, { a: 'y' }), snap('C', 20, { a: 'z' })]);
      expect(j.actions).toEqual([{ id: 'a', op: 'overwrite', fromDeviceId: 'C', remoteSha256: 'z', localSha256: 'x' }]);
    });
    it('新しさが同じなら端末 ID の大きい方を採る（どの PC も同じ答えになる）', () => {
      const j = run({}, {}, [snap('B', 10, { a: 'y' }), snap('C', 10, { a: 'z' })]);
      expect(j.actions[0]!.fromDeviceId).toBe('C');
    });
    it('新しい束に無い項目は、古い束にあれば古い束のものを採る', () => {
      const j = run({}, {}, [snap('B', 10, { a: 'y' }), snap('C', 20, { b: 'z' })]);
      expect(j.actions.map((a) => [a.id, a.fromDeviceId])).toEqual([['a', 'B'], ['b', 'C']]);
    });
    it('1 台が消しても、別の 1 台がまだ持っているあいだは消さない', () => {
      const j = run({ a: 'x' }, { a: 'x' }, [snap('B', 10, { a: 'x' }), snap('C', 20, {})]);
      expect(j.actions).toEqual([]);
      expect(j.agreed.get('a')).toBe('x');
    });
    it('全員が持たなくなったら delete で、送り主は新しい束の PC', () => {
      const j = run({ a: 'x' }, { a: 'x' }, [snap('B', 10, {}), snap('C', 20, {})]);
      expect(j.actions).toEqual([{ id: 'a', op: 'delete', fromDeviceId: 'C', remoteSha256: null, localSha256: 'x' }]);
    });
  });

  it('actions は id の順に並ぶ', () => {
    const j = run({}, {}, [snap('B', 10, { c: '1', a: '2', b: '3' })]);
    expect(j.actions.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('競合で手元を採った値を、相手にそろえさせる（SM6）', () => {
  /** 相手の束の項目に、送り手が上書きして採った値の指紋（base）と、その決めた時刻（baseAt）を添える。 */
  const snapB = (deviceId: string, at: number, items: Record<string, { sha256: string; base?: string; baseAt?: number }>): RemoteSnapshot => ({ deviceId, at, items: new Map(Object.entries(items)) });

  it('相手が手元の値を超えて採った値なら、手元が変わっていても overwrite（conflict にしない）', () => {
    // 手元 W、前回の共通 X。相手は W を見たうえで M を採った（相手の基準が W）。
    const j = judge({ local: m({ a: 'W' }), base: m({ a: 'X' }), remotes: [snapB('B', 10, { a: { sha256: 'M', base: 'W', baseAt: 5 } })] });
    expect(j.actions).toEqual([{ id: 'a', op: 'overwrite', fromDeviceId: 'B', remoteSha256: 'M', localSha256: 'W' }]);
  });

  it('相手の基準が手元と違えば、これまでどおり conflict', () => {
    const j = judge({ local: m({ a: 'W' }), base: m({ a: 'X' }), remotes: [snapB('B', 10, { a: { sha256: 'M', base: 'Y', baseAt: 5 } })] });
    expect(ops(j)).toEqual({ a: 'conflict' });
  });

  it('両方が手元を採り合ったら、後に決めた側の値に 1 方向だけそろう', () => {
    // Mac（dev-a）は M を採り、基準を W にした（時刻 200）。Windows（dev-b）は W を採り、基準を M にした（時刻 100）。
    const mac = judge({ local: m({ a: 'M' }), base: m({ a: 'W' }), baseAt: new Map([['a', 200]]), localDeviceId: 'dev-a', remotes: [snapB('dev-b', 10, { a: { sha256: 'W', base: 'M', baseAt: 100 } })] });
    const win = judge({ local: m({ a: 'W' }), base: m({ a: 'M' }), baseAt: new Map([['a', 100]]), localDeviceId: 'dev-b', remotes: [snapB('dev-a', 10, { a: { sha256: 'M', base: 'W', baseAt: 200 } })] });
    expect(mac.actions).toEqual([]);
    expect(win.actions).toEqual([{ id: 'a', op: 'overwrite', fromDeviceId: 'dev-a', remoteSha256: 'M', localSha256: 'W' }]);
  });

  it('決めた時刻が同じなら、端末 ID の大きい側にそろう（両方が動いて入れ替わらない）', () => {
    const a = judge({ local: m({ a: 'M' }), base: m({ a: 'W' }), baseAt: new Map([['a', 100]]), localDeviceId: 'dev-a', remotes: [snapB('dev-b', 10, { a: { sha256: 'W', base: 'M', baseAt: 100 } })] });
    const b = judge({ local: m({ a: 'W' }), base: m({ a: 'M' }), baseAt: new Map([['a', 100]]), localDeviceId: 'dev-b', remotes: [snapB('dev-a', 10, { a: { sha256: 'M', base: 'W', baseAt: 100 } })] });
    expect(ops(a)).toEqual({ a: 'overwrite' });
    expect(b.actions).toEqual([]);
  });
});
