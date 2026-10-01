import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { PageHeading } from './PageHeading.tsx';

describe('PageHeading', () => {
  it('親へのリンクを見出しの上に出し、押すとその頁へ移る', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><PageHeading title="名前" parent={{ label: 'agent-hangar', route: { name: 'project', id: 'p1' } }} /></IntentRoot>);
    expect(screen.getByRole('heading', { level: 1, name: '名前' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'agent-hangar' });
    expect(link.closest('.page-parent')).toBe(container.querySelector('.page-head > .page-parent'));
    fireEvent.click(link);
    expect(onIntent).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'project', id: 'p1' } });
  });
  // 親の行は親が無くても空けて取る。どの頁でも見出しと線の高さが揃う。
  it('親が無くても、親の行を空けて置く', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><PageHeading title="ホーム" /></IntentRoot>);
    const parent = container.querySelector('.page-head > .page-parent');
    expect(parent).not.toBeNull();
    expect(parent).toBeEmptyDOMElement();
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('長い名前は省略するので、全文を title で読める', () => {
    const long = 'Claude Projects活用検討と社内ナレッジの整理';
    render(<IntentRoot onIntent={() => {}}><PageHeading title={long} /></IntentRoot>);
    expect(screen.getByRole('heading', { name: long })).toHaveAttribute('title', long);
  });
  it('見出しの前後に置くものを、見出しの行に並べる', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><PageHeading title="セッション" lead={<i data-testid="lead" />} rowClassName="session-hero" hero="s1"><button type="button">再開</button></PageHeading></IntentRoot>);
    const row = container.querySelector('.page-title-row')!;
    expect(row).toHaveClass('session-hero');
    expect(row).toHaveAttribute('data-morph-hero', 's1');
    expect([...row.children].map((c) => c.tagName)).toEqual(['I', 'H1', 'BUTTON']);
  });

  describe('入り切らないときは、ボタンを印だけに縮める', () => {
    // jsdom は配置を計算しないので、行の幅と中身の幅をここで決める。中身の幅は縮めた印の有無で変える。
    const widths = (row: number, full: number, compact: number) => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('page-title-row') ? row : 0; });
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('page-title-row') ? (this.hasAttribute('data-compact') ? compact : full) : 0; });
    };
    afterEach(() => vi.restoreAllMocks());
    const heading = () => render(<IntentRoot onIntent={() => {}}><PageHeading title="名前"><button type="button" className="btn"><i /><span className="btn-label">再開</span></button></PageHeading></IntentRoot>);
    it('収まるときは縮めず、ボタンの名前を出したままにする', () => {
      widths(800, 600, 300);
      const { container } = heading();
      expect(container.querySelector('.page-title-row')).not.toHaveAttribute('data-compact');
      expect(screen.getByRole('button', { name: '再開' })).not.toHaveAttribute('title');
    });
    it('はみ出すときは縮め、名前は読み上げと title に残す', () => {
      widths(400, 600, 300);
      const { container } = heading();
      expect(container.querySelector('.page-title-row')).toHaveAttribute('data-compact', 'true');
      const btn = screen.getByRole('button', { name: '再開' });
      expect(btn).toHaveAttribute('title', '再開');
    });
  });
});
