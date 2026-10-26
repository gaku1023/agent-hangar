import { describe, expect, it } from 'vitest';
import { ConfigEditError } from './errors.ts';
import { getToml, removeToml, setToml } from './toml.ts';

const SAMPLE = `# 先頭のコメント
model = 'gpt-5'   # 行末のコメント
approval_policy = "on-request"
a.b = "x"

[tui]
# 説明
status_line = ["model",
  "git-branch"]   # 配列の後ろ
theme = 'dark'

# サーバの節
[mcp_servers.x]
command = "npx"
args = ['-y', "pkg"]
inl = { A = "1", B = '2' }

[mcp_servers.x.env]
KEY = "v"   # 鍵のコメント

[features]
unified_exec = true
`;

describe('toml の読み出し', () => {
  it('鍵の道で値を取る', () => {
    expect(getToml(SAMPLE, ['model'])).toBe('gpt-5');
    expect(getToml(SAMPLE, ['a', 'b'])).toBe('x');
    expect(getToml(SAMPLE, ['tui', 'status_line'])).toEqual(['model', 'git-branch']);
    expect(getToml(SAMPLE, ['mcp_servers', 'x', 'env', 'KEY'])).toBe('v');
    expect(getToml(SAMPLE, ['mcp_servers', 'x', 'inl'])).toEqual({ A: '1', B: '2' });
    expect(getToml(SAMPLE, ['mcp_servers', 'x', 'inl', 'B'])).toBe('2');
    expect(getToml(SAMPLE, ['features'])).toEqual({ unified_exec: true });
    expect(getToml(SAMPLE, ['nothing'])).toBeUndefined();
    expect(getToml(SAMPLE, [])).toMatchObject({ model: 'gpt-5' });
  });
  it('引用の鍵、複数行の文字列、数値、日時を読む', () => {
    const src = `"a.b" = 1\n[x."y z"]\nk = """\nl1\nl2"""\nn = -1_000\nf = 1.5e3\nd = 2020-01-01T00:00:00Z\nh = 0xff\nm = '''raw\\n'''\n`;
    expect(getToml(src, ['a.b'])).toBe(1);
    expect(getToml(src, ['x', 'y z', 'k'])).toBe('l1\nl2');
    expect(getToml(src, ['x', 'y z', 'n'])).toBe(-1000);
    expect(getToml(src, ['x', 'y z', 'f'])).toBe(1500);
    expect(getToml(src, ['x', 'y z', 'h'])).toBe(255);
    expect(getToml(src, ['x', 'y z', 'm'])).toBe('raw\\n');
  });
});

