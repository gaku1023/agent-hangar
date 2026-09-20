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
