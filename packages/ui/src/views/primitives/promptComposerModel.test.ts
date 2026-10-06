import { describe, expect, it } from 'vitest';
import type { PromptCommandDto } from '@agent-hangar/shared';
import { acceptText, arrangeCommands, attachmentFromPath, composePrompt, dropFileName, formatSize, isImageName, triggerAt, type Attachment } from './promptComposerModel.ts';

const cmd = (name: string, source: PromptCommandDto['source'] = 'user', uses = 0, description = ''): PromptCommandDto => ({ name, description, argumentHint: null, source, uses });

describe('triggerAt', () => {
  it('先頭の / から空白までの語にカーソルがあれば、/ のきっかけになる', () => {
    expect(triggerAt('/', 1)).toEqual({ kind: '/', query: '', start: 0 });
    expect(triggerAt('/go', 3)).toEqual({ kind: '/', query: 'go', start: 0 });
    expect(triggerAt('/goal 速く', 2)).toEqual({ kind: '/', query: 'g', start: 0 });
  });
  it('語を過ぎたら / のきっかけではない', () => {
    expect(triggerAt('/goal 速く', 6)).toBeNull();
    expect(triggerAt('/goal\n', 6)).toBeNull();
  });
  it('先頭でない / は、きっかけにしない', () => {
    expect(triggerAt('src/a', 5)).toBeNull();
    expect(triggerAt(' /goal', 6)).toBeNull();
    expect(triggerAt('見て\n/goal', 8)).toBeNull();
  });
  it('先頭か空白の直後の @ は、@ のきっかけになる', () => {
    expect(triggerAt('@', 1)).toEqual({ kind: '@', query: '', start: 0 });
    expect(triggerAt('見て @src/a', 9)).toEqual({ kind: '@', query: 'src/a', start: 3 });
    expect(triggerAt('一行目\n@ab', 7)).toEqual({ kind: '@', query: 'ab', start: 4 });
  });
  it('語の途中の @（メールアドレスなど）は、きっかけにしない', () => {
    expect(triggerAt('a@b.com', 7)).toBeNull();
  });
  it('@ の語を過ぎたら、きっかけではない', () => {
    expect(triggerAt('@src/a を見て', 7)).toBeNull();
  });
  it('/ の語の中でも、@ より / を先に見る', () => {
    expect(triggerAt('/a@b', 4)).toEqual({ kind: '/', query: 'a@b', start: 0 });
  });
});

describe('arrangeCommands', () => {
  const all = [cmd('alpha', 'user', 0), cmd('goal', 'user', 27), cmd('find-session', 'user', 42), cmd('init', 'builtin', 4), cmd('deploy', 'project', 0), cmd('sp:plan', 'plugin', 0), cmd('toggle', 'user', 10), cmd('review', 'builtin', 5), cmd('playwright', 'user', 4), cmd('grill', 'user', 3)];
  it('打つ前は、よく使う 5 つを先頭に、このプロジェクト、自分の、プラグイン、組み込みの順の群にする', () => {
    const s = arrangeCommands(all, '');
    // 組み込みの init と review は「よく使う」に入ったので、組み込みの群は空になり、出ない。
    expect(s.map((x) => x.title)).toEqual(['よく使う', 'このプロジェクト', '自分の', 'プラグイン']);
    expect(s[0]!.items.map((c) => c.name)).toEqual(['find-session', 'goal', 'toggle', 'review', 'init']);
    expect(s[2]!.items.map((c) => c.name)).toEqual(['alpha', 'playwright', 'grill']);
  });
  it('回数が同じなら、もとの並びを保つ', () => {
    expect(arrangeCommands([cmd('a', 'user', 4), cmd('b', 'user', 4)], '')[0]!.items.map((c) => c.name)).toEqual(['a', 'b']);
  });
  it('回数が 0 のものは、よく使うに入れない。空の群は出さない', () => {
    const s = arrangeCommands([cmd('a'), cmd('b', 'builtin')], '');
    expect(s.map((x) => x.title)).toEqual(['自分の', '組み込み']);
  });
  it('打ったら群を解き、名前の頭、名前の途中、説明の順に並べ、同じなら回数の多い順にする', () => {
    const list = [cmd('code-review', 'builtin', 0), cmd('review', 'builtin', 5), cmd('rewind', 'user', 9), cmd('x', 'user', 0, 'review を助ける')];
    const s = arrangeCommands(list, 're');
    expect(s).toHaveLength(1);
    expect(s[0]!.title).toBeNull();
    expect(s[0]!.items.map((c) => c.name)).toEqual(['rewind', 'review', 'code-review', 'x']);
  });
  it('大文字と小文字を区別しない。一致が無ければ空を返す', () => {
    expect(arrangeCommands([cmd('Goal')], 'GO')[0]!.items.map((c) => c.name)).toEqual(['Goal']);
    expect(arrangeCommands([cmd('goal')], 'zzz')).toEqual([]);
  });
});

