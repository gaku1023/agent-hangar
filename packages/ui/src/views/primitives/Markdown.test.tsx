import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown, parseBlocks } from './Markdown.tsx';

afterEach(cleanup);

describe('parseBlocks', () => {
  it('囲みのコードは 1 つの塊にし、前後の文から改行を 1 つずつ落とす', () => {
    expect(parseBlocks('前の文\n```sh\nls -a\ncd /\n```\n後の文')).toEqual([
      { kind: 'text', text: '前の文' },
      { kind: 'code', text: 'ls -a\ncd /' },
      { kind: 'text', text: '後の文' },
    ]);
  });
  it('閉じていない囲みは末尾までコードにする', () => {
    expect(parseBlocks('説明\n```\nnpm run build')).toEqual([
      { kind: 'text', text: '説明' },
      { kind: 'code', text: 'npm run build' },
    ]);
  });
  it('# で始まる行は見出しにする', () => {
    expect(parseBlocks('## 結果\n本文')).toEqual([
      { kind: 'heading', text: '結果' },
      { kind: 'text', text: '本文' },
    ]);
  });
  it('段落の間の空行はそのまま残す', () => {
    expect(parseBlocks('一段落目\n\n二段落目')).toEqual([{ kind: 'text', text: '一段落目\n\n二段落目' }]);
  });
});

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
    const { container } = render(<Markdown text={'<b>x</b>'} />);
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toBe('<b>x</b>');
  });
});
