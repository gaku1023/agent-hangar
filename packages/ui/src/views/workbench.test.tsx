import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { IntentRoot } from '../intent/chain.tsx';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { ArtifactCards } from './ArtifactCards.tsx';
import { Header } from './Header.tsx';
import { MemoEditor } from './MemoEditor.tsx';
import { ProjectScreen } from './ProjectScreen.tsx';
import { TodoList } from './TodoList.tsx';
import { RollingNumber } from './primitives/RollingNumber.tsx';
import { UsageGauge } from './primitives/UsageGauge.tsx';

const art = (id: string, over: Partial<ArtifactCardProps> = {}): ArtifactCardProps => ({ id, title: '題名 ' + id, description: '説明', favicon: '📊', url: 'https://claude.ai/code/artifact/' + id, lastPublished: '1 分前', versionCount: 2, canOpenEditor: false, ...over });
const wrap = (node: ReactNode, onIntent = vi.fn()) => { render(<IntentRoot onIntent={onIntent}>{node}</IntentRoot>); return onIntent; };

describe('UsageGauge', () => {
  it('値があれば百分率、無ければ未取得', () => {
    render(<UsageGauge label="5h" percent={84} />);
    expect(screen.getByLabelText('5h').getAttribute('aria-valuenow')).toBe('84');
    expect(screen.getByText('84%')).toBeTruthy();
    render(<UsageGauge label="7d" percent={null} />);
    expect(screen.getAllByText('未取得').length).toBeGreaterThan(0);
  });
  it('80% 以上は警告色の印を付ける', () => {
    const { container } = render(<UsageGauge label="5h" percent={91} />);
    expect(container.querySelector('.gauge-fill')?.getAttribute('data-high')).toBe('true');
    expect((container.querySelector('.gauge-fill') as HTMLElement).style.width).toBe('91%');
  });
});

