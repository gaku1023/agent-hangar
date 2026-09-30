import { describe, expect, it } from 'vitest';
import { diffLines, JsonTextEditError, setTopLevelNumber } from './jsonTextEdit.ts';

const K = 'cleanupPeriodDays';

describe('setTopLevelNumber', () => {
  it('空とファイルが無いときは、キー 1 つのオブジェクトを書く', () => {
    expect(setTopLevelNumber('', K, 365)).toBe('{\n  "cleanupPeriodDays": 365\n}\n');
    expect(setTopLevelNumber('{}', K, 365)).toBe('{\n  "cleanupPeriodDays": 365\n}\n');
    expect(setTopLevelNumber('  {\n}\n', K, 365)).toBe('{\n  "cleanupPeriodDays": 365\n}\n');
  });
  it('キーがあれば、値の数字だけを置き換える', () => {
    const src = '{\n  "a" : 1,\n  "cleanupPeriodDays" : 3650,\n  "z" : true\n}\n';
    expect(setTopLevelNumber(src, K, 365)).toBe('{\n  "a" : 1,\n  "cleanupPeriodDays" : 365,\n  "z" : true\n}\n');
  });
  it('キーが無ければ、最初のメンバーの前に同じ字下げと区切りで 1 行を差し込む', () => {
    expect(setTopLevelNumber('{\n  "a" : 1\n}\n', K, 365)).toBe('{\n  "cleanupPeriodDays" : 365,\n  "a" : 1\n}\n');
    expect(setTopLevelNumber('{\n    "a": 1\n}', K, 90)).toBe('{\n    "cleanupPeriodDays": 90,\n    "a": 1\n}');
    expect(setTopLevelNumber('{"a":1}', K, 90)).toBe('{"cleanupPeriodDays":90,"a":1}');
  });
  it('入れ子の同じ名前のキーには触れない', () => {
    const src = '{\n  "x": { "cleanupPeriodDays": 5 }\n}\n';
    expect(setTopLevelNumber(src, K, 365)).toBe('{\n  "cleanupPeriodDays": 365,\n  "x": { "cleanupPeriodDays": 5 }\n}\n');
  });
  it('文字列の中の括弧や引用符に惑わされない', () => {
    const src = '{\n  "note": "a { \\"cleanupPeriodDays\\": 1 }",\n  "cleanupPeriodDays": 30\n}\n';
    expect(setTopLevelNumber(src, K, 365)).toBe('{\n  "note": "a { \\"cleanupPeriodDays\\": 1 }",\n  "cleanupPeriodDays": 365\n}\n');
  });
  it('CRLF の改行と BOM を保つ', () => {
    const src = '﻿{\r\n  "a": 1\r\n}\r\n';
    expect(setTopLevelNumber(src, K, 365)).toBe('﻿{\r\n  "cleanupPeriodDays": 365,\r\n  "a": 1\r\n}\r\n');
  });
  it('Claude Code が受け付けない値（文字列、小数）も、数字で置き換える', () => {
    expect(setTopLevelNumber('{ "cleanupPeriodDays": "30" }', K, 365)).toBe('{ "cleanupPeriodDays": 365 }');
    expect(setTopLevelNumber('{ "cleanupPeriodDays": 7.5 }', K, 365)).toBe('{ "cleanupPeriodDays": 365 }');
  });
  it('値がオブジェクトや配列のとき、JSON が壊れているとき、最上位が配列のときは書かない', () => {
    expect(() => setTopLevelNumber('{ "cleanupPeriodDays": {} }', K, 365)).toThrow(JsonTextEditError);
    expect(() => setTopLevelNumber('{ "a": ', K, 365)).toThrow(JsonTextEditError);
    expect(() => setTopLevelNumber('[1]', K, 365)).toThrow(JsonTextEditError);
  });
  it('同じキーが最上位に 2 度あるときは、読み違いを避けて書かない', () => {
    expect(() => setTopLevelNumber('{ "cleanupPeriodDays": 1, "cleanupPeriodDays": 2 }', K, 365)).toThrow(JsonTextEditError);
  });
});

describe('diffLines', () => {
  it('変わった行と前後 1 行ずつを返す', () => {
    const before = '{\n  "a": 1,\n  "cleanupPeriodDays": 30,\n  "b": 2\n}\n';
    const after = '{\n  "a": 1,\n  "cleanupPeriodDays": 365,\n  "b": 2\n}\n';
    expect(diffLines(before, after)).toEqual([
      { kind: 'ctx', text: '  "a": 1,' },
      { kind: 'del', text: '  "cleanupPeriodDays": 30,' },
      { kind: 'add', text: '  "cleanupPeriodDays": 365,' },
      { kind: 'ctx', text: '  "b": 2' },
    ]);
  });
  it('足しただけなら add だけになる。新しく作るときは全行が add', () => {
    expect(diffLines('{\n  "a": 1\n}\n', '{\n  "cleanupPeriodDays": 365,\n  "a": 1\n}\n')).toEqual([
      { kind: 'ctx', text: '{' },
      { kind: 'add', text: '  "cleanupPeriodDays": 365,' },
      { kind: 'ctx', text: '  "a": 1' },
    ]);
    expect(diffLines('', '{\n  "cleanupPeriodDays": 365\n}\n')).toEqual([
      { kind: 'add', text: '{' }, { kind: 'add', text: '  "cleanupPeriodDays": 365' }, { kind: 'add', text: '}' },
    ]);
  });
});