describe('acceptText', () => {
  it('/ の語を、選んだ名前と空白 1 つに置き換える', () => {
    expect(acceptText('/go', 3, { kind: '/', query: 'go', start: 0 }, 'goal')).toEqual({ text: '/goal ', caret: 6 });
  });
  it('置き換えるのは、きっかけからカーソルまで。カーソルの後ろの文は消さず、空白 1 つで隔てる', () => {
    expect(acceptText('/goxx 速く', 3, { kind: '/', query: 'go', start: 0 }, 'goal')).toEqual({ text: '/goal xx 速く', caret: 6 });
    expect(acceptText('/速くする', 1, { kind: '/', query: '', start: 0 }, 'goal')).toEqual({ text: '/goal 速くする', caret: 6 });
    expect(acceptText('@fix this', 1, { kind: '@', query: '', start: 0 }, 'README.md')).toEqual({ text: '@README.md fix this', caret: 11 });
  });
  it('カーソルの後ろがすでに空白で始まるなら、空白を足さない', () => {
    expect(acceptText('/go do', 3, { kind: '/', query: 'go', start: 0 }, 'goal')).toEqual({ text: '/goal do', caret: 6 });
    expect(acceptText('見て @s\n続き', 5, { kind: '@', query: 's', start: 3 }, 'a.ts')).toEqual({ text: '見て @a.ts\n続き', caret: 9 });
  });
  it('囲んだ形（@"…"）でも、カーソルの後ろの文を残す', () => {
    expect(acceptText('@a rest', 2, { kind: '@', query: 'a', start: 0 }, 'my docs/a.md')).toEqual({ text: '@"my docs/a.md" rest', caret: 16 });
  });
  it('@ の語を、選んだパスと空白 1 つに置き換える', () => {
    expect(acceptText('見て @sr', 6, { kind: '@', query: 'sr', start: 3 }, 'src/a.ts')).toEqual({ text: '見て @src/a.ts ', caret: 13 });
  });
  it('@ のパスに空白があれば、@"…" で囲み、カーソルは囲みの後ろの空白の次へ置く', () => {
    expect(acceptText('見て @my', 6,{ kind: '@', query: 'my', start: 3 }, 'my docs/a.md')).toEqual({ text: '見て @"my docs/a.md" ', caret: 19 });
    expect(acceptText('@a', 2, { kind: '@', query: 'a', start: 0 }, 'a\tb.md')).toEqual({ text: '@"a\tb.md" ', caret: 10 });
  });
  it('/ の名前は、空白があっても囲まない', () => {
    expect(acceptText('/g', 2, { kind: '/', query: 'g', start: 0 }, 'a b')).toEqual({ text: '/a b ', caret: 5 });
  });
});

describe('composePrompt', () => {
  const a = (path: string): Attachment => ({ path, name: 'x', size: 1 });
  it('添付が無ければ、本文の前後の空白を落としただけにする', () => {
    expect(composePrompt('  やって\n', [])).toBe('やって');
  });
  it('本文の後に空行を 1 つ置き、添付のパスを 1 行ずつ足す', () => {
    expect(composePrompt('見て', [a('/h/drops/1-0-a.png'), a('/h/drops/1-1-b.log')])).toBe('見て\n\n/h/drops/1-0-a.png\n/h/drops/1-1-b.log');
  });
  it('本文が空なら、パスだけにする', () => {
    expect(composePrompt('  ', [a('/h/drops/1-0-a.png')])).toBe('/h/drops/1-0-a.png');
  });
  it('空白を含むパス（フォルダを落としたときの元のパス）は、単引用符で囲む', () => {
    expect(composePrompt('', [a('/Users/a/my dir')])).toBe("'/Users/a/my dir'");
  });
});

describe('添付の小さな関数', () => {
  it('dropFileName は、置き場のファイルだけ名前を返す', () => {
    expect(dropFileName('/Users/a/.agent-hangar/drops/1700-0-画面.png')).toBe('1700-0-画面.png');
    expect(dropFileName('/Users/a/Desktop/画面.png')).toBeNull();
    expect(dropFileName('/Users/a/.agent-hangar/drops/sub/x.png')).toBeNull();
  });
  // HANGAR_HOME を変えていても、置き場の名前は drops のままなので、札の絵は出る。
  it('dropFileName は、HANGAR_HOME が別の場所でも、親のフォルダが drops なら名前を返す', () => {
    expect(dropFileName('/x/custom-home/drops/1-0-a.png')).toBe('1-0-a.png');
    expect(dropFileName('/x/drops/sub/a.png')).toBeNull();
    expect(dropFileName('/x/dropsy/a.png')).toBeNull();
  });
  it('attachmentFromPath は、置き場の接頭辞（時刻と連番）を名前から落とす', () => {
    expect(attachmentFromPath('/Users/a/.agent-hangar/drops/1700-0-画面_1.png')).toEqual({ path: '/Users/a/.agent-hangar/drops/1700-0-画面_1.png', name: '画面_1.png', size: null });
    expect(attachmentFromPath('/Users/a/work/proj')).toEqual({ path: '/Users/a/work/proj', name: 'proj', size: null });
  });
  it('isImageName は拡張子で見る', () => {
    expect(['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp'].every(isImageName)).toBe(true);
    expect(['a.svg', 'a.log', 'png'].some(isImageName)).toBe(false);
  });
  it('formatSize は KB と MB で出す', () => {
    expect(formatSize(1)).toBe('1 KB');
    expect(formatSize(4000)).toBe('4 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