describe('RollingNumber', () => {
  it('値が変わると古い値を添えて回し、150 ミリ秒で片付ける', () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<RollingNumber value={10} suffix="%" />);
      expect(container.querySelector('.roll-old')).toBeNull();
      rerender(<RollingNumber value={20} suffix="%" />);
      expect(container.querySelector('.roll')?.getAttribute('data-rolling')).toBe('true');
      expect(container.querySelector('.roll-old')?.textContent).toBe('10%');
      expect(container.querySelector('.roll-new')?.textContent).toBe('20%');
      act(() => { vi.advanceTimersByTime(150); });
      expect(container.querySelector('.roll-old')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Header', () => {
  it('2 つのゲージと最終更新を出す', () => {
    render(<IntentRoot onIntent={() => {}}><Header crumbs={[{ label: 'Home' }]} searchText="" connection="connected" indexLabel={null} usage={{ fiveHour: 47, sevenDay: 7, updatedLabel: '10 分前' }} /></IntentRoot>);
    expect(screen.getByLabelText('5 時間の使用率')).toBeTruthy();
    expect(screen.getByLabelText('7 日の使用率')).toBeTruthy();
    expect(screen.getByText('最終更新 10 分前')).toBeTruthy();
  });
  it('最終更新が無ければ添えない', () => {
    render(<IntentRoot onIntent={() => {}}><Header crumbs={[{ label: 'Home' }]} searchText="" connection="connected" indexLabel={null} usage={{ fiveHour: null, sevenDay: null, updatedLabel: null }} /></IntentRoot>);
    expect(screen.queryByText(/最終更新/)).toBeNull();
    expect(screen.getAllByText('未取得')).toHaveLength(2);
  });
});

describe('TodoList', () => {
  it('追加、反転、削除の Intent を出す', () => {
    const onIntent = wrap(<TodoList projectId="p1" todos={[{ id: 't1', text: '買う', done: false }, { id: 't2', text: '済んだ', done: true }]} />);
    const input = screen.getByLabelText('TODO を追加');
    fireEvent.change(input, { target: { value: '書く' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.add', projectId: 'p1', text: '書く' });
    fireEvent.click(screen.getByLabelText('買う'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.toggle', id: 't1' });
    fireEvent.click(screen.getByLabelText('済んだ を削除'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.remove', id: 't2' });
    expect(input.getAttribute('id')).toBe('todo-input');
  });
  it('空の入力では何も出さない', () => {
    const onIntent = wrap(<TodoList projectId="p1" todos={[]} />);
    fireEvent.keyDown(screen.getByLabelText('TODO を追加'), { key: 'Enter' });
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.getByText('TODO はまだありません')).toBeTruthy();
  });
  it('日本語の変換中の Enter では追加しない', () => {
    const onIntent = wrap(<TodoList projectId="p1" todos={[]} />);
    const input = screen.getByLabelText('TODO を追加');
    fireEvent.change(input, { target: { value: 'かう' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onIntent).not.toHaveBeenCalled();
  });
});

describe('MemoEditor', () => {
  it('保存すると memo.save を出す', () => {
    const onIntent = wrap(<MemoEditor projectId="p1" markdown="# a" updatedAt={1} />);
    fireEvent.change(screen.getByLabelText('メモ'), { target: { value: '# b' } });
    fireEvent.click(screen.getByText('保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'memo.save', projectId: 'p1', markdown: '# b' });
  });
  it('下書きが無ければ外部の更新をそのまま取り込む', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# a" updatedAt={1} /></IntentRoot>);
    rerender(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# 外" updatedAt={2} /></IntentRoot>);
    expect((screen.getByLabelText('メモ') as HTMLTextAreaElement).value).toBe('# 外');
    expect(screen.queryByText('外部で更新されました')).toBeNull();
  });
  it('下書きがあれば捨てずに知らせ、読み込むで差し替える', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# a" updatedAt={1} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('メモ'), { target: { value: '# 書きかけ' } });
    rerender(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# 外" updatedAt={2} /></IntentRoot>);
    expect((screen.getByLabelText('メモ') as HTMLTextAreaElement).value).toBe('# 書きかけ');
    expect(screen.getByText('外部で更新されました')).toBeTruthy();
    fireEvent.click(screen.getByText('読み込む'));
    expect((screen.getByLabelText('メモ') as HTMLTextAreaElement).value).toBe('# 外');
  });
  it('書き換えていなければ保存できない', () => {
    wrap(<MemoEditor projectId="p1" markdown="# a" updatedAt={1} />);
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ArtifactCards', () => {
  it('クリックで開き、編集ボタンは元ファイルがあるときだけ出す', () => {
    const onIntent = wrap(<ArtifactCards projectId="p1" artifacts={[art('a1'), art('a2', { canOpenEditor: true })]} canAdd />);
    fireEvent.click(screen.getByText('題名 a1'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'artifact.open', id: 'a1' });
    expect(screen.getAllByText('VS Code で開く')).toHaveLength(1);
    fireEvent.click(screen.getByText('VS Code で開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'artifact.openEditor', id: 'a2' });
    const url = screen.getByLabelText('アーティファクトの URL');
    fireEvent.change(url, { target: { value: 'https://claude.ai/code/artifact/x' } });
    fireEvent.click(screen.getByText('追加'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'artifact.add', projectId: 'p1', url: 'https://claude.ai/code/artifact/x' });
  });
  it('canAdd が偽なら追加欄を出さない', () => {
    wrap(<ArtifactCards projectId={null} artifacts={[]} canAdd={false} />);
    expect(screen.queryByLabelText('アーティファクトの URL')).toBeNull();
    expect(screen.getByText('アーティファクトはまだありません')).toBeTruthy();
  });
});

describe('ProjectScreen の右レール', () => {
  const props = { id: 'p1', name: 'alpha', path: '/w/alpha', resolved: true, status: 'active' as const, sessions: [], notFound: false, isScratch: false, todos: [{ id: 't1', text: '買う', done: false }], memo: { markdown: '# a', updatedAt: 1 }, artifacts: [art('a1')] };
  it('TODO とメモとアーティファクトを並べ、折りたためる', () => {
    wrap(<ProjectScreen {...props} />);
    expect(screen.getByLabelText('TODO を追加')).toBeTruthy();
    expect(screen.getByLabelText('メモ')).toBeTruthy();
    expect(screen.getByText('題名 a1')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('右レールを隠す'));
    expect(screen.queryByLabelText('TODO を追加')).toBeNull();
  });
  it('スクラッチのプロジェクトは操作を絞る', () => {
    wrap(<ProjectScreen {...props} isScratch />);
    expect(screen.getByText('スクラッチで始める')).toBeTruthy();
    expect(screen.queryByText('新規セッション')).toBeNull();
  });
});
