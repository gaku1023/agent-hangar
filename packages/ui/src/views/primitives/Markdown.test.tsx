import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countHits } from '../../presenters/highlight.ts';
import { mdLeaves, parseMarkdown } from '../../presenters/markdown.ts';
import { MarkProvider } from './Hl.tsx';
import { Markdown } from './Markdown.tsx';

afterEach(cleanup);

describe('Markdown', () => {
  it('太字とインラインのコードは記号を外して描く', () => {
    const { container } = render(<Markdown text={'**1. main へ入れる** には `git merge` を打つ'} />);
    expect(container.querySelector('strong')?.textContent).toBe('1. main へ入れる');
    expect(container.querySelector('code')?.textContent).toBe('git merge');
    expect(container.textContent).toBe('1. main へ入れる には git merge を打つ');
  });
  it('対になっていない記号はそのまま出す', () => {
    const { container } = render(<Markdown text={'a ** b と `c'} />);
    expect(container.textContent).toBe('a ** b と `c');
    expect(container.querySelector('strong')).toBeNull();
  });
  it('コードの塊の中では太字の記号を解釈しない', () => {
    const { container } = render(<Markdown text={'```\n**x**\n```'} />);
    expect(container.querySelector('pre')?.textContent).toBe('**x**');
  });
  it('HTML は文字として出す', () => {
    const { container } = render(<Markdown text={'<b>x</b><script>alert(1)</script>'} />);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toBe('<b>x</b><script>alert(1)</script>');
  });
  it('見出しは段に合わせた見出しの要素にする', () => {
    const { container } = render(<Markdown text={'## 変えたところ\n### 細かい所'} />);
    expect(container.querySelector('h2')?.textContent).toBe('変えたところ');
    expect(container.querySelector('h3')?.textContent).toBe('細かい所');
  });
  it('箇条書きは入れ子の ul、番号付きは始まりの番号を持つ ol にする', () => {
    const { container } = render(<Markdown text={'- a\n  - b\n\n3. c\n4. d'} />);
    expect(container.querySelector('ul > li > ul > li')?.textContent).toBe('b');
    const ol = container.querySelector('ol');
    expect(ol?.getAttribute('start')).toBe('3');
    expect(ol?.querySelectorAll('li')).toHaveLength(2);
  });
  it('表は見出しの行と本体の行を持つ table にする', () => {
    const { container } = render(<Markdown text={'| 欄 | 条件 |\n|---|---:|\n| メール | 形 |'} />);
    expect([...container.querySelectorAll('th')].map((x) => x.textContent)).toEqual(['欄', '条件']);
    expect([...container.querySelectorAll('tbody td')].map((x) => x.textContent)).toEqual(['メール', '形']);
    expect((container.querySelectorAll('td')[1] as HTMLElement).style.textAlign).toBe('right');
  });
  it('http と https のリンクは外で開くリンクにし、ほかはリンクにしない', () => {
    const { container } = render(<Markdown text={'[説明](https://example.com/a) と [悪い](javascript:alert(1))'} />);
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://example.com/a');
    expect(links[0]!.getAttribute('target')).toBe('_blank');
    expect(links[0]!.getAttribute('rel')).toContain('noreferrer');
    expect(container.textContent).toContain('悪い');
  });
  it('囲みのコードは言語名とコピーのボタンを持ち、押すと中身を写す', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container, getByRole } = render(<Markdown text={'```ts\nconst a = 1;\n```'} />);
    expect(container.querySelector('.code-lang')?.textContent).toBe('ts');
    await act(async () => { fireEvent.click(getByRole('button', { name: 'コピー' })); });
    expect(writeText).toHaveBeenCalledWith('const a = 1;');
    expect(getByRole('button', { name: 'コピーしました' })).toBeInTheDocument();
  });
  it('印の文脈があれば、描いた葉の一致に印を付け、その数はデータで数えた数と同じ', () => {
    const text = '## バリデーション\n入力の**バリデーション**を足す。\n\n| 欄 | バリデーション |\n|---|---|\n| a | b |\n\n- [バリデーション](https://x.example)\n\n```\nバリデーション()\n```';
    const { container } = render(<MarkProvider value={{ query: 'バリデーション', literal: true, caseSensitive: false }}><Markdown text={text} /></MarkProvider>);
    const want = mdLeaves(parseMarkdown(text)).reduce((n, leaf) => n + countHits(leaf, 'バリデーション', { literal: true }), 0);
    expect(want).toBe(5);
    expect(container.querySelectorAll('mark.hit')).toHaveLength(want);
  });
});
