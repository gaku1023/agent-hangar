// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dropText, handleFileDrop, parseDrag, parseDrop, quotePath } from './fileDrop.ts';

beforeEach(() => { document.body.innerHTML = '<div class="term-host" data-tab="t1"><canvas id="cv"></canvas></div><div id="outside"></div>'; });

describe('quotePath', () => {
  it('シェルで特別な意味を持たないパスはそのまま渡す', () => {
    expect(quotePath('/Users/a/.agent-hangar/drops/1-スクリーンショット_19.51.52.png')).toBe('/Users/a/.agent-hangar/drops/1-スクリーンショット_19.51.52.png');
  });
  it('空白や引用符を含むパスは単引用符で囲み、中の単引用符は閉じて逃がす', () => {
    expect(quotePath('/tmp/a b.png')).toBe("'/tmp/a b.png'");
    expect(quotePath("/tmp/it's.png")).toBe("'/tmp/it'\\''s.png'");
  });
});

describe('quotePath（Windows のパス）', () => {
  // psmux のペインで動くのは claude か PowerShell（シェルタブ、psmux の既定も PowerShell）である。
  it('PowerShell と cmd で特別な意味を持たないパスはそのまま渡す', () => {
    expect(quotePath('C:\\Users\\a\\.agent-hangar\\drops\\1-スクリーンショット_19.51.52.png')).toBe('C:\\Users\\a\\.agent-hangar\\drops\\1-スクリーンショット_19.51.52.png');
    expect(quotePath('D:/work/a-b+c=d.png')).toBe('D:/work/a-b+c=d.png');
  });
  it('空白、単引用符、PowerShell と cmd の記号を含むパスは二重引用符で囲む（Windows の名前に " は使えない）', () => {
    expect(quotePath('C:\\Users\\Taro Yamada\\.agent-hangar\\drops\\1-a.png')).toBe('"C:\\Users\\Taro Yamada\\.agent-hangar\\drops\\1-a.png"');
    expect(quotePath("C:\\work\\Bob's.png")).toBe('"C:\\work\\Bob\'s.png"');
    for (const name of ['a,b.png', 'a;b.png', 'a&b.png', 'a(1).png', 'a{1}.png', '100%.png', '@a.png', 'a#b.png']) {
      expect(quotePath(`C:\\work\\${name}`), name).toBe(`"C:\\work\\${name}"`);
    }
    expect(quotePath('\\\\server\\share\\a b.png')).toBe('"\\\\server\\share\\a b.png"');
  });
  it('$ と ` を含むパスは、PowerShell が二重引用符の中で展開するので、単引用符で囲み、中の単引用符は 2 つにする', () => {
    expect(quotePath('C:\\work\\$tmp\\a.png')).toBe("'C:\\work\\$tmp\\a.png'");
    expect(quotePath('C:\\work\\a`b.png')).toBe("'C:\\work\\a`b.png'");
    expect(quotePath("C:\\work\\$it's.png")).toBe("'C:\\work\\$it''s.png'");
  });
});

describe('dropText', () => {
  it('複数のパスを空白で区切り、端末へのドロップと同じく末尾に空白を 1 つ付ける', () => {
    expect(dropText(['/a.png', '/b c.png'])).toBe("/a.png '/b c.png' ");
    expect(dropText(['C:\\a.png', 'C:\\b c.png'])).toBe('C:\\a.png "C:\\b c.png" ');
  });
});

describe('handleFileDrop', () => {
  const deps = () => ({ hit: vi.fn((x: number, y: number) => (x === 10 && y === 20 ? document.getElementById('cv') : document.getElementById('outside'))), paste: vi.fn(), focus: vi.fn() });

  it('落とした位置の端末に、パスを貼り付けとして渡してフォーカスする', () => {
    const d = deps();
    expect(handleFileDrop({ paths: ['/a.png'], x: 10, y: 20 }, d)).toBe(true);
    expect(d.paste).toHaveBeenCalledWith('t1', '/a.png ');
    expect(d.focus).toHaveBeenCalledWith('t1');
  });
  it('端末の外に落としたときは何もしない', () => {
    const d = deps();
    expect(handleFileDrop({ paths: ['/a.png'], x: 1, y: 1 }, d)).toBe(false);
    expect(d.paste).not.toHaveBeenCalled();
  });
  it('形の崩れた知らせと空のパスは捨てる', () => {
    const d = deps();
    for (const bad of [null, 'x', { paths: '/a.png', x: 10, y: 20 }, { paths: [1], x: 10, y: 20 }, { paths: [], x: 10, y: 20 }, { paths: ['/a.png'], x: 'a', y: 20 }]) {
      expect(handleFileDrop(bad, d)).toBe(false);
    }
    expect(d.paste).not.toHaveBeenCalled();
  });
});

describe('parseDrag', () => {
  it('位置があればそれを返し、出たとき（null）と形の違うものは null', () => {
    expect(parseDrag({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    for (const bad of [null, undefined, {}, { x: '1', y: 2 }, { x: Infinity, y: 2 }]) expect(parseDrag(bad)).toBeNull();
  });
});

describe('parseDrop', () => {
  it('形の合う知らせだけを返す', () => {
    expect(parseDrop({ paths: ['/a.png'], x: 1, y: 2 })).toEqual({ paths: ['/a.png'], x: 1, y: 2 });
    for (const bad of [null, {}, { paths: [], x: 1, y: 2 }, { paths: [''], x: 1, y: 2 }, { paths: ['/a'], x: NaN, y: 2 }]) expect(parseDrop(bad)).toBeNull();
  });
});
