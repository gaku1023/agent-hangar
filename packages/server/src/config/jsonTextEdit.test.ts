import { describe, expect, it } from 'vitest';
import { diffLines, JsonTextEditError, parseJsonc, removeJsoncPath, setJsoncPath, setTopLevelNumber } from './jsonTextEdit.ts';

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
    const src = '\uFEFF{\r\n  "a": 1\r\n}\r\n';
    expect(setTopLevelNumber(src, K, 365)).toBe('\uFEFF{\r\n  "cleanupPeriodDays": 365,\r\n  "a": 1\r\n}\r\n');
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

describe('parseJsonc（opencode.json の読み）', () => {
  it('行と塊のコメント、末尾のカンマを読み飛ばす。文字列の中の // と /* はそのまま', () => {
    const src = '{\n  // c\n  "a": "http://x/*y*/", /* z */\n  "b": [1, 2,],\n}\n';
    expect(parseJsonc(src)).toEqual({ a: 'http://x/*y*/', b: [1, 2] });
  });
  it('空は空のオブジェクト、壊れていれば JsonTextEditError', () => {
    expect(parseJsonc('')).toEqual({});
    expect(parseJsonc('﻿  \n')).toEqual({});
    expect(() => parseJsonc('{ "a": }')).toThrow(JsonTextEditError);
    expect(() => parseJsonc('{ "a": 1 /* open')).toThrow(JsonTextEditError);
  });
});

describe('setJsoncPath（opencode.json に入れ子の値を書く）', () => {
  const user = [
    '{',
    '    // 私の設定',
    '    "$schema": "https://opencode.ai/config.json",',
    '    "model": "lmstudio/qwen", // いつもの',
    '    "providers": {',
    '        "cit-code": {',
    '            "name": "cit-code",',
    '            "settings": { "baseURL": "https://gpu.example/v1" },',
    '            "models": { "a": {} }',
    '        }',
    '    },',
    '    "share": "disabled"',
    '}',
    '',
  ].join('\n');

  it('既にある入れ子のオブジェクトの終わりに 1 つ足す。コメント、並び、字下げ（4 つ）はそのまま', () => {
    const out = setJsoncPath(user, ['providers', 'home', 'name'], 'Home');
    expect(out).toBe(user.replace(
      '            "models": { "a": {} }\n        }\n    },',
      '            "models": { "a": {} }\n        },\n        "home": {\n            "name": "Home"\n        }\n    },',
    ));
    expect(parseJsonc(out)).toEqual({ ...(parseJsonc(user) as object), providers: { 'cit-code': { name: 'cit-code', settings: { baseURL: 'https://gpu.example/v1' }, models: { a: {} } }, home: { name: 'Home' } } });
  });

  it('1 行に書いたオブジェクトには、その行の中で足す', () => {
    const out = setJsoncPath(user, ['providers', 'cit-code', 'models', 'b'], {});
    expect(out).toBe(user.replace('"models": { "a": {} }', '"models": { "a": {}, "b": {} }'));
  });

  it('途中のキーが無ければ、最上位の終わりに入れ子ごと足す。最後の値の後ろのコメントは行に残す', () => {
    const src = '{\n  "model": "x" // note\n}\n';
    const out = setJsoncPath(src, ['providers', 'p', 'models', 'm'], {});
    expect(out).toBe('{\n  "model": "x", // note\n  "providers": {\n    "p": {\n      "models": {\n        "m": {}\n      }\n    }\n  }\n}\n');
  });

  it('末尾にカンマがあれば、カンマを重ねない', () => {
    const out = setJsoncPath('{\n  "a": 1,\n}\n', ['b'], 2);
    expect(out).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
  });

  it('空のファイルと空のオブジェクトには、整えた形で書く', () => {
    expect(setJsoncPath('', ['providers', 'p'], { name: 'P' })).toBe('{\n  "providers": {\n    "p": {\n      "name": "P"\n    }\n  }\n}\n');
    expect(setJsoncPath('{}', ['a'], 1)).toBe('{\n  "a": 1\n}\n');
    expect(setJsoncPath('{\n  "p": {}\n}\n', ['p', 'x'], true)).toBe('{\n  "p": {\n    "x": true\n  }\n}\n');
  });

  it('キーがあれば、その値だけを置き換える', () => {
    expect(setJsoncPath('{ "a": { "b": 1, "c": 2 } }', ['a', 'b'], { d: 3 })).toBe('{ "a": { "b": {"d":3}, "c": 2 } }');
  });

  it('CRLF の改行と BOM を保つ', () => {
    const out = setJsoncPath('﻿{\r\n  "a": 1\r\n}\r\n', ['b'], 'x');
    expect(out).toBe('﻿{\r\n  "a": 1,\r\n  "b": "x"\r\n}\r\n');
  });

  it('途中の値がオブジェクトでなければ、読めないものとして書かない', () => {
    expect(() => setJsoncPath('{ "providers": [] }', ['providers', 'p'], {})).toThrow(JsonTextEditError);
    expect(() => setJsoncPath('[1]', ['a'], 1)).toThrow(JsonTextEditError);
    expect(() => setJsoncPath('{ "a": 1, "a": 2 }', ['a'], 3)).toThrow(JsonTextEditError);
  });
});

describe('removeJsoncPath（opencode.json から入れ子の値を消す）', () => {
  it('間のメンバーは後ろのカンマごと、最後のメンバーは前のカンマごと消す。ほかの行はそのまま', () => {
    const src = '{\n  "providers": {\n    "a": { "x": 1 },\n    "b": {},\n    "c": 3\n  }\n}\n';
    expect(removeJsoncPath(src, ['providers', 'b'])).toBe('{\n  "providers": {\n    "a": { "x": 1 },\n    "c": 3\n  }\n}\n');
    expect(removeJsoncPath(src, ['providers', 'c'])).toBe('{\n  "providers": {\n    "a": { "x": 1 },\n    "b": {}\n  }\n}\n');
    expect(removeJsoncPath('{ "p": { "only": 1 } }', ['p', 'only'])).toBe('{ "p": {} }');
  });
  it('無いキーなら何も変えない', () => {
    const src = '{\n  // c\n  "a": 1\n}\n';
    expect(removeJsoncPath(src, ['providers', 'x'])).toBe(src);
  });
});