describe('toml の差し替え（形を保つ）', () => {
  it('先頭の鍵を替えても、コメント・空行・並び・引用の形が変わらない', () => {
    const out = setToml(SAMPLE, ['model'], 'o3');
    expect(out).toBe(SAMPLE.replace(`'gpt-5'`, `'o3'`));
  });
  it('基本文字列は基本文字列のまま', () => {
    expect(setToml(SAMPLE, ['approval_policy'], 'never')).toBe(SAMPLE.replace('"on-request"', '"never"'));
  });
  it('単引用に入らない値は基本文字列に切り替える', () => {
    expect(setToml(SAMPLE, ['model'], "it's")).toBe(SAMPLE.replace(`'gpt-5'`, `"it's"`));
  });
  it('点のついた鍵', () => {
    expect(setToml(SAMPLE, ['a', 'b'], 'y')).toBe(SAMPLE.replace('a.b = "x"', 'a.b = "y"'));
  });
  it('表の中の鍵', () => {
    expect(setToml(SAMPLE, ['tui', 'theme'], 'light')).toBe(SAMPLE.replace(`'dark'`, `'light'`));
    expect(setToml(SAMPLE, ['mcp_servers', 'x', 'env', 'KEY'], 'w')).toBe(SAMPLE.replace('KEY = "v"', 'KEY = "w"'));
    expect(setToml(SAMPLE, ['features', 'unified_exec'], false)).toBe(SAMPLE.replace('unified_exec = true', 'unified_exec = false'));
  });
  it('複数行の配列は、同じ長さなら変えた要素だけを替える（コメントも残る）', () => {
    expect(setToml(SAMPLE, ['tui', 'status_line'], ['model', 'cwd'])).toBe(SAMPLE.replace('"git-branch"', '"cwd"'));
  });
  it('複数行の配列は、長さが変わっても配置を保つ', () => {
    const out = setToml(SAMPLE, ['tui', 'status_line'], ['model', 'git-branch', 'cwd']);
    expect(out).toContain('status_line = ["model",\n  "git-branch",\n  "cwd"]   # 配列の後ろ');
    expect(getToml(out, ['tui', 'status_line'])).toEqual(['model', 'git-branch', 'cwd']);
  });
  it('1 行の配列は、要素の引用の形を保つ', () => {
    expect(setToml(SAMPLE, ['mcp_servers', 'x', 'args'], ['-y', 'other'])).toBe(SAMPLE.replace(`"pkg"`, `"other"`));
    expect(setToml(SAMPLE, ['mcp_servers', 'x', 'args'], ['-y', 'pkg', 'z'])).toContain(`args = ['-y', "pkg", "z"]`);
  });
  it('インライン表の中の鍵を替える・足す・消す', () => {
    expect(setToml(SAMPLE, ['mcp_servers', 'x', 'inl', 'B'], '3')).toBe(SAMPLE.replace(`B = '2'`, `B = '3'`));
    const added = setToml(SAMPLE, ['mcp_servers', 'x', 'inl', 'C'], 'c');
    expect(added).toContain(`inl = { A = "1", B = '2', C = "c" }`);
    const removed = removeToml(SAMPLE, ['mcp_servers', 'x', 'inl', 'A']);
    expect(removed).toContain(`inl = { B = '2' }`);
  });
  it('インライン表ごと別の値にする', () => {
    const out = setToml(SAMPLE, ['mcp_servers', 'x', 'inl'], { Z: '9' });
    expect(getToml(out, ['mcp_servers', 'x', 'inl'])).toEqual({ Z: '9' });
  });
  it('CRLF の文書の改行を保つ', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const out = setToml(crlf, ['tui', 'new'], 1);
    expect(out.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(out).toContain('theme = \'dark\'\r\nnew = 1\r\n');
  });
});

describe('toml の追加', () => {
  it('根に足す（最初の表より前、既存の鍵の後ろ）', () => {
    const out = setToml(SAMPLE, ['personality'], 'friendly');
    expect(out).toBe(SAMPLE.replace('a.b = "x"\n', 'a.b = "x"\npersonality = "friendly"\n'));
  });
  it('表の中に足す（その表の最後の鍵の後ろ）', () => {
    const out = setToml(SAMPLE, ['tui', 'notifications'], true);
    expect(out).toBe(SAMPLE.replace(`theme = 'dark'\n`, `theme = 'dark'\nnotifications = true\n`));
  });
  it('入れ子の表の中に足す', () => {
    const out = setToml(SAMPLE, ['mcp_servers', 'x', 'env', 'OTHER'], 'o');
    expect(out).toBe(SAMPLE.replace('KEY = "v"   # 鍵のコメント\n', 'KEY = "v"   # 鍵のコメント\nOTHER = "o"\n'));
  });
  it('表が無ければ、近い表の後ろに作る', () => {
    const out = setToml(SAMPLE, ['mcp_servers', 'x', 'headers', 'H'], 'h');
    expect(getToml(out, ['mcp_servers', 'x', 'headers', 'H'])).toBe('h');
    expect(out.indexOf('[mcp_servers.x.headers]')).toBeGreaterThan(out.indexOf('[mcp_servers.x.env]'));
    expect(out.indexOf('[mcp_servers.x.headers]')).toBeLessThan(out.indexOf('[features]'));
    expect(out.endsWith('unified_exec = true\n')).toBe(true);
  });
  it('点のついた鍵の仲間に足す（表を作らない）', () => {
    const out = setToml(SAMPLE, ['a', 'c'], 'z');
    expect(out).toBe(SAMPLE.replace('a.b = "x"\n', 'a.b = "x"\na.c = "z"\n'));
  });
  it('表ごと追加する（子の表も作る）', () => {
    const out = setToml(SAMPLE, ['mcp_servers', 'y'], { command: 'node', args: ['a', 'b'], env: { K: 'v' } });
    expect(getToml(out, ['mcp_servers', 'y'])).toEqual({ command: 'node', args: ['a', 'b'], env: { K: 'v' } });
    expect(out).toContain('[mcp_servers.y]\ncommand = "node"\nargs = ["a", "b"]\n\n[mcp_servers.y.env]\nK = "v"\n');
    expect(out.indexOf('[mcp_servers.y]')).toBeLessThan(out.indexOf('[features]'));
    expect(out.startsWith(SAMPLE.slice(0, SAMPLE.indexOf('[features]')))).toBe(true);
  });
  it('空の文書や末尾に改行の無い文書にも足せる', () => {
    expect(setToml('', ['model'], 'x')).toBe('model = "x"\n');
    expect(setToml('a = 1', ['b'], 2)).toBe('a = 1\nb = 2\n');
    expect(setToml('[t]\na = 1', ['t', 'b'], 2)).toBe('[t]\na = 1\nb = 2\n');
    expect(setToml('# c\n[t]\na = 1\n', ['top'], 1)).toBe('top = 1\n\n# c\n[t]\na = 1\n');
  });
  it('鍵に使えない文字は引用する', () => {
    const out = setToml('[t]\n', ['t', 'a b'], 1);
    expect(out).toContain('"a b" = 1');
    expect(getToml(out, ['t', 'a b'])).toBe(1);
  });
});

