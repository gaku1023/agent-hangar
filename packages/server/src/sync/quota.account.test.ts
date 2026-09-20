import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { QuotaCounter, quotaDayKey } from './quota.ts';
import { SyncStateStore } from './state.ts';

/**
 * Worker が返す「その日に D1 へ書いた行数」を正として使う側の試験である。
 * 見積もりの側（端末の数で割る代用）は quota.test.ts が縛っているので、ここでは触らない。
 */

let db: Db;
let state: SyncStateStore;
let now = Date.UTC(2026, 8, 20, 10, 0, 0);

const make = (limits?: { d1Writes: number; requests: number }, deviceCount?: () => number) =>
  new QuotaCounter({ state, now: () => now, limits, deviceCount });

beforeEach(() => {
  db = openDb(':memory:');
  state = new SyncStateStore(db);
  now = Date.UTC(2026, 8, 20, 10, 0, 0);
});

describe('Worker が返した行数を正として使う', () => {
  it('アカウント全体の数なので、端末の数で割らない', () => {
    const q = make({ d1Writes: 1_000, requests: 1_000_000 }, () => 2);
    // 見積もりだけなら 2 台で 400 が止め水準である。
    q.note({ rows: 500 });
    expect(q.exceeded()).toBe(true);
    // Worker が「アカウント全体でまだ 500 行」と言えば、止め水準は 800 に戻る。
    q.note({ account: 500 });
    expect(q.d1()).toEqual({ rows: 500, stop: 800, authoritative: true });
    expect(q.exceeded()).toBe(false);
    q.note({ account: 800 });
    expect(q.exceeded()).toBe(true);
  });

  it('報告の後に自分で書いた分は、報告に足して見る', () => {
    const q = make({ d1Writes: 1_000, requests: 1_000_000 });
    q.note({ rows: 100, account: 700 });
    expect(q.d1().rows).toBe(700);
    // 次の報告が来るまでのファイルの出し入れと pull は、手元の見積もりで足していく。
    q.note({ rows: 50 });
    expect(q.d1().rows).toBe(750);
    expect(q.exceeded()).toBe(false);
    q.note({ rows: 50 });
    expect(q.d1().rows).toBe(800);
    expect(q.exceeded()).toBe(true);
    // 新しい報告が来たら、足し込みはそこからやり直す（二重に数えない）。
    q.note({ rows: 5, account: 820 });
    expect(q.d1().rows).toBe(820);
  });

  it('返ってこない応答では、今までどおり端末の数で割った見積もりで見る', () => {
    const q = make({ d1Writes: 1_000, requests: 1_000_000 }, () => 2);
    q.note({ rows: 399 });
    expect(q.d1()).toEqual({ rows: 399, stop: 400, authoritative: false });
    expect(q.exceeded()).toBe(false);
    q.note({ rows: 1 });
    expect(q.exceeded()).toBe(true);
  });

  it('後から届いた古い報告では数えを下げない', () => {
    const q = make({ d1Writes: 1_000, requests: 1_000_000 });
    q.note({ account: 700 });
    q.note({ account: 300 });
    expect(q.d1().rows).toBe(700);
    // 読めない値も同じで、いまの数えをそのまま残す。
    q.note({ account: Number.NaN });
    q.note({ account: -5 });
    expect(q.d1().rows).toBe(700);
  });

  it('日付が変われば報告も 0 から数え直す', () => {
    const q = make({ d1Writes: 1_000, requests: 1_000_000 });
    q.note({ rows: 10, account: 900 });
    expect(q.exceeded()).toBe(true);
    now += 86_400_000;
    expect(q.d1()).toEqual({ rows: 0, stop: 800, authoritative: false });
    expect(q.exceeded()).toBe(false);
  });

  it('要求の回数は Worker が数えていないので、今までどおり端末の数で割る', () => {
    const q = make({ d1Writes: 1_000_000, requests: 1_000 }, () => 2);
    q.note({ account: 10 });
    for (let i = 0; i < 399; i++) q.note({ requests: 1 });
    expect(q.exceeded()).toBe(false);
    q.note({ requests: 1 });
    expect(q.exceeded()).toBe(true);
  });

  it('報告は sync_state に残るので、立て直しても続く', () => {
    const q = make({ d1Writes: 1_000, requests: 1_000_000 });
    q.note({ rows: 10, account: 790 });
    const again = make({ d1Writes: 1_000, requests: 1_000_000 });
    expect(again.d1()).toEqual({ rows: 790, stop: 800, authoritative: true });
  });
});

