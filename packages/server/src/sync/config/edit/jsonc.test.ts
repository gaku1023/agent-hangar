import { describe, expect, it } from 'vitest';
import { ConfigEditError } from './errors.ts';
import { formatJson, getJson, getJsonc, removeJson, removeJsonc, setJson, setJsonc } from './jsonc.ts';

const SAMPLE = `{
  // 先頭のコメント
  "$schema": "https://opencode.ai/config.json",
  "model": "a/b",   /* 行末 */
  "agent": {
    "build": { "prompt": "p", "steps": 3 },
    // 次
    "plan": { "mode": "primary" }
  },
  "instructions": ["one.md", "two.md"],
  "mcp": { "x": { "type": "local", "command": ["npx", "-y"] } }
}
`;

describe('jsonc の読み出し', () => {
  it('コメントと末尾のカンマを許して読む', () => {
    expect(getJsonc(SAMPLE, ['model'])).toBe('a/b');
    expect(getJsonc(SAMPLE, ['agent', 'build', 'prompt'])).toBe('p');
    expect(getJsonc(SAMPLE, ['instructions', 1])).toBe('two.md');
    expect(getJsonc(SAMPLE, ['nothing'])).toBeUndefined();
    expect(getJsonc('{"a":1,}', ['a'])).toBe(1);
  });
});

describe('jsonc の書き戻し（形を保つ）', () => {
  it('値だけが変わる', () => {
    expect(setJsonc(SAMPLE, ['model'], 'c/d')).toBe(SAMPLE.replace('"a/b"', '"c/d"'));
    expect(setJsonc(SAMPLE, ['agent', 'build', 'prompt'], 'q')).toBe(SAMPLE.replace('"prompt": "p"', '"prompt": "q"'));
  });
  it('配列の要素を替える', () => {
    expect(setJsonc(SAMPLE, ['instructions', 0], 'z.md')).toBe(SAMPLE.replace('"one.md"', '"z.md"'));
    expect(getJsonc(setJsonc(SAMPLE, ['instructions'], ['a.md']), ['instructions'])).toEqual(['a.md']);
  });
  it('鍵を足す（コメントは残る）', () => {
    const out = setJsonc(SAMPLE, ['agent', 'plan', 'temperature'], 0.2);
    expect(getJsonc(out, ['agent', 'plan', 'temperature'])).toBe(0.2);
    expect(out).toContain('// 先頭のコメント');
    expect(out).toContain('/* 行末 */');
    expect(out).toContain('// 次');
    expect(out).toContain('"model": "a/b",');
  });
  it('無い入れ物を作って足す', () => {
    const out = setJsonc(SAMPLE, ['agents', 'x', 'prompt'], 'p');
    expect(getJsonc(out, ['agents', 'x', 'prompt'])).toBe('p');
    expect(out).toContain('// 先頭のコメント');
  });
  it('空の文書にも書ける', () => {
    expect(getJsonc(setJsonc('', ['a'], 1), ['a'])).toBe(1);
    expect(getJsonc(setJsonc('{}', ['a', 'b'], 1), ['a', 'b'])).toBe(1);
  });
  it('鍵を消す', () => {
    const out = removeJsonc(SAMPLE, ['agent', 'build', 'steps']);
    expect(getJsonc(out, ['agent', 'build'])).toEqual({ prompt: 'p' });
    expect(out).toContain('// 次');
    expect(removeJsonc(SAMPLE, ['nothing'])).toBe(SAMPLE);
  });
  it('入れ物ごと差し替える・消す', () => {
    const out = setJsonc(SAMPLE, ['mcp', 'x'], { type: 'remote', url: 'u' });
    expect(getJsonc(out, ['mcp', 'x'])).toEqual({ type: 'remote', url: 'u' });
    expect(getJsonc(removeJsonc(out, ['mcp', 'x']), ['mcp'])).toEqual({});
  });
  it('CRLF を保つ', () => {
    const out = setJsonc(SAMPLE.replace(/\n/g, '\r\n'), ['agent', 'plan', 'steps'], 1);
    expect(out.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });
});

describe('jsonc の壊れた入力', () => {
  for (const src of ['{"a": 1', '{"a" 1}', '{"a": }', '[1, 2', '{"a": 1} x', '{"a": "x}']) {
    it(`${src} は失敗する`, () => {
      expect(() => getJsonc(src, ['a'])).toThrow(ConfigEditError);
      expect(() => setJsonc(src, ['b'], 1)).toThrow(ConfigEditError);
      expect(() => removeJsonc(src, ['b'])).toThrow(ConfigEditError);
    });
  }
  it('根が入れ物でない文書は失敗する', () => {
    expect(() => setJsonc('[1]', ['a'], 1)).toThrow(ConfigEditError);
    expect(() => setJsonc('3', ['a'], 1)).toThrow(ConfigEditError);
  });
  it('JSON にできない値は失敗する', () => {
    expect(() => setJsonc('{}', ['a'], undefined as unknown as string)).toThrow(ConfigEditError);
    expect(() => setJsonc('{}', ['a'], () => 1 as unknown as string)).toThrow(ConfigEditError);
    expect(() => setJsonc('{}', [], 1)).toThrow(ConfigEditError);
  });
});

describe('json（2 空白で整形し直す）', () => {
  it('formatJson は 2 空白と末尾の改行', () => {
    expect(formatJson({ a: [1, { b: 2 }] })).toBe('{\n  "a": [\n    1,\n    {\n      "b": 2\n    }\n  ]\n}\n');
  });
  it('1 行の json が整形し直される。鍵の並びと未知の鍵は保つ', () => {
    const out = setJson('{"z":1,"model":"a","unknown":{"k":[1,2]}}', ['model'], 'b');
    expect(out).toBe('{\n  "z": 1,\n  "model": "b",\n  "unknown": {\n    "k": [\n      1,\n      2\n    ]\n  }\n}\n');
  });
  it('足す・消す・読む', () => {
    const src = '{"a":{"b":1}}';
    expect(getJson(setJson(src, ['a', 'c'], 2), ['a', 'c'])).toBe(2);
    expect(JSON.parse(removeJson(src, ['a', 'b']))).toEqual({ a: {} });
    expect(JSON.parse(setJson('', ['a'], 1))).toEqual({ a: 1 });
  });
  it('コメント入りや壊れた json は失敗する', () => {
    expect(() => setJson('{"a":1 // c\n}', ['a'], 2)).toThrow(ConfigEditError);
    expect(() => setJson('{"a":', ['a'], 2)).toThrow(ConfigEditError);
    expect(() => getJson('{"a":1,}', ['a'])).toThrow(ConfigEditError);
  });
});
