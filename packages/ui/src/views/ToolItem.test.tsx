import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { countHits } from '../presenters/highlight.ts';
import { toolLeaves } from '../presenters/tools.ts';
import { toolItem } from '../test/items.ts';
import { MarkProvider } from './primitives/Hl.tsx';
import { renderItem } from './Transcript.tsx';
import { OpenContext } from './transcriptOpen.tsx';

afterEach(cleanup);

const draw = (item: ReturnType<typeof toolItem>) => render(<IntentRoot onIntent={vi.fn()}>{renderItem('s1', item)}</IntentRoot>);
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('ツールの行（T1、K1）', () => {
  it('1 行に札、要約、添え書き、結果の印、時刻を並べ、札の色は手の種類で決める', () => {
    const { container } = draw(toolItem(0, 'Bash', { command: 'npm test', description: 'テストを流す' }, { text: 'ok', isError: false }));
    const row = container.querySelector('.trow')!;
    expect(row.querySelector('.badge')?.textContent).toBe('Bash');
    expect(row.querySelector('.badge')?.getAttribute('data-k')).toBe('run');
    expect(row.querySelector('.tool-sum')?.textContent).toBe('npm test · テストを流す');
    expect(row.querySelector('.meta [data-tone="ok"]')?.textContent).toBe('0');
    expect(row.querySelector('.when')?.textContent).toBe('12:00');
  });
  it('失敗したツールの札は赤', () => {
    const { container } = draw(toolItem(0, 'Edit', { file_path: '/w/app/a.ts', old_string: 'a', new_string: 'b' }, { text: 'not found', isError: true }));
    expect(container.querySelector('.badge')?.getAttribute('data-k')).toBe('fail');
    expect(container.querySelector('.tool')?.getAttribute('data-failed')).toBe('true');
  });
  it('行を押すと中身を開き、もう一度押すと畳む', () => {
    const { container } = draw(toolItem(0, 'Bash', { command: 'npm test' }, { text: 'PASS', isError: false }));
    const row = screen.getByRole('button', { expanded: false });
    expect(container.querySelector('.bash')).toBeNull();
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.bash .cmd')?.textContent).toContain('npm test');
    expect(container.querySelector('.bash .out')?.textContent).toBe('PASS');
    expect(container.querySelector('.bash .foot')?.textContent).toContain('終了コード 0');
    fireEvent.click(row);
    expect(container.querySelector('.bash')).toBeNull();
  });
  it('生の入力の JSON は、生の記録を出すときだけ中身の下に出す', () => {
    const plain = toolItem(0, 'Bash', { command: 'npm test' }, { text: 'PASS', isError: false });
    const a = draw(plain);
    fireEvent.click(a.container.querySelector('.trow')!);
    expect(a.container.textContent).not.toContain('"command"');
    cleanup();
    const b = draw({ ...plain, raw: { input: '{\n  "command": "npm test"\n}', result: 'PASS' } });
    fireEvent.click(b.container.querySelector('.trow')!);
    expect(b.container.querySelector('.tool-raw')?.textContent).toContain('"command": "npm test"');
  });
});

describe('ツールの中身', () => {
  const open = (item: ReturnType<typeof toolItem>) => {
    const r = draw(item);
    fireEvent.click(r.container.querySelector('.trow')!);
    return r;
  };
  it('Edit は統合表示の差分で、行番号と + と − の行を上下に並べる', () => {
    const { container } = open(toolItem(0, 'Edit', { file_path: '/w/app/a.tsx', old_string: 'keep\nold', new_string: 'keep\nnew' },
      { text: "Here's the result of running `cat -n` on a snippet:\n    40→keep\n    41→new", isError: false }));
    expect(container.querySelector('.hunk')?.textContent).toBe('@@ -40,2 +40,2 @@');
    const rows = [...container.querySelectorAll('.dl')].map((r) => [r.getAttribute('data-t'), ...[...r.children].map((c) => c.textContent)]);
    expect(rows).toEqual([['ctx', '40', '40', '', 'keep'], ['del', '41', '', '−', 'old'], ['add', '', '41', '+', 'new']]);
  });
  it('Write は言語名とコピーの付いたコードに行番号を添える', () => {
    const { container } = open(toolItem(0, 'Write', { file_path: '/w/app/a.ts', content: 'const a = 1;\nexport { a };' }, { text: 'File created successfully', isError: false }));
    expect(container.querySelector('.code-lang')?.textContent).toBe('ts');
    expect([...container.querySelectorAll('.codeblock .ln')].map((x) => x.textContent)).toEqual(['1', '2']);
    expect(screen.getByRole('button', { name: 'コピー' })).toBeInTheDocument();
  });
  it('Read はパスと行の範囲', () => {
    const { container } = open(toolItem(0, 'Read', { file_path: '/w/app/a.ts', offset: 10, limit: 20 }, { text: '', isError: false }));
    expect(container.querySelector('.tool-read')?.textContent).toContain('a.ts');
    expect(container.querySelector('.tool-read .range')?.textContent).toBe('10〜29 行');
  });
  it('WebFetch は宛先を外で開くリンクにし、聞いたことと答えを出す', () => {
    const { container } = open(toolItem(0, 'WebFetch', { url: 'https://example.com/d', prompt: '要約して' }, { text: '答え', isError: false }));
    const a = container.querySelector('.tool-web a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/d');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('.tool-web .q')?.textContent).toContain('要約して');
    expect(container.querySelector('.tool-web .r')?.textContent).toBe('答え');
  });
  it('WebSearch は結果の題をリンクにし、ドメインを添える', () => {
    const { container } = open(toolItem(0, 'WebSearch', { query: 'q' }, { text: 'Links: [{"title":"題","url":"https://docs.example.com/r"}]', isError: false }));
    expect(container.querySelector('.tool-links a')?.textContent).toBe('題');
    expect(container.querySelector('.tool-links .dom')?.textContent).toBe('docs.example.com');
  });
  it('Grep は引数の表と、下に結果', () => {
    const { container } = open(toolItem(0, 'Grep', { pattern: 'X', path: '/w/app/src' }, { text: 'Found 1 file\n/w/app/src/a.ts', isError: false }));
    expect([...container.querySelectorAll('.tool-args dt')].map((x) => x.textContent)).toEqual(['pattern', 'path']);
    expect(container.querySelector('.tool-result')?.textContent).toContain('Found 1 file');
  });
});

