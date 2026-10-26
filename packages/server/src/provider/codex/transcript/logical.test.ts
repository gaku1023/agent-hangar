import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_ONE_TURN, fixtureBytes, makeCodexHome, putRollout } from '../../../../test/codexFixtures.ts';
import { openLogicalBody, readHeadLine, readLogicalLines, readLogicalWhole, resolvePhysical, statLogical } from './logical.ts';

let home: string;
beforeEach(() => { home = makeCodexHome(); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const plain = () => fixtureBytes(CODEX_ONE_TURN.file);
const zst = () => fixtureBytes(`${CODEX_ONE_TURN.file}.zst`);

describe('論理パスと物理パス', () => {
  it('.jsonl があればそれ、無ければ .jsonl.zst、両方あれば .jsonl を正とする。どちらも無ければ null', () => {
    const logical = `${home}/rollout-a.jsonl`;
    expect(resolvePhysical(logical)).toBeNull();
    putRollout(home, 'rollout-a.jsonl.zst', zst());
    expect(resolvePhysical(logical)).toEqual({ path: `${logical}.zst`, compressed: true });
    putRollout(home, 'rollout-a.jsonl', plain());
    expect(resolvePhysical(logical)).toEqual({ path: logical, compressed: false });
  });

  it('stat は物理ファイルのもの（zst の大きさ）を返す', () => {
    const logical = `${home}/rollout-a.jsonl`;
    expect(statLogical(logical)).toBeNull();
    putRollout(home, 'rollout-a.jsonl.zst', zst());
    expect(statLogical(logical)?.size).toBe(zst().length);
  });

  it('.jsonl を .jsonl.zst に置き換えても、展開後の長さから読むと 0 行で終わり、reset は立たない', () => {
    const logical = `${home}/rollout-a.jsonl`;
    putRollout(home, 'rollout-a.jsonl', plain());
    const first = readLogicalLines(logical, 0);
    expect(first.lines.length).toBeGreaterThan(5);
    expect(first.nextByte).toBe(plain().length);
    fs.rmSync(logical);
    putRollout(home, 'rollout-a.jsonl.zst', zst());
    const again = readLogicalLines(logical, first.nextByte);
    expect(again).toMatchObject({ lines: [], nextByte: first.nextByte, reset: false });
  });

  it('zst の中身は、バイト位置で切って読める。plain と同じ行が同じ位置で出る', () => {
    putRollout(home, 'p.jsonl', plain());
    putRollout(home, 'z.jsonl.zst', zst());
    const a = readLogicalLines(`${home}/p.jsonl`, 0);
    const b = readLogicalLines(`${home}/z.jsonl`, 0);
    expect(b.lines).toEqual(a.lines);
    const mid = a.lines[10]!.offset;
    expect(readLogicalLines(`${home}/z.jsonl`, mid).lines).toEqual(a.lines.slice(10));
  });

  it('展開後の長さが from より短いとき（作り直し）は、先頭から読み直して reset を立てる', () => {
    putRollout(home, 'z.jsonl.zst', zst());
    const r = readLogicalLines(`${home}/z.jsonl`, plain().length + 100);
    expect(r.reset).toBe(true);
    expect(r.lines[0]!.offset).toBe(0);
  });

  it('展開した版に行を足した .jsonl に戻ったとき、続きだけが読める', () => {
    const extra = Buffer.from('{"timestamp":"2026-10-26T05:10:00.000Z","type":"event_msg","payload":{"type":"task_started"}}\n');
    putRollout(home, 'rollout-a.jsonl', Buffer.concat([plain(), extra]));
    const r = readLogicalLines(`${home}/rollout-a.jsonl`, plain().length);
    expect(r.lines).toHaveLength(1);
    expect(r.reset).toBe(false);
  });

  it('展開のキャッシュは 2 件を超えても正しい（3 本を順に読んで、最初のものをもう一度読む）', () => {
    for (const n of ['a', 'b', 'c']) putRollout(home, `${n}.jsonl.zst`, zst());
    const read = (n: string) => readLogicalLines(`${home}/${n}.jsonl`, 0).lines.length;
    const expected = read('a');
    expect([read('b'), read('c'), read('a')]).toEqual([expected, expected, expected]);
  });

  it('壊れた zst は投げる（束を作らない。呼び手が error に出す）', () => {
    putRollout(home, 'bad.jsonl.zst', Buffer.from('this is not zstd'));
    expect(() => readLogicalLines(`${home}/bad.jsonl`, 0)).toThrow();
  });

  it('先頭の 1 行（session_meta）と、全体と、ページ用の口が zst でも読める', () => {
    putRollout(home, 'p.jsonl', plain());
    putRollout(home, 'z.jsonl.zst', zst());
    expect(readHeadLine(`${home}/z.jsonl`)).toBe(readHeadLine(`${home}/p.jsonl`));
    expect(JSON.parse(readHeadLine(`${home}/p.jsonl`)!).type).toBe('session_meta');
    expect(readLogicalWhole(`${home}/z.jsonl`).equals(plain())).toBe(true);
    const lines = readLogicalLines(`${home}/z.jsonl`, 0).lines;
    const body = openLogicalBody(`${home}/z.jsonl`);
    try { expect(body.read(lines[3]!.offset, lines[3]!.length).toString('utf8')).toBe(lines[3]!.text); } finally { body.close(); }
  });
});
