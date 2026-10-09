import { translator, type ToolCallEvent } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { presentTool, toolLeaves } from './tools.ts';

const call = (name: string, input: unknown): ToolCallEvent => ({ kind: 'tool_call', seq: 0, toolId: 't', name, input, summary: `${name} x` });
const ok = (text: string) => ({ text, isError: false });
const ng = (text: string) => ({ text, isError: true });
const CWD = '/w/app';
const ja = translator('ja');
const en = translator('en');

describe('presentTool の札の色', () => {
  it('手の種類は live-explainer の規則に従い、失敗は種類より先に赤にする', () => {
    expect(presentTool(call('Read', { file_path: '/w/app/a.ts' }), ok(''), CWD, ja).step).toBe('read');
    expect(presentTool(call('Edit', { file_path: '/w/app/a.ts', old_string: 'a', new_string: 'b' }), ok(''), CWD, ja).step).toBe('write');
    expect(presentTool(call('Bash', { command: 'npm test' }), ok(''), CWD, ja).step).toBe('run');
    expect(presentTool(call('Bash', { command: 'git commit -m x' }), ok(''), CWD, ja).step).toBe('git');
    expect(presentTool(call('WebFetch', { url: 'https://x.example' }), ok(''), CWD, ja).step).toBe('read');
    expect(presentTool(call('TodoWrite', { todos: [] }), ok(''), CWD, ja).step).toBe('other');
    expect(presentTool(call('Bash', { command: 'npm test' }), ng('Exit code 1'), CWD, ja).step).toBe('fail');
  });
  it('git の読むだけのサブコマンドは読む札、作り替えもある branch と worktree はその他の札', () => {
    expect(presentTool(call('Bash', { command: 'git status --short' }), ok(''), CWD, ja).step).toBe('read');
    expect(presentTool(call('Bash', { command: 'git branch -D old' }), ok(''), CWD, ja).step).toBe('other');
    expect(presentTool(call('Bash', { command: 'git worktree add ../w b' }), ok(''), CWD, ja).step).toBe('other');
  });
});

