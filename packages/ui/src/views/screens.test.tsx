import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { pick } from '../test/pick.ts';
import { ProjectScreen } from './ProjectScreen.tsx';

// Task 22 で ProjectProps に増えた右レールの分。この節が見るのはヘッダーの操作だけなので空にする。
const rail = { pager: null, isScratch: false, todos: [], memo: null, artifacts: [], parent: { label: 'プロジェクト', route: { name: 'projects' as const } } };

// プロジェクト画面は、そのプロジェクトのページを list.page で覚える。ホームの一覧は search.page で覚える。
describe('プロジェクト画面のページ送り', () => {
  const pager = { page: 1, pageCount: 4, size: 50, sizes: [25, 50, 100, 200], from: 1, to: 50, total: 180 };
  it('プロジェクト画面は広げた節が長いときに帯を出し、そのプロジェクトのページを移る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" items={[]} notFound={false} {...rail} pager={pager} /></IntentRoot>);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'セッションのページ' })).getByRole('button', { name: '次のページ' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'list.page', key: 'project:alpha', page: 2 });
  });
});

describe('ProjectScreen', () => {
  it('見つからないときの表示と、操作ボタンの Intent', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><ProjectScreen id="x" name="x" path={null} resolved={false} status="active" items={[]} notFound {...rail} /></IntentRoot>);
    expect(screen.getByText('プロジェクトが見つかりません')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path={null} resolved={false} status="active" items={[]} notFound={false} {...rail} /></IntentRoot>);
    expect(screen.getByText('この PC にパスがありません')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" items={[]} notFound={false} {...rail} /></IntentRoot>);
    // 新しいセッションの主ボタンはヘッダーにあるので、見出しの行には並べない。
    expect(screen.queryByText('新しいセッション')).toBeNull();
    expect(screen.getByText('/w/alpha')).toBeInTheDocument();
  });
  it('プロジェクトの操作は project.* の Intent', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" items={[]} notFound={false} {...rail} /></IntentRoot>);
    fireEvent.click(screen.getByText('VS Code で開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.openEditor', id: 'alpha' });
    fireEvent.click(screen.getByText('ターミナルで開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.openTerminalApp', id: 'alpha' });
  });
});

const iconOf = (el: Element | null) => el?.querySelector('svg')?.getAttribute('data-icon') ?? null;

describe('プロジェクトまわりのアイコン', () => {
  it('ProjectScreen の操作ボタン', () => {
    render(<IntentRoot onIntent={vi.fn()}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" items={[]} notFound={false} {...rail} /></IntentRoot>);
    expect(iconOf(screen.getByRole('button', { name: 'VS Code で開く' }))).toBe('openEditor');
    expect(iconOf(screen.getByRole('button', { name: 'ターミナルで開く' }))).toBe('openTerminal');
  });
});

describe('プロジェクトのステータスの色', () => {
  it('詳細画面の select が data-status を持つ', () => {
    render(<IntentRoot onIntent={vi.fn()}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="done" items={[]} notFound={false} {...rail} /></IntentRoot>);
    expect(screen.getByLabelText('状態').getAttribute('data-status')).toBe('done');
  });
});

describe('ProjectScreen の右レールの読む面', () => {
  // アーティファクトの節も白い面に載せ、面の中のカードは淡い地で重ねる（見出しと空のときの文が光の上に出ないように）。
  it('TODO、メモ、アーティファクトの節は白い面に載る', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" items={[]} notFound={false} {...rail} /></IntentRoot>);
    const panels = [...container.querySelectorAll('.rail > .rail-panel')];
    expect(panels.map((p) => p.querySelector('.h2')?.textContent)).toEqual(['TODO', 'メモ', 'アーティファクト']);
  });
});