describe('長い中身の畳み（F1）', () => {
  it('出力は 12 行で切って下端をぼかし、「全文を表示（残り N 行）」で開き、「畳む」で戻す', () => {
    const { container } = draw(toolItem(0, 'Bash', { command: 'npm test' }, { text: lines(40), isError: false }));
    fireEvent.click(container.querySelector('.trow')!);
    expect(container.querySelector('.bash .out')?.textContent?.split('\n')).toHaveLength(12);
    expect(container.querySelector('.clamp[data-clamped="true"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '全文を表示（残り 28 行）' }));
    expect(container.querySelector('.bash .out')?.textContent?.split('\n')).toHaveLength(40);
    fireEvent.click(screen.getByRole('button', { name: '畳む' }));
    expect(container.querySelector('.bash .out')?.textContent?.split('\n')).toHaveLength(12);
  });
  it('少しだけ長い出力は切らない', () => {
    const { container } = draw(toolItem(0, 'Bash', { command: 'npm test' }, { text: lines(14), isError: false }));
    fireEvent.click(container.querySelector('.trow')!);
    expect(container.querySelector('.bash .out')?.textContent?.split('\n')).toHaveLength(14);
    expect(screen.queryByRole('button', { name: /全文を表示/ })).toBeNull();
  });
});

describe('印の数とデータで数えた一致の数', () => {
  const q = 'hit';
  const all = { get: () => undefined, set: () => {}, revealed: () => true };
  const cases = [
    toolItem(0, 'Edit', { file_path: '/w/app/hit.ts', old_string: 'a hit\nkeep', new_string: 'b hit hit\nkeep' }, { text: 'ok', isError: false }),
    toolItem(0, 'MultiEdit', { file_path: '/w/app/a.ts', edits: [{ old_string: 'hit', new_string: 'HIT' }] }, { text: 'ok', isError: false }),
    toolItem(0, 'Write', { file_path: '/w/app/a.ts', content: `hit\n${lines(30)}\nhit` }, { text: 'ok', isError: false }),
    toolItem(0, 'Bash', { command: 'echo hit', description: 'hit it' }, { text: `hit\n${lines(30)}\nhit`, isError: false }),
    toolItem(0, 'Read', { file_path: '/w/app/hit.ts' }, { text: '', isError: false }),
    toolItem(0, 'WebFetch', { url: 'https://hit.example', prompt: 'hit?' }, { text: 'hit', isError: false }),
    toolItem(0, 'WebSearch', { query: 'hit' }, { text: 'Links: [{"title":"hit","url":"https://a.example"}]', isError: false }),
    toolItem(0, 'Grep', { pattern: 'hit' }, { text: 'hit\nhit', isError: false }),
    toolItem(0, 'Agent', { description: 'hit', prompt: 'hit hit' }, { text: 'hit', isError: false }),
    toolItem(0, 'mcp__x', { a: 'hit', b: { c: 'hit' } }, { text: 'hit', isError: true }),
  ];
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, item) => {
    const { container } = render(
      <IntentRoot onIntent={vi.fn()}><OpenContext.Provider value={all}><MarkProvider value={{ query: q, literal: true }}>{renderItem('s1', item)}</MarkProvider></OpenContext.Provider></IntentRoot>,
    );
    const want = toolLeaves(item.view).reduce((n, leaf) => n + countHits(leaf, q, { literal: true }), 0);
    expect(want).toBeGreaterThan(0);
    expect(container.querySelectorAll('mark.hit')).toHaveLength(want);
  });
});
