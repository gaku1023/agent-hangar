import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { NewSessionDialog } from './NewSessionDialog.tsx';

const projects = [{ id: 'p1', name: 'alpha', path: '/w/alpha' }, { id: 'p2', name: 'beta', path: '/w/beta' }];

describe('NewSessionDialog', () => {
  it('プロジェクトを選ぶまで起動できず、選んで起動すると params を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog projects={projects} projectId={null} submitting={false} error={null} /></IntentRoot>);
    const start = screen.getByRole('button', { name: '起動' });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByLabelText('プロジェクト'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('初期プロンプト'), { target: { value: 'やって' } });
    fireEvent.change(screen.getByLabelText('model'), { target: { value: 'opus' } });
    fireEvent.change(screen.getByLabelText('追加ディレクトリ'), { target: { value: '/a\n\n/b\n' } });
    fireEvent.click(start);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.submit', params: { projectId: 'p1', name: 'n', prompt: 'やって', model: 'opus', addDirs: ['/a', '/b'] } });
  });
  it('初期プロジェクトが選ばれ、Esc とやめるで閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog projects={projects} projectId="p2" submitting={false} error={null} /></IntentRoot>);
    expect((screen.getByLabelText('プロジェクト') as HTMLSelectElement).value).toBe('p2');
    expect(screen.getByRole('button', { name: '起動' })).toBeEnabled();
    fireEvent.click(screen.getByText('やめる'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onIntent).toHaveBeenCalledTimes(2);
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('送信中と失敗の表示', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog projects={projects} projectId="p1" submitting error="tmux が見つかりません" /></IntentRoot>);
    expect(screen.getByRole('button', { name: '起動しています' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('tmux が見つかりません');
    expect(screen.getByText(/信頼確認/)).toBeInTheDocument();
  });
  it('変換中の Enter では起動しない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog projects={projects} projectId="p1" submitting={false} error={null} /></IntentRoot>);
    const name = screen.getByLabelText('名前');
    fireEvent.change(name, { target: { value: 'なまえ' } });
    fireEvent.keyDown(name, { key: 'Enter', keyCode: 229 });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.submit', params: { projectId: 'p1', name: 'なまえ' } });
  });
});