describe('toml の表ごとの差し替えと削除', () => {
  it('表ごと差し替える（変わらない鍵のコメントは残り、無い鍵は消える）', () => {
    const out = setToml(SAMPLE, ['mcp_servers', 'x'], { command: 'npx', args: ['-y', 'pkg'], inl: { A: '1', B: '2' }, env: { KEY: 'v', NEW: 'n' } });
    expect(getToml(out, ['mcp_servers', 'x', 'env'])).toEqual({ KEY: 'v', NEW: 'n' });
    expect(out).toContain('KEY = "v"   # 鍵のコメント');
    expect(out).toContain('# サーバの節\n[mcp_servers.x]');
    const out2 = setToml(SAMPLE, ['mcp_servers', 'x'], { url: 'https://example.invalid/mcp' });
    expect(getToml(out2, ['mcp_servers', 'x'])).toEqual({ url: 'https://example.invalid/mcp' });
    expect(out2).not.toContain('[mcp_servers.x.env]');
    expect(out2).toContain('[features]\nunified_exec = true\n');
  });
  it('表ごと削除する（子の表も、頭のコメントも、前後の空行は 1 つ）', () => {
    const out = removeToml(SAMPLE, ['mcp_servers', 'x']);
    expect(out).toBe(SAMPLE.slice(0, SAMPLE.indexOf('# サーバの節')) + SAMPLE.slice(SAMPLE.indexOf('[features]')));
  });
  it('最後の表を消しても、末尾の空行が増えない', () => {
    const out = removeToml(SAMPLE, ['features']);
    expect(out.endsWith('KEY = "v"   # 鍵のコメント\n')).toBe(true);
  });
  it('鍵を消す（行ごと、前後は触らない）', () => {
    expect(removeToml(SAMPLE, ['model'])).toBe(SAMPLE.replace(`model = 'gpt-5'   # 行末のコメント\n`, ''));
    expect(removeToml(SAMPLE, ['a', 'b'])).toBe(SAMPLE.replace('a.b = "x"\n', ''));
    expect(removeToml(SAMPLE, ['tui', 'status_line'])).toBe(SAMPLE.replace(`status_line = ["model",\n  "git-branch"]   # 配列の後ろ\n`, ''));
  });
  it('点のついた鍵の親を消すと、仲間も消える', () => {
    expect(removeToml(SAMPLE, ['a'])).toBe(SAMPLE.replace('a.b = "x"\n', ''));
  });
  it('無い鍵を消しても何も変わらない', () => {
    expect(removeToml(SAMPLE, ['nothing', 'here'])).toBe(SAMPLE);
  });
  it('値を表から値に替えると、表は消える', () => {
    const out = setToml(SAMPLE, ['features'], 'off');
    expect(getToml(out, ['features'])).toBe('off');
  });
});

