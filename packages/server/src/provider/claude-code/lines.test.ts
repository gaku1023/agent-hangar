import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNewLines } from './lines.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readNewLines', () => {
  it('行ごとのバイト位置と長さを返し、末尾の断片は次回に回す', () => {
    const f = path.join(dir, 'a.jsonl');
    fs.writeFileSync(f, '{"a":1}\n{"b":"日本語"}\n{"c":');
    const r = readNewLines(f, 0);
    expect(r.reset).toBe(false);
    expect(r.lines.map((l) => l.text)).toEqual(['{"a":1}', '{"b":"日本語"}']);
    expect(r.lines[0]).toMatchObject({ offset: 0, length: 7 });
    expect(r.lines[1]!.offset).toBe(8);
    expect(r.lines[1]!.length).toBe(Buffer.byteLength('{"b":"日本語"}'));
    expect(r.nextByte).toBe(8 + r.lines[1]!.length + 1);
    // 断片を完成させると、そこから 1 行だけ返る
    fs.appendFileSync(f, '3}\n');
    const r2 = readNewLines(f, r.nextByte);
    expect(r2.lines.map((l) => l.text)).toEqual(['{"c":3}']);
    expect(r2.nextByte).toBe(fs.statSync(f).size);
  });
  it('バイト位置から読み直すと同じ行が得られる', () => {
    const f = path.join(dir, 'b.jsonl');
    fs.writeFileSync(f, 'x\n{"k":"値"}\n');
    const l = readNewLines(f, 0).lines[1]!;
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(l.length);
    fs.readSync(fd, buf, 0, l.length, l.offset);
    fs.closeSync(fd);
    expect(buf.toString('utf8')).toBe('{"k":"値"}');
  });
  it('空行は返さない', () => {
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(f, '\n\n{"a":1}\n\n');
    expect(readNewLines(f, 0).lines).toHaveLength(1);
  });
  it('ファイルが短くなっていたら reset を立てて先頭から読む', () => {
    const f = path.join(dir, 'd.jsonl');
    fs.writeFileSync(f, '{"a":1}\n');
    const r = readNewLines(f, 100);
    expect(r.reset).toBe(true);
    expect(r.lines).toHaveLength(1);
  });
  it('追記が無ければ空', () => {
    const f = path.join(dir, 'e.jsonl');
    fs.writeFileSync(f, '{"a":1}\n');
    const r = readNewLines(f, 8);
    expect(r.lines).toEqual([]);
    expect(r.nextByte).toBe(8);
  });
});
