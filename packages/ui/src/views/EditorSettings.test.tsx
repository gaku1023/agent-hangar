import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { EditorMissingProps } from '../presenters/editor.ts';
import type { EditorSettingsProps } from '../presenters/settings.ts';
import { EditorMissing } from './EditorMissing.tsx';
import { EditorSettings } from './EditorSettings.tsx';

const props = (over: Partial<EditorSettingsProps> = {}): EditorSettingsProps => ({
  setting: { id: 'vscode', path: null, fileCmd: '', dirCmd: '', terminal: 'none' }, name: 'VS Code', loading: false, test: { running: false, result: null },
  choices: [
    { id: 'vscode', name: 'VS Code', tile: 'VS', state: 'found', path: '/usr/local/bin/code', version: '1.105.1', selected: true, badge: { text: '見つかりました', tone: 'ok' } },
    { id: 'zed', name: 'Zed', tile: 'Ze', state: 'app', path: '/Applications/Zed.app', version: null, selected: false, badge: { text: 'アプリだけ', tone: 'warn' } },
    { id: 'custom', name: '任意のコマンド', tile: '{ }', state: null, path: null, version: null, selected: false, badge: null },
  ],
  ...over,
});
const ui = (p: EditorSettingsProps, onAction: (a: UiAction) => void = () => {}) => render(<ActionRoot onAction={onAction}><EditorSettings editor={p} mark={undefined} /></ActionRoot>);

describe('エディタの欄（試作の 1-1 の A）', () => {
  it('開いたら候補を読み直し、見つかり方の札と場所を並べる', () => {
    const onAction = vi.fn();
    ui(props(), onAction);
    expect(onAction).toHaveBeenCalledWith({ type: 'editors.load' });
    const rows = screen.getAllByRole('radio');
    expect(rows.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(rows[0]).toHaveTextContent('VS Code1.105.1/usr/local/bin/code見つかりました');
    expect(rows[1]).toHaveTextContent('アプリだけ');
  });
  it('選んだ時点で保存し、前のエディタのパスは持ち越さない。テストは選んだ行にだけある', () => {
    const onAction = vi.fn();
    ui(props({ setting: { id: 'vscode', path: '/opt/code', fileCmd: '', dirCmd: '', terminal: 'none' } }), onAction);
    fireEvent.click(screen.getByRole('radio', { name: /Zed/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { editor: { id: 'zed', path: null, fileCmd: '', dirCmd: '', terminal: 'none' } }, field: 'editor' });
    expect(screen.getAllByRole('button', { name: 'テスト' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'テスト' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'editor.test' });
    fireEvent.click(screen.getByRole('button', { name: '再確認' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'editors.load' });
  });
  it('パスは畳んであり、開いて欄を出たら保存する', () => {
    const onAction = vi.fn();
    ui(props(), onAction);
    expect(screen.queryByLabelText(/VS Code のパス/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'パスを指定…' }));
    const field = screen.getByLabelText(/VS Code のパス/);
    fireEvent.change(field, { target: { value: ' /opt/code ' } });
    fireEvent.blur(field);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { editor: { id: 'vscode', path: '/opt/code', fileCmd: '', dirCmd: '', terminal: 'none' } }, field: 'editor' });
  });
  it('テストの答えを欄の下に出す', () => {
    ui(props({ test: { running: false, result: { tone: 'ng', text: 'Cursor が見つかりません。インストールしたあと「再確認」を押すか、パスを指定してください。' } } }));
    expect(screen.getByRole('status')).toHaveTextContent('Cursor が見つかりません');
  });
});

describe('任意のコマンド（試作の 1-4 の A）', () => {
  const custom = () => props({ name: null, setting: { id: 'custom', path: null, fileCmd: 'subl {path}:{line}', dirCmd: '', terminal: 'none' } });
  it('見本は打つそばから変わり、{path} が無ければ言うだけで保存しない', () => {
    const onAction = vi.fn();
    ui(custom(), onAction);
    const preview = document.querySelector('.editor-preview')!;
    expect(preview).toHaveTextContent('subl ~/work/alpha/src/app.ts:42');
    expect(preview).toHaveTextContent('subl ~/work/alpha');
    const field = screen.getByLabelText('ファイルを開くコマンド');
    fireEvent.change(field, { target: { value: 'nvim +{line}' } });
    expect(screen.getByText('{path} が入っていません')).toBeInTheDocument();
    fireEvent.blur(field);
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'settings.update' }));
    fireEvent.change(field, { target: { value: 'nvim +{line} {path}' } });
    fireEvent.blur(field);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { editor: { id: 'custom', path: null, fileCmd: 'nvim +{line} {path}', dirCmd: '', terminal: 'none' } }, field: 'editor' });
  });
  it('ターミナルの中のエディタは、シェルタブか外部ターミナルを選べる', () => {
    const onAction = vi.fn();
    ui(custom(), onAction);
    fireEvent.click(screen.getByRole('radio', { name: 'hangar のシェルタブで開く' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { editor: { id: 'custom', path: null, fileCmd: 'subl {path}:{line}', dirCmd: '', terminal: 'shell' } }, field: 'editor' });
  });
});

describe('エディタが見つからないときの面（試作の 1-3 の B）', () => {
  const missing = (n = 1): EditorMissingProps => ({
    n, title: 'Cursor が見つかりません', lastPath: '/usr/local/bin/cursor',
    choices: [
      { key: 'settings', label: '設定でエディタを選ぶ', icon: 'settings', send: { type: 'nav.go', to: { name: 'settings', at: 'editor' } } },
      { key: 'once:vscode', label: '今回は VS Code で開く', icon: 'openEditor', send: { type: 'project.openEditor', id: 'p1', once: 'vscode' } },
      { key: 'recheck', label: '再確認', icon: 'recheck', send: { type: 'project.openEditor', id: 'p1' } },
    ],
  });
  it('理由と次の手を出し、押したら送って閉じる。新しい断りでまた出す', () => {
    const onAction = vi.fn();
    const { rerender } = render(<ActionRoot onAction={onAction}><EditorMissing {...missing()} /></ActionRoot>);
    expect(screen.getByRole('dialog', { name: 'Cursor が見つかりません' })).toHaveTextContent('最後に見つけた場所：/usr/local/bin/cursor');
    fireEvent.click(screen.getByRole('button', { name: '今回は VS Code で開く' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'project.openEditor', id: 'p1', once: 'vscode' });
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<ActionRoot onAction={onAction}><EditorMissing {...missing(2)} /></ActionRoot>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // 画面を移ったら閉じる。
    rerender(<ActionRoot onAction={onAction}><EditorMissing {...missing(3)} /></ActionRoot>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
