import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { D1_ROWS, FakeCloudClient, SWEEP_EVERY_MS } from './fake-cloud.ts';

/**
 * 偽物が数える「D1 へ書いた行数」を、実物の Worker の原本から縛る。
 *
 * 実物は見積もらない。D1 が申告する `rows_written` をそのまま積む（`packages/cloud/src/meter.ts`）。
 * 申告してくれる D1 がいない偽物は、スキーマから出した表を持つしかない。
 * ここでスキーマを読んで縛っておけば、索引が 1 つ増えたときに偽物だけ古いまま残らない。
 */

const read = (rel: string): string => fs.readFileSync(new URL(`../../cloud/src/${rel}`, import.meta.url), 'utf8');

const schema = read('schema.ts');

const createTable = (t: string): string => {
  const m = schema.match(new RegExp(`create table if not exists ${t} \\(([\\s\\S]*?)\\)'`));
  if (!m?.[1]) throw new Error(`${t} の create table が見つからない`);
  return m[1];
};

/** 表に張られた索引の数。明示の create index と、主キーと unique に SQLite が自分で張るもの。 */
const indexes = (t: string): number => {
  const body = createTable(t);
  const explicit = [...schema.matchAll(/create index if not exists (\w+) on (\w+)\(([^)]*)\)/g)].filter((m) => m[2] === t).length;
  // seq integer primary key は rowid そのものなので索引を増やさない。
  const pk = /integer primary key/.test(body) ? 0 : /primary key/.test(body) ? 1 : 0;
  return explicit + pk + (body.match(/ unique/g) ?? []).length;
};

/** autoincrement の表は insert のたびに sqlite_sequence の 1 行も動かす（delete では動かない）。 */
const sequenceRow = (t: string): number => (/autoincrement/.test(createTable(t)) ? 1 : 0);

/**
 * insert 1 行が進める行数。本体 1 行に、触れた索引ごとに 1 行、autoincrement の連番が 1 行である。
 * `changes` も `files` も同じ扱いにする（片方だけ連番を足すのは筋が通らない）。
 */
const insertCost = (t: string): number => 1 + indexes(t) + sequenceRow(t);

describe('偽物が数える行数は、実物のスキーマと実測から出す', () => {
  it('changes と鏡と devices の 1 行ぶん', () => {
    expect(D1_ROWS.changeInsert).toBe(insertCost('changes'));
    expect(D1_ROWS.mirrorUpsert).toBe(insertCost('rows'));
    // devices の last_seen_at も last_pulled_seq も、主キーでも unique でもない。
    const body = createTable('devices');
    for (const col of ['last_seen_at', 'last_pulled_seq']) expect(new RegExp(`${col}[^,]*(primary key|unique)`).test(body)).toBe(false);
    expect(D1_ROWS.deviceTouch).toBe(1);
  });

  it('files の 1 行ぶん', () => {
    expect(D1_ROWS.fileInsert).toBe(insertCost('files'));
    // delete は本体の 1 行だけである。索引も連番も動かないことを、実物の D1（miniflare）で測った
    // （`packages/cloud/test/meter.test.ts` の「ファイルの出し入れが D1 に書く行数」）。
    expect(D1_ROWS.fileDelete).toBe(1);
  });

  it('掃除の間隔は、実物の Worker の定数をそのまま読む', () => {
    const sweep = read('sweep.ts');
    const every = /export const SWEEP_EVERY_MS = ([0-9*\s_]+);/.exec(sweep)?.[1];
    expect(every).toBeDefined();
    expect(SWEEP_EVERY_MS).toBe(every!.split('*').reduce((a, b) => a * Number(b.trim().replace(/_/g, '')), 1));
    // 掃除が走る回の実費は 10 行である（`packages/cloud/test/meter.test.ts` が実物に対して上限を縛る）。
    expect(D1_ROWS.sweep).toBe(10);
  });

  it('台帳の 1 文は、実物の Worker の定数をそのまま読む', () => {
    const meter = read('meter.ts');
    const perNote = Number(/export const META_ROWS_PER_NOTE = (\d+);/.exec(meter)?.[1]);
    expect(perNote).toBeGreaterThan(0);
    expect(D1_ROWS.note).toBe(perNote);
    // 実物は書き込みのある要求ごとに 1 回だけ台帳へ書く。持ち越しはしない（isolate が入れ替わっても消えない）。
    expect(meter).not.toContain('FLUSH_ROWS');
  });
});

describe('偽物の push の応答', () => {
  it('その日に D1 へ書いた行数を返す', async () => {
    const now = { v: Date.UTC(2026, 8, 20, 1, 0, 0) };
    const a = new FakeCloudClient({ deviceId: 'a', now: () => now.v });
    const ch = (rowId: string, updatedAt: number) => ({ tableName: 'projects' as const, rowId, op: 'upsert' as const, payload: { id: rowId }, updatedAt });
    const r1 = await a.pushChanges([ch('p1', 1), ch('p2', 1)]);
    expect(r1.d1RowsToday).toBe(2 * (D1_ROWS.changeInsert + D1_ROWS.mirrorUpsert) + D1_ROWS.deviceTouch + D1_ROWS.note);
    // 同着で弾かれた行は 1 行も書かないので、devices の 1 行しか増えない（台帳の 1 文は付く）。
    const r2 = await a.pushChanges([ch('p1', 1)]);
    expect(r2.d1RowsToday! - r1.d1RowsToday!).toBe(D1_ROWS.deviceTouch + D1_ROWS.note);
    // 他端末の書き込みも同じ台帳に載る（無料枠はアカウントごとだからである）。
    const b = a.asDevice('b');
    const r3 = await b.pushChanges([ch('p3', 1)]);
    expect(r3.d1RowsToday! - r2.d1RowsToday!).toBe(D1_ROWS.changeInsert + D1_ROWS.mirrorUpsert + D1_ROWS.deviceTouch + D1_ROWS.note);
    // pull も devices を 1 行書く。
    await b.pullChanges(0, 500);
    expect(b.d1RowsToday() - r3.d1RowsToday!).toBe(D1_ROWS.deviceTouch + D1_ROWS.note);
    // 日付が変われば 0 から数え直す。
    now.v += 86_400_000;
    expect(a.d1RowsToday()).toBe(0);
  });
});