describe('報告が壊れていても、見積もりを捨てない（レビューの致命 1）', () => {
  it('報告が届いても、積み上げてきた見積もりを捨てない', () => {
    const q = make({ d1Writes: 1_000, requests: 1_000_000 });
    // 毎回同じ小さい値を報告する Worker（台帳が isolate ごとに消えていた頃の姿）。
    for (let i = 0; i < 100; i++) q.note({ rows: 10, requests: 1, account: 201 });
    // 手元の積み上げは 1,000 行。報告の 201 に貼り付いてはいけない。
    expect(q.today().rows).toBe(1_000);
    // 見張りが見るのは、最初に受けた報告（201）に自分の書き込みを積み上げた数である。
    // 端末から見えない経路の分（スキーマの用意と参加）が報告に入っているので、見積もりより少し大きい。
    expect(q.d1().rows).toBe(201 + 10 * 99);
    expect(q.d1().rows).toBeGreaterThan(1_000);
    expect(q.exceeded()).toBe(true);
  });

  it('報告が自分の見積もりより小さいときは、止め水準を端末の数で割った方に落とす', () => {
    const q = make({ d1Writes: 1_000, requests: 1_000_000 }, () => 2);
    // 報告はこの端末自身の書き込みも含むので、自分の見積もりを下回ることはない。
    // 下回るなら、その報告は当てにできない。当てにできないときは、直す前と同じ割り当てで見る。
    q.note({ rows: 500, account: 100 });
    expect(q.d1()).toEqual({ rows: 500, stop: 400, authoritative: false });
    expect(q.exceeded()).toBe(true);
  });

  /**
   * 裁定 3 の実測である。
   * レビュアと同じ条件（isolate が毎回入れ替わる、報告が小さい）で、旧方式と新方式のどちらが先に止まるかを数える。
   *
   * 1 回の push は 40 行を採る。
   * Worker が実際に書くのは、採った 1 行につき 5 行（changes 3 + 鏡 2）と要求ごとの devices 1 行、
   * それに台帳の 1 文（2 行）で、合わせて 203 行である（miniflare で実測した数である）。
   * 端末の見積もりは 1 行につき 4 行と devices の 1 行で 161 行である。
   * **見積もりは実際より 2 割ほど少ない。** これが旧方式の穴である。
   */
  it('実際に書かれた行数で見て、旧方式より早く止まる', () => {
    const run = (devices: number, report: (actual: number) => number | undefined) => {
      const q = new QuotaCounter({ state: new SyncStateStore(openDb(':memory:')), now: () => now, limits: { d1Writes: 100_000, requests: 10_000_000 }, deviceCount: () => devices });
      let actual = 0;
      let steps = 0;
      while (!q.exceeded() && steps < 10_000) {
        steps++;
        actual += 40 * 5 + 1 + 2;
        q.note({ rows: 40 * 4 + 1, requests: 1, account: report(actual) });
      }
      return actual;
    };
    const FREE = 100_000;
    // 1 台のとき。旧方式は見積もりが 2 割少ないぶん、無料枠を越えてから止まる。
    const oldOne = run(1, () => undefined);
    const newOne = run(1, (a) => a);
    expect(oldOne).toBeGreaterThan(FREE);       // 枠を越えている
    expect(newOne).toBeLessThan(FREE);          // 越えない
    expect(newOne).toBeLessThan(oldOne);        // 旧方式より早く止まる
    expect(newOne).toBeGreaterThan(FREE * 0.75);

    // 報告が固まったとき（レビュアの筋）。旧方式と同じところで止まり、遅くなることはない。
    const frozenTwo = run(2, () => 201);
    const oldTwo = run(2, () => undefined);
    expect(frozenTwo).toBe(oldTwo);
    expect(frozenTwo).toBeLessThan(FREE);
  });
});

describe('無料枠で止めた日', () => {
  it('sync_state に残るので、立て直しても同じ日に止め直さない', () => {
    const q = make();
    expect(q.pausedDay()).toBeNull();
    const day = quotaDayKey(now);
    q.setPausedDay(day);
    expect(make().pausedDay()).toBe(day);
    // 日付が変われば、その日はまた 1 度だけ止められる。
    now += 86_400_000;
    expect(make().pausedDay()).not.toBe(quotaDayKey(now));
  });

  it('日ごとの数えを消す掃除で、止めた日の記憶は消えない', () => {
    const q = make();
    q.note({ rows: 1 });
    q.setPausedDay(quotaDayKey(now));
    now += 86_400_000;
    q.note({ rows: 1 });   // ここで前の日の行を消す
    expect(q.pausedDay()).toBe(quotaDayKey(now - 86_400_000));
  });
});
