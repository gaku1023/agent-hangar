import { describe, expect, it } from 'vitest';
import { commandWords, isTurnPrompt, stepKind, stepLine, type ToolCallEvent } from './steps.ts';

const call = (name: string, input: unknown, summary = name): ToolCallEvent => ({ kind: 'tool_call', seq: 0, toolId: 't', name, input, summary });
const bash = (command: string, description?: string) => call('Bash', description === undefined ? { command } : { command, description });

describe('commandWords', () => {
  it('cd <dir> && と環境変数の代入を読み飛ばす', () => {
    expect(commandWords('cd /w/app && npm test')).toEqual(['npm', 'test']);
    expect(commandWords('LC_ALL=C FOO=1 grep -n x a.ts')).toEqual(['grep', '-n', 'x', 'a.ts']);
    expect(commandWords('cd /w && cd sub && git status')).toEqual(['git', 'status']);
    expect(commandWords('cd /w')).toEqual([]);
  });
});

describe('stepKind', () => {
  it('ツール名で決まるもの', () => {
    expect(stepKind(call('Read', { file_path: '/w/a.ts' }))).toBe('read');
    expect(stepKind(call('Grep', { pattern: 'x' }))).toBe('read');
    expect(stepKind(call('Edit', { file_path: '/w/a.ts' }))).toBe('write');
    expect(stepKind(call('Write', { file_path: '/w/a.ts' }))).toBe('write');
    expect(stepKind(call('Agent', { description: 'd' }))).toBe('other');
  });
  it('Bash はコマンドの頭の語で決める', () => {
    expect(stepKind(bash('sed -n 1,40p a.ts'))).toBe('read');
    expect(stepKind(bash("sed -i '' 's/a/b/' a.ts"))).toBe('write');
    expect(stepKind(bash('cat a.ts | head'))).toBe('read');
    expect(stepKind(bash('mkdir -p out && cp a b'))).toBe('write');
    expect(stepKind(bash('npx vitest run packages/server'))).toBe('run');
    expect(stepKind(bash('cd /w && npm run typecheck'))).toBe('run');
    expect(stepKind(bash('git status --short'))).toBe('read');
    expect(stepKind(bash('git -C /w log --oneline -3'))).toBe('read');
    // 作り替える手もあるので、branch と worktree は読み取りに数えない。
    expect(stepKind(bash('git branch -D old'))).toBe('other');
    expect(stepKind(bash('git worktree add ../w b'))).toBe('other');
    expect(stepKind(bash('git commit -m x'))).toBe('git');
    expect(stepKind(bash('git push origin b'))).toBe('git');
    expect(stepKind(bash('curl -s http://127.0.0.1:4177/health'))).toBe('other');
    expect(stepKind(call('Bash', {}))).toBe('other');
  });
});

describe('stepLine', () => {
  it('Bash は description を使い、無ければコマンドの 1 行目を等幅で出す', () => {
    expect(stepLine(bash('npx vitest run', 'テストを走らせる'))).toEqual({ text: 'テストを走らせる', mono: false });
    expect(stepLine(bash('ls -la\necho done'))).toEqual({ text: 'ls -la', mono: true });
  });
  it('ファイルを扱うツールはファイル名で書く', () => {
    expect(stepLine(call('Read', { file_path: '/w/packages/server/src/a.ts' }))).toEqual({ text: '読んだ：a.ts', mono: false });
    expect(stepLine(call('Edit', { file_path: '/w/b.ts' }))).toEqual({ text: 'b.ts を書き換えた', mono: false });
    expect(stepLine(call('Write', { file_path: '/w/c.md' }))).toEqual({ text: 'c.md を書いた', mono: false });
    expect(stepLine(call('Grep', { pattern: 'renderInjection' }))).toEqual({ text: '探した：renderInjection', mono: false });
  });
  it('サブエージェントの報告は、本文を出さず「報告を返した」と書く', () => {
    expect(stepLine(call('SubagentHandback', { message: '0 件（空ディレクトリ）' }))).toEqual({ text: '報告を返した', mono: false });
  });
  it('そのほかはツール名と今の summary', () => {
    expect(stepLine(call('WebFetch', { url: 'https://x' }, 'WebFetch https://x'))).toEqual({ text: 'WebFetch https://x', mono: false });
  });
});

describe('isTurnPrompt', () => {
  it('中断の知らせは指示ではない', () => {
    expect(isTurnPrompt('続けて')).toBe(true);
    expect(isTurnPrompt('[Request interrupted by user]')).toBe(false);
  });
});
