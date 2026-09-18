import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LaunchParams } from '@agent-hangar/shared';
import { IntentRoot } from '../intent/chain.tsx';
import { NewSessionDialog } from './NewSessionDialog.tsx';

const projects = [{ id: 'p1', name: 'alpha', path: '/w/alpha' }, { id: 'p2', name: 'beta', path: '/w/beta' }];

/** 送られた params だけを集める。
 * キーの有無を見たいので、呼び出しの照合ではなく値そのものを取る。
 */
function collectParams(): LaunchParams[] {
  const out: LaunchParams[] = [];
  render(<IntentRoot onIntent={(i) => { if (i.type === 'session.new.submit') out.push(i.params); }}><NewSessionDialog projects={projects} projectId={null} submitting={false} error={null} scratch={false} /></IntentRoot>);
  return out;
}

describe('NewSessionDialog', () => {
  it('選んで起動すると params を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog projects={projects} projectId={null} submitting={false} error={null} scratch={false} /></IntentRoot>);
    const start = screen.getByRole('button', { name: '起動' });
    fireEvent.change(screen.getByLabelText('プロジェクト'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('名前（任意）'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('初期プロンプト（任意）'), { target: { value: 'やって' } });
    fireEvent.change(screen.getByLabelText('model'), { target: { value: 'opus' } });
    fireEvent.change(screen.getByLabelText('追加ディレクトリ（1 行 1 つ）'), { target: { value: '/a\n\n/b\n' } });
    fireEvent.click(start);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.submit', params: { projectId: 'p1', name: 'n', prompt: 'やって', model: 'opus', addDirs: ['/a', '/b'] } });
  });
  it('初期プロジェクトが選ばれ、Esc とやめるで閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog projects={projects} projectId="p2" submitting={false} error={null} scratch={false} /></IntentRoot>);
    expect((screen.getByLabelText('プロジェクト') as HTMLSelectElement).value).toBe('p2');
    expect(screen.getByRole('button', { name: '起動' })).toBeEnabled();
    fireEvent.click(screen.getByText('やめる'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onIntent).toHaveBeenCalledTimes(2);
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('プロジェクトを選ばずに押しても起動を出し、projectId は入れない', () => {
    // 未選択の判定は Mediator が持ち、失敗のメッセージが error として戻ってくる。
    const params = collectParams();
    const start = screen.getByRole('button', { name: '起動' });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(params).toHaveLength(1);
    expect(Object.keys(params[0]!)).toEqual([]);
  });
  it('読み上げの名前は可視ラベルと一致する', () => {
    // 「（任意）」を落とすと、読み上げでは必須かどうかが分からなくなる。
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog projects={projects} projectId={null} submitting={false} error={null} scratch={false} /></IntentRoot>);
    expect(screen.getByRole('combobox', { name: 'プロジェクト' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '名前（任意）' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '初期プロンプト（任意）' })).toBeInTheDocument();
    // 詳細の中は折りたたまれているので、可視ラベルとの一致だけを見る。
    expect(screen.getByLabelText('追加ディレクトリ（1 行 1 つ）')).toHaveAccessibleName('追加ディレクトリ（1 行 1 つ）');
    expect(screen.getByLabelText('permission mode')).toHaveAccessibleName('permission mode');
  });
  it('空欄の項目はキーごと入れない', () => {
    // undefined を入れると、利用者の Claude Code の設定を上書きしかねない。
    const params = collectParams();
    fireEvent.change(screen.getByLabelText('プロジェクト'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('名前（任意）'), { target: { value: '  ' } });
    fireEvent.change(screen.getByLabelText('model'), { target: { value: 'opus' } });
    fireEvent.change(screen.getByLabelText('追加ディレクトリ（1 行 1 つ）'), { target: { value: '\n \n' } });
    fireEvent.click(screen.getByRole('button', { name: '起動' }));
    expect(Object.keys(params[0]!).sort()).toEqual(['model', 'projectId']);
  });
  it('送信中と失敗の表示', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog projects={projects} projectId="p1" submitting error="tmux が見つかりません" scratch={false} /></IntentRoot>);
    expect(screen.getByRole('button', { name: '起動しています' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('tmux が見つかりません');
    expect(screen.getByText(/信頼確認/)).toBeInTheDocument();
  });
  it('変換中の Enter では起動しない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog projects={projects} projectId="p1" submitting={false} error={null} scratch={false} /></IntentRoot>);
    const name = screen.getByLabelText('名前（任意）');
    fireEvent.change(name, { target: { value: 'なまえ' } });
    fireEvent.keyDown(name, { key: 'Enter', keyCode: 229 });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.submit', params: { projectId: 'p1', name: 'なまえ' } });
  });
});