describe('presentTool の中身', () => {
  it('Edit は統合表示の差分にし、抜粋から行番号を読んで、足した数と消した数を添える', () => {
    const v = presentTool(call('Edit', { file_path: '/w/app/src/a.tsx', old_string: '  <form>\n  <X />', new_string: '  <form>\n  <Y />\n  <Z />' }),
      ok("The file /w/app/src/a.tsx has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n    40→  <form>\n    41→  <Y />"), CWD, ja);
    expect(v.head).toEqual({ main: 'src/a.tsx', dim: null, meta: [{ text: '+2', tone: 'add' }, { text: '−1', tone: 'del' }] });
    expect(v.body.kind).toBe('diff');
    if (v.body.kind !== 'diff') return;
    expect(v.body.hunks).toHaveLength(1);
    expect(v.body.hunks[0]!.header).toBe('@@ -40,2 +40,3 @@');
    expect(v.result).toBeNull();
  });
  it('Edit の失敗は、差分に加えて結果の文を出す', () => {
    const v = presentTool(call('Edit', { file_path: '/w/app/a.ts', old_string: 'a', new_string: 'b' }), ng('String to replace not found in file.'), CWD, ja);
    expect(v.result).toBe('String to replace not found in file.');
  });
  it('MultiEdit は 1 か所ずつを見出しの付いた差分にする', () => {
    const v = presentTool(call('MultiEdit', { file_path: '/w/app/v.ts', edits: [{ old_string: 'a', new_string: 'A' }, { old_string: '', new_string: 'x\ny' }] }), ok('Applied 2 edits'), CWD, ja);
    expect(v.head).toEqual({ main: 'v.ts', dim: '2 か所', meta: [{ text: '+3', tone: 'add' }, { text: '−1', tone: 'del' }] });
    if (v.body.kind !== 'diff') throw new Error('diff');
    expect(v.body.hunks.map((h) => h.header)).toEqual(['@@ 1 か所目 @@', '@@ 2 か所目 @@']);
  });
  it('Write はパスと言語と行数のコードにし、新しく作ったときはそう添える', () => {
    const v = presentTool(call('Write', { file_path: '/w/app/src/a.test.tsx', content: 'a\nb\nc' }), ok('File created successfully at: /w/app/src/a.test.tsx'), CWD, ja);
    expect(v.head).toEqual({ main: 'src/a.test.tsx', dim: '新しいファイル', meta: [{ text: '3 行', tone: 'plain' }] });
    expect(v.body).toEqual({ kind: 'code', lang: 'tsx', text: 'a\nb\nc', note: '3 行', created: true });
  });
  it('Bash はコマンドと出力にし、成功は終了コード 0、失敗は結果の頭の終了コードを読む', () => {
    const good = presentTool(call('Bash', { command: 'npm test -- a\necho done', description: 'テストを流す' }), ok('PASS\nTests: 6 passed'), CWD, ja);
    expect(good.head).toEqual({ main: 'npm test -- a', dim: 'テストを流す', meta: [{ text: '0', tone: 'ok' }] });
    expect(good.body).toEqual({ kind: 'bash', command: 'npm test -- a\necho done', output: 'PASS\nTests: 6 passed', exit: 0, failed: false });
    const bad = presentTool(call('Bash', { command: 'npm run lint' }), ng('Exit code 1\nerror  x is unused'), CWD, ja);
    expect(bad.head.meta).toEqual([{ text: '終了 1', tone: 'ng' }]);
    expect(bad.body).toEqual({ kind: 'bash', command: 'npm run lint', output: 'error  x is unused', exit: 1, failed: true });
    const stopped = presentTool(call('Bash', { command: 'sleep 9' }), ng('[Request interrupted by user for tool use]'), CWD, ja);
    expect(stopped.head.meta).toEqual([{ text: '失敗', tone: 'ng' }]);
    const pending = presentTool(call('Bash', { command: 'sleep 9' }), null, CWD, ja);
    expect(pending.head.meta).toEqual([]);
  });
  it('Read はパスと行の範囲。範囲は offset と limit から、無ければ結果の行番号から読む', () => {
    expect(presentTool(call('Read', { file_path: '/w/app/i18n/ja.json', offset: 120, limit: 41 }), ok(''), CWD, ja).body).toEqual({ kind: 'read', path: 'i18n/ja.json', range: '120〜160 行' });
    const v = presentTool(call('Read', { file_path: '/w/app/a.tsx' }), ok('     1→import x\n     2→\n    84→}'), CWD, ja);
    expect(v.head).toEqual({ main: 'a.tsx', dim: '1〜84 行', meta: [] });
    expect(presentTool(call('Read', { file_path: '/elsewhere/b.png' }), ok('[image]'), CWD, ja).body).toEqual({ kind: 'read', path: '/elsewhere/b.png', range: null });
  });
  it('WebFetch は URL と聞いたことと答え', () => {
    const v = presentTool(call('WebFetch', { url: 'https://example.com/docs/resolver', prompt: '要約して' }), ok('resolver には…'), CWD, ja);
    expect(v.head.main).toBe('example.com/docs/resolver');
    expect(v.body).toEqual({ kind: 'fetch', url: 'https://example.com/docs/resolver', prompt: '要約して', text: 'resolver には…' });
  });
  it('WebSearch は検索語と、結果のリンクの一覧', () => {
    const text = 'Web search results for query: "react resolver"\n\nLinks: [{"title":"Resolver の使い方","url":"https://docs.example.com/r"},{"title":"B","url":"https://blog.example.org/b"}]\n\n要旨';
    const v = presentTool(call('WebSearch', { query: 'react resolver' }), ok(text), CWD, ja);
    expect(v.head).toEqual({ main: 'react resolver', dim: null, meta: [{ text: '2 件', tone: 'plain' }] });
    expect(v.body).toEqual({ kind: 'search', query: 'react resolver', links: [{ title: 'Resolver の使い方', url: 'https://docs.example.com/r', domain: 'docs.example.com' }, { title: 'B', url: 'https://blog.example.org/b', domain: 'blog.example.org' }] });
  });
  it('WebSearch の結果のうち http と https でないリンクは落とす', () => {
    const v = presentTool(call('WebSearch', { query: 'q' }), ok('Links: [{"title":"x","url":"javascript:alert(1)"}]'), CWD, ja);
    expect(v.body).toEqual({ kind: 'search', query: 'q', links: [] });
  });
  it('Grep は引数を整形し、結果の件数を添えて、結果は下に出す', () => {
    const v = presentTool(call('Grep', { pattern: 'ErrorSummary', path: '/w/app/src', glob: '*.tsx', output_mode: 'files_with_matches' }), ok('Found 2 files\n/w/app/src/a.tsx\n/w/app/src/b.tsx'), CWD, ja);
    expect(v.head).toEqual({ main: 'ErrorSummary', dim: 'in src *.tsx', meta: [{ text: '2 ファイル', tone: 'plain' }] });
    expect(v.body).toEqual({ kind: 'args', rows: [{ key: 'pattern', value: 'ErrorSummary' }, { key: 'path', value: 'src' }, { key: 'glob', value: '*.tsx' }, { key: 'output_mode', value: 'files_with_matches' }] });
    expect(v.result).toBe('Found 2 files\n/w/app/src/a.tsx\n/w/app/src/b.tsx');
  });
  it('Task と Agent は頼んだ仕事の説明とサブエージェントの種類', () => {
    const v = presentTool(call('Agent', { description: 'SignupForm を調べる', subagent_type: 'Explore', prompt: '読んで挙げて' }), ok('報告'), CWD, ja);
    expect(v.head).toEqual({ main: 'SignupForm を調べる', dim: null, meta: [{ text: 'Explore', tone: 'plain' }] });
    expect(v.body).toEqual({ kind: 'args', rows: [{ key: 'description', value: 'SignupForm を調べる' }, { key: 'subagent_type', value: 'Explore' }, { key: 'prompt', value: '読んで挙げて' }] });
    expect(v.result).toBe('報告');
  });
  it('SubagentHandback は右の欄と同じく「報告を返した」と書き、報告の本文は中身に出す', () => {
    const v = presentTool({ ...call('SubagentHandback', { message: '0 件（空ディレクトリ）' }), summary: 'SubagentHandback' }, ok('delivered'), CWD, ja);
    expect(v.step).toBe('other');
    expect(v.head).toEqual({ main: '報告を返した', dim: null, meta: [] });
    expect(v.body).toEqual({ kind: 'args', rows: [{ key: 'message', value: '0 件（空ディレクトリ）' }] });
    expect(v.result).toBeNull();
    expect(presentTool(call('SubagentHandback', { message: 'x' }), ng('failed'), CWD, ja).result).toBe('failed');
  });
  it('TodoWrite は項目ごとの状態と中身', () => {
    const v = presentTool(call('TodoWrite', { todos: [{ content: '読む', status: 'completed' }, { content: '直す', status: 'in_progress' }, { content: '流す', status: 'pending' }] }), ok('ok'), CWD, ja);
    expect(v.head).toEqual({ main: 'TODO 3 件', dim: '済み 1', meta: [] });
    expect(v.body).toEqual({ kind: 'args', rows: [{ key: '済み', value: '読む' }, { key: '作業中', value: '直す' }, { key: '未着手', value: '流す' }] });
  });
  it('その他のツールは引数を 1 つずつ並べ、文字でない値は整形した JSON にする', () => {
    const v = presentTool({ ...call('mcp__hangar__search', { q: 'x', limit: 5, opts: { a: 1 } }), summary: 'mcp__hangar__search x' }, ok('結果'), CWD, ja);
    expect(v.head.main).toBe('x');
    expect(v.body).toEqual({ kind: 'args', rows: [{ key: 'q', value: 'x' }, { key: 'limit', value: '5' }, { key: 'opts', value: '{\n  "a": 1\n}' }] });
    expect(v.result).toBe('結果');
  });
});

