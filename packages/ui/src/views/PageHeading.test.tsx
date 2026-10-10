import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { PageHeading } from './PageHeading.tsx';

describe('PageHeading', () => {
  it('親へのリンクを見出しの上に出し、押すとその頁へ移る', () => {
    const onAction = vi.fn();
    const { container } = render(<ActionRoot onAction={onAction}><PageHeading title="名前" parent={{ label: 'agent-hangar', route: { name: 'project', id: 'p1' } }} /></ActionRoot>);
    expect(screen.getByRole('heading', { level: 1, name: '名前' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'agent-hangar' });
    expect(link.closest('.page-parent')).toBe(container.querySelector('.page-head > .page-parent'));
    fireEvent.click(link);
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'project', id: 'p1' } });
  });
  // 親の行は親が無くても空けて取る。どの頁でも見出しと線の高さが揃う。
  it('親が無くても、親の行を空けて置く', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><PageHeading title="ホーム" /></ActionRoot>);
    const parent = container.querySelector('.page-head > .page-parent');
    expect(parent).not.toBeNull();
    expect(parent).toBeEmptyDOMElement();
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('長い名前は省略するので、全文を title で読める', () => {
    const long = 'Claude Projects活用検討と社内ナレッジの整理';
    render(<ActionRoot onAction={() => {}}><PageHeading title={long} /></ActionRoot>);
    expect(screen.getByRole('heading', { name: long })).toHaveAttribute('title', long);
  });
  it('見出しの前後に置くものを、見出しの行に並べる', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><PageHeading title="セッション" lead={<i data-testid="lead" />} rowClassName="session-hero" hero="s1"><button type="button">再開</button></PageHeading></ActionRoot>);
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
    const heading = () => render(<ActionRoot onAction={() => {}}><PageHeading title="名前"><button type="button" className="btn"><i /><span className="btn-label">再開</span></button></PageHeading></ActionRoot>);
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
    it('ボタンが自分の title（押せない理由など）を持つときは、縮めても消さず、名前に添える', () => {
      // セッション画面の主の操作は、押せない理由を title に持つ（views/SessionScreen.tsx）。
      let rowW = 800;
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('page-title-row') ? rowW : 0; });
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('page-title-row') ? (this.hasAttribute('data-compact') ? 300 : 600) : 0; });
      const view = (title: string) => <ActionRoot onAction={() => {}}><PageHeading title="名前"><button type="button" className="btn" title={title}><i /><span className="btn-label">再開</span></button></PageHeading></ActionRoot>;
      const { rerender } = render(view('本文がありません'));
      const btn = screen.getByRole('button', { name: '再開' });
      expect(btn).toHaveAttribute('title', '本文がありません');
      rowW = 400;
      rerender(view('本文がありません'));
      expect(btn).toHaveAttribute('title', '再開（本文がありません）');
      // 縮めている間に理由が変わっても、新しい理由を添える。
      rerender(view('他の PC で実行中です'));
      expect(btn).toHaveAttribute('title', '再開（他の PC で実行中です）');
      rowW = 800;
      rerender(view('他の PC で実行中です'));
      expect(btn).toHaveAttribute('title', '他の PC で実行中です');
    });
  });
});