describe('toml の周辺の場合', () => {
  it('表が無い文書に、根の鍵のあと表を足す', () => {
    expect(setToml('a = 1\n', ['t', 'x'], 1)).toBe('a = 1\n\n[t]\nx = 1\n');
    expect(setToml('a = 1\n\n\n', ['t', 'x'], 1)).toBe('a = 1\n\n\n[t]\nx = 1\n');
  });
  it('空の表にして、中身を足せる', () => {
    const out = setToml(SAMPLE, ['features'], {});
    expect(getToml(out, ['features'])).toEqual({});
    expect(setToml(out, ['features', 'k'], 1)).toContain('[features]\nk = 1\n');
  });
  it('頭のコメントが先頭の表を消すと、そのコメントも消える', () => {
    expect(removeToml('# one\n[a]\nx = 1\n\n# two\n[b]\ny = 2\n', ['a'])).toBe('# two\n[b]\ny = 2\n');
  });
  it('2 度同じことをしても変わらない（冪等）', () => {
    const once = setToml(SAMPLE, ['mcp_servers', 'y'], { command: 'node' });
    expect(setToml(once, ['mcp_servers', 'y'], { command: 'node' })).toBe(once);
    expect(removeToml(removeToml(once, ['mcp_servers', 'y']), ['mcp_servers', 'y'])).toBe(removeToml(once, ['mcp_servers', 'y']));
  });
  it('複数行の文字列の形を保つ', () => {
    const src = 'p = \'\'\'\nline1\nline2\'\'\'\n';
    expect(setToml(src, ['p'], 'a\nb')).toBe('p = \'\'\'\na\nb\'\'\'\n');
  });
});

describe('toml の壊れた入力', () => {
  const broken: [string, string][] = [
    ['閉じない文字列', 'a = "abc\n'],
    ['閉じない配列', 'a = [1, 2\n'],
    ['閉じない表の見出し', '[t\na = 1\n'],
    ['値が無い', 'a =\n'],
    ['等号が無い', 'a 1\n'],
    ['値の後ろのごみ', 'a = 1 2\n'],
    ['鍵の重複', 'a = 1\na = 2\n'],
    ['表の重複', '[t]\n[t]\n'],
    ['点のついた鍵で作った表を見出しで開く', 'a.b = 1\n[a]\nc = 2\n'],
    ['インライン表の拡張', 'a = { b = 1 }\n[a.c]\n'],
    ['閉じない複数行文字列', 'a = """x\n'],
    ['数値でない値', 'a = foo\n'],
  ];
  for (const [name, src] of broken) {
    it(`${name}は、読み出しも書き込みも失敗する`, () => {
      expect(() => getToml(src, ['a'])).toThrow(ConfigEditError);
      expect(() => setToml(src, ['z'], 1)).toThrow(ConfigEditError);
      expect(() => removeToml(src, ['z'])).toThrow(ConfigEditError);
    });
  }
  it('失敗の種類を持つ', () => {
    try {
      setToml('a = "x\n', ['b'], 1);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigEditError);
      expect((e as ConfigEditError).code).toBe('parse');
      expect((e as ConfigEditError).line).toBe(1);
    }
  });
  it('値の型が合わない道（スカラの下に足す）は失敗する', () => {
    expect(() => setToml('a = 1\n', ['a', 'b'], 1)).toThrow(ConfigEditError);
    expect(() => setToml('a = [1]\n', ['a', 'b'], 1)).toThrow(ConfigEditError);
  });
  it('表の配列をまたぐ道は扱わない', () => {
    const src = '[[hooks]]\nname = "a"\n';
    expect(getToml(src, ['hooks'])).toEqual([{ name: 'a' }]);
    expect(() => setToml(src, ['hooks', 'name'], 'b')).toThrow(ConfigEditError);
    expect(() => removeToml(src, ['hooks', 'name'])).toThrow(ConfigEditError);
  });
  it('TOML にできない値は失敗する', () => {
    expect(() => setToml('', ['a'], undefined as unknown as string)).toThrow(ConfigEditError);
    expect(() => setToml('', ['a'], null as unknown as string)).toThrow(ConfigEditError);
    expect(() => setToml('', [], 1)).toThrow(ConfigEditError);
  });
  it('エスケープの要る文字列を往復できる', () => {
    const v = 'a"b\\c\nd\te\u0001';
    const out = setToml('', ['k'], v);
    expect(getToml(out, ['k'])).toBe(v);
  });
});
