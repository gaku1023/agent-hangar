import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { SyncStateStore } from './state.ts';
import { D1_WRITES_PER_CHANGE, D1_WRITES_PER_CHANGE_ROW, D1_WRITES_PER_DEVICE_TOUCH, D1_WRITES_PER_METER_NOTE, D1_WRITES_PER_MIRROR_ROW, D1_WRITES_PER_PULL, QUOTA_LIMITS, QUOTA_STOP_RATIO, QuotaCounter, pushD1Writes, quotaDayKey } from './quota.ts';

let db: Db;
let state: SyncStateStore;
let now = Date.UTC(2026, 8, 19, 10, 0, 0);

const make = (limits?: { d1Writes: number; requests: number }, ratio?: number, deviceCount?: () => number) =>
  new QuotaCounter({ state, now: () => now, limits, ratio, deviceCount });

/** sync_state の行を直に読む。quota の鍵は SyncStateKey の外なので、包みを通さずに見る。 */
const raw = (key: string): string | null =>
  ((db.prepare('select value from sync_state where key = ?').get(key) as { value: string } | undefined)?.value ?? null);

const putRaw = (key: string, value: string): void => {
  db.prepare('insert into sync_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
};

beforeEach(() => {
  db = openDb(':memory:');
  state = new SyncStateStore(db);
  now = Date.UTC(2026, 8, 19, 10, 0, 0);
});

describe('QuotaCounter', () => {
  it('既定の上限と止める割合は無料枠に合わせてある', () => {
    expect(QUOTA_LIMITS).toEqual({ d1Writes: 100_000, requests: 100_000 });
    expect(QUOTA_STOP_RATIO).toBe(0.8);
  });

  it('同じ日の分を足し合わせ、sync_state に残す', () => {
    const q = make();
    q.note({ rows: 10, requests: 1 });
    q.note({ rows: 5, requests: 1 });
    q.note({ requests: 1 });
    expect(q.today()).toEqual({ rows: 15, requests: 3 });

    // 別のインスタンスから読み直せる（サーバを立て直しても数えが続く）。
    expect(make().today()).toEqual({ rows: 15, requests: 3 });
    expect(raw(quotaDayKey(now))).toBe('{"rows":15,"requests":3}');
  });

  it('日付が変われば 0 から数え直し、前の日の行は消える', () => {
    const q = make();
    q.note({ rows: 10, requests: 1 });
    const yesterday = quotaDayKey(now);

    now += 86_400_000;
    expect(q.today()).toEqual({ rows: 0, requests: 0 });
    q.note({ rows: 2, requests: 1 });
    expect(q.today()).toEqual({ rows: 2, requests: 1 });
    expect(raw(yesterday)).toBeNull();
  });

  it('日付は UTC で区切る（Cloudflare の枠が戻るのと同じ境目）', () => {
    expect(quotaDayKey(Date.UTC(2026, 8, 19, 23, 59, 59))).toBe('quota:2026-09-19');
    expect(quotaDayKey(Date.UTC(2026, 8, 20, 0, 0, 0))).toBe('quota:2026-09-20');
  });

  it('行数が上限の 80% に達したら exceeded になる', () => {
    const q = make({ d1Writes: 10, requests: 1000 });
    q.note({ rows: 7, requests: 1 });
    expect(q.exceeded()).toBe(false);
    q.note({ rows: 1, requests: 1 });
    expect(q.today()).toEqual({ rows: 8, requests: 2 });
    expect(q.exceeded()).toBe(true);

    now += 86_400_000;
    expect(q.exceeded()).toBe(false);
  });

  it('要求の回数だけでも 80% に達したら exceeded になる', () => {
    const q = make({ d1Writes: 1_000_000, requests: 10 });
    for (let i = 0; i < 7; i++) q.note({ requests: 1 });
    expect(q.exceeded()).toBe(false);
    q.note({ requests: 1 });
    expect(q.exceeded()).toBe(true);
  });

  it('枠はアカウント全体のものなので、端末の数で割る', () => {
    // 1 台なら今までどおり 80%。
    expect(make({ d1Writes: 1_000, requests: 1_000 }).stopAt()).toEqual({ d1Writes: 800, requests: 800 });
    // 2 台なら 1 台あたり 40%。合わせて 80% である。
    expect(make({ d1Writes: 1_000, requests: 1_000 }, undefined, () => 2).stopAt()).toEqual({ d1Writes: 400, requests: 400 });
    expect(make({ d1Writes: 1_000, requests: 1_000 }, undefined, () => 4).stopAt()).toEqual({ d1Writes: 200, requests: 200 });
  });

  it('2 台なら自分のぶんが半分に達した時点で止める', () => {
    const q = make({ d1Writes: 1_000, requests: 1_000_000 }, undefined, () => 2);
    q.note({ rows: 399 });
    expect(q.exceeded()).toBe(false);
    q.note({ rows: 1 });
    expect(q.exceeded()).toBe(true);
  });

  it('端末の数が読めないときは 1 台として扱う', () => {
    for (const n of [0, -1, Number.NaN, 0.5]) {
      expect(make({ d1Writes: 1_000, requests: 1_000 }, undefined, () => n).stopAt().d1Writes).toBe(800);
    }
    // 台数が増えれば、割り当ては減るだけで増えることはない。
    expect(make({ d1Writes: 1_000, requests: 1_000 }, undefined, () => 3).stopAt().d1Writes).toBeCloseTo(266.67, 1);
  });

  it('割合は差し替えられる', () => {
    const q = make({ d1Writes: 100, requests: 100 }, 0.5);
    q.note({ rows: 49 });
    expect(q.exceeded()).toBe(false);
    q.note({ rows: 1 });
    expect(q.exceeded()).toBe(true);
  });

  it('手で書き換えられた値や壊れた値は 0 として読む', () => {
    putRaw(quotaDayKey(now), 'not json');
    const q = make();
    expect(q.today()).toEqual({ rows: 0, requests: 0 });
    q.note({ rows: 3, requests: 1 });
    expect(q.today()).toEqual({ rows: 3, requests: 1 });

    putRaw(quotaDayKey(now), '{"rows":"たくさん","requests":null}');
    expect(q.today()).toEqual({ rows: 0, requests: 0 });
  });

  it('負の値や小数を渡されても数えを壊さない', () => {
    const q = make();
    q.note({ rows: -5, requests: -1 });
    expect(q.today()).toEqual({ rows: 0, requests: 0 });
    q.note({ rows: 1.7, requests: 1 });
    expect(q.today()).toEqual({ rows: 1, requests: 1 });
  });
});

describe('pushD1Writes', () => {
  it('Worker が採った 1 行につき 5 行、要求ごとに devices の 1 行と台帳の 2 行を数える', () => {
    expect(D1_WRITES_PER_CHANGE_ROW).toBe(3);
    expect(D1_WRITES_PER_MIRROR_ROW).toBe(2);
    expect(D1_WRITES_PER_CHANGE).toBe(5);
    expect(D1_WRITES_PER_DEVICE_TOUCH).toBe(1);
    expect(D1_WRITES_PER_METER_NOTE).toBe(2);
    // 40 行なら 5*40 + 1 + 2 である。
    expect(pushD1Writes(40, 40)).toBe(203);
    expect(pushD1Writes(1, 1)).toBe(8);
  });

  it('pull 1 回は devices の 1 行と台帳の 2 行である', () => {
    expect(D1_WRITES_PER_PULL).toBe(3);
  });

  it('同着で弾かれた行は数えない', () => {
    // 40 行送って 1 行も採られなくても、devices の 1 行と台帳の 2 行は必ず書かれる。
    expect(pushD1Writes(0, 40)).toBe(3);
    expect(pushD1Writes(10, 40)).toBe(53);
  });

  it('accepted が読めない応答では、送った行数で代用する', () => {
    expect(pushD1Writes(undefined, 10)).toBe(53);
    expect(pushD1Writes(null, 10)).toBe(53);
    expect(pushD1Writes('たくさん', 10)).toBe(53);
    expect(pushD1Writes(-1, 10)).toBe(53);
    expect(pushD1Writes(Number.NaN, 10)).toBe(53);
  });

  it('Task 25 の実測 369 行は、いまの内訳でも説明が付く', () => {
    // Task 25 の実測。2 台を 1 日動かして、採られた行 74、devices を触る要求 73 で 369 行だった。
    // 当時はこれを「changes 2 行 + 鏡 2 行」と読んでいたが、その読みは決着していなかった。
    // 74 * 4 + 73 = 369 になる内訳は 2 通りあり、この測りでは区別が付かない。
    //   旧: changes の insert 2 行 + 鏡の insert 2 行
    //   新: changes の insert 3 行（sqlite_sequence を含む）+ 鏡の **update** 1 行
    // 当時は同じ行を何度も押し直していたので、鏡はほとんどが update（索引が動かないので 1 行）だった。
    // どちらかを決めたのは 2026-09-20 の実物の突き合わせで、changes の insert は 3 行だった。
    const accepted = 74;
    const deviceTouches = 73;
    const mirrorUpdate = 1; // 既にある鍵を書き換えるだけなら k の索引は動かない。
    expect(accepted * (D1_WRITES_PER_CHANGE_ROW + mirrorUpdate) + deviceTouches * D1_WRITES_PER_DEVICE_TOUCH).toBe(369);
    // 当時の Worker には台帳がまだ無かったので、この 369 に台帳の分は入っていない。
  });
});

/**
 * 勘定の根拠は Worker のスキーマである。
 * 表に索引が増えれば rows_written も増えるので、数えだけ古いまま残らないようにここで縛る。
 * schema.ts は読むだけで、書き換えない。
 */
describe('D1 の書き込みの勘定は Worker のスキーマから出す', () => {
  const schema = fs.readFileSync(new URL('../../../cloud/src/schema.ts', import.meta.url), 'utf8');
  const createTable = (t: string): string => {
    const m = schema.match(new RegExp(`create table if not exists ${t} \\(([\\s\\S]*?)\\)'`));
    if (!m?.[1]) throw new Error(`${t} の create table が見つからない`);
    return m[1];
  };
  /** 明示の create index の数。 */
  const explicitIndexes = (t: string): string[] =>
    [...schema.matchAll(/create index if not exists (\w+) on (\w+)\(([^)]*)\)/g)].filter((m) => m[2] === t).map((m) => m[1]!);
  /** SQLite が自分で張る索引の数。integer primary key は rowid そのものなので索引を作らない。 */
  const implicitIndexes = (t: string): number => {
    const body = createTable(t);
    const pk = /integer primary key/.test(body) ? 0 : /primary key/.test(body) ? 1 : 0;
    return pk + (body.match(/ unique/g) ?? []).length;
  };
  /**
   * `autoincrement` の表は、insert のたびに SQLite が内部の `sqlite_sequence` の 1 行も書き換える。
   * delete では動かないので、数えるのは insert のときだけである。
   */
  const sequenceRow = (t: string): number => (/autoincrement/.test(createTable(t)) ? 1 : 0);
  /**
   * insert 1 行が rows_written を進める行数。
   * 本体 1 行に、触れた索引ごとに 1 行、`autoincrement` なら `sqlite_sequence` の 1 行である。
   */
  const insertCost = (t: string): number => 1 + explicitIndexes(t).length + implicitIndexes(t) + sequenceRow(t);

  /**
   * **`changes.seq` から `autoincrement` が消えたら、ここで落ちる。**
   * 消えれば 1 行の費用が 3 から 2 に下がるので、定数もいっしょに下げないと多く数えたままになる。
   * 逆に、`autoincrement` を足した表の定数を上げ忘れると `insertCost` の比較で落ちる。
   */
  it('changes の seq は autoincrement なので sqlite_sequence の 1 行が乗る', () => {
    expect(/seq integer primary key autoincrement/.test(createTable('changes'))).toBe(true);
    expect(sequenceRow('changes')).toBe(1);
    // 索引だけで数えると 2 行にしかならない。実物の D1 は 3 行と申告する（2026-09-20 の突き合わせ）。
    expect(1 + explicitIndexes('changes').length + implicitIndexes('changes')).toBe(2);
  });

  it('changes への insert は本体と changes_device と sqlite_sequence で 3 行である', () => {
    expect(explicitIndexes('changes')).toEqual(['changes_device']);
    expect(implicitIndexes('changes')).toBe(0);   // seq integer primary key は rowid
    expect(insertCost('changes')).toBe(D1_WRITES_PER_CHANGE_ROW);
    expect(insertCost('changes')).toBe(3);
  });

  it('rows の upsert は本体と k の暗黙の索引で 2 行である', () => {
    expect(explicitIndexes('rows')).toEqual([]);
    expect(implicitIndexes('rows')).toBe(1);      // k text primary key
    expect(sequenceRow('rows')).toBe(0);          // k text primary key に autoincrement は無い
    expect(insertCost('rows')).toBe(D1_WRITES_PER_MIRROR_ROW);
  });

  it('devices の last_seen_at と last_pulled_seq はどの索引にも載らないので 1 行である', () => {
    const body = createTable('devices');
    for (const col of ['last_seen_at', 'last_pulled_seq']) {
      expect(explicitIndexes('devices').length).toBe(0);
      // 主キーでも unique でもない列なので、update しても索引は動かない。
      expect(new RegExp(`${col}[^,]*(primary key|unique)`).test(body)).toBe(false);
    }
    expect(D1_WRITES_PER_DEVICE_TOUCH).toBe(1);
  });

  /**
   * 台帳の 1 文の費用は Worker 側の `META_ROWS_PER_NOTE` が決めている。
   * 片方だけ動かすと、端末の見積もりが黙ってずれる。
   */
  it('台帳の 1 文の費用は Worker の META_ROWS_PER_NOTE と揃っている', () => {
    const meter = fs.readFileSync(new URL('../../../cloud/src/meter.ts', import.meta.url), 'utf8');
    const m = meter.match(/META_ROWS_PER_NOTE = (\d+)/);
    expect(m?.[1]).toBeDefined();
    expect(Number(m![1])).toBe(D1_WRITES_PER_METER_NOTE);
  });
});