describe('toolLeaves', () => {
  it('行の要約と中身の文字を、描く順に並べる', () => {
    const v = presentTool(call('Bash', { command: 'npm test', description: '流す' }), ok('PASS'), CWD, ja);
    expect(toolLeaves(v)).toEqual(['npm test', '流す', 'npm test', 'PASS']);
  });
});

describe('presentTool（英語）', () => {
  const JAPANESE = /[぀-ヿ㐀-鿿]/;
  const noJapanese = (v: unknown) => expect(JSON.stringify(v)).not.toMatch(JAPANESE);
  it('Write と MultiEdit と Bash の添え書きが英語で出る（複数形を含む）', () => {
    const w = presentTool(call('Write', { file_path: '/w/app/a.ts', content: 'a\nb\nc' }), ok('File created successfully'), CWD, en);
    expect(w.head).toMatchObject({ dim: 'New file', meta: [{ text: '3 lines' }] });
    expect(presentTool(call('Write', { file_path: '/w/app/a.ts', content: 'a' }), ok('File created successfully'), CWD, en).head.meta[0]!.text).toBe('1 line');
    const m = presentTool(call('MultiEdit', { file_path: '/w/app/v.ts', edits: [{ old_string: 'a', new_string: 'A' }] }), ok('Applied'), CWD, en);
    expect(m.head.dim).toBe('1 edit');
    const m2 = presentTool(call('MultiEdit', { file_path: '/w/app/v.ts', edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'b', new_string: 'B' }] }), ok('Applied'), CWD, en);
    expect(m2.head.dim).toBe('2 edits');
    expect(m2.body).toMatchObject({ kind: 'diff', hunks: [{ header: '@@ Edit 1 @@' }, { header: '@@ Edit 2 @@' }] });
    expect(presentTool(call('Bash', { command: 'x' }), ng('Exit code 2\nboom'), CWD, en).head.meta).toEqual([{ text: 'Exit 2', tone: 'ng' }]);
    noJapanese([w, m, m2]);
  });
  it('Read の範囲、検索の件数、TODO、Grep の件数が英語で出る', () => {
    expect(presentTool(call('Read', { file_path: '/w/app/a.ts', offset: 120, limit: 41 }), ok(''), CWD, en).body).toEqual({ kind: 'read', path: 'a.ts', range: 'Lines 120–160' });
    expect(presentTool(call('Read', { file_path: '/w/app/a.ts', offset: 5 }), ok(''), CWD, en).head.dim).toBe('From line 5');
    const s = presentTool(call('WebSearch', { query: 'q' }), ok('Links: [{"title":"a","url":"https://a.example/x"}]'), CWD, en);
    expect(s.head.meta).toEqual([{ text: '1 result', tone: 'plain' }]);
    const todo = presentTool(call('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] }), ok('ok'), CWD, en);
    expect(todo.head).toMatchObject({ main: '3 to-dos', dim: 'Done 1' });
    expect(todo.body).toMatchObject({ kind: 'args', rows: [{ key: 'Done' }, { key: 'In progress' }, { key: 'Not started' }] });
    const g = presentTool(call('Grep', { pattern: 'x' }), ok('Found 1 file\n/w/app/a.ts'), CWD, en);
    expect(g.head.meta).toEqual([{ text: '1 file', tone: 'plain' }]);
    expect(presentTool(call('Grep', { pattern: 'x' }), ok('No matches found'), CWD, en).head.meta).toEqual([{ text: 'None', tone: 'plain' }]);
    noJapanese([s, todo, g]);
  });
});
