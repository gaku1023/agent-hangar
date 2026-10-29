import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    { id: 'vscode', name: 'VS Code', tile: 'VS', state: 'found', path: '/usr/local/bin/code', version: '1.105.1', selected: true, badge: { text: '検出済み', tone: 'ok' } },
    { id: 'zed', name: 'Zed', tile: 'Ze', state: 'app', path: '/Applications/Zed.app', version: null, selected: false, badge: { text: 'アプリのみ', tone: 'warn' } },
    { id: 'custom', name: '任意のコマンド', tile: '{ }', state: null, path: null, version: null, selected: false, badge: null },
  ],
  ...over,
});
const ui = (p: EditorSettingsProps, onAction: (a: UiAction) => void = () => {}, open?: boolean) => render(<ActionRoot onAction={onAction}><EditorSettings editor={p} mark={undefined} open={open} /></ActionRoot>);
/** 未検出の候補を足した一覧。 */
const withMissing = (over: Partial<EditorSettingsProps> = {}): EditorSettingsProps => {
  const base = props(over);
  return { ...base, choices: [...base.choices.slice(0, 1), { id: 'cursor', name: 'Cursor', tile: 'Cu', state: 'none', path: null, version: null, selected: false, badge: { text: '未検出', tone: 'mute' } }, ...base.choices.slice(1)] };
};
const toggle = () => screen.getByRole('button', { name: /^他のエディタ/ });

describe('エディタの欄（試作の 1-1 の A）', () => {
  it('開いたら候補を読み直し、選んでいる 1 本の行だけを出して、ほかの候補は数を添えたボタンに畳む', () => {
    const onAction = vi.fn();
    ui(withMissing(), onAction);
    expect(onAction).toHaveBeenCalledWith({ type: 'editors.load' });
    const rows = screen.getAllByRole('radio');
    expect(rows.map((r) => r.getAttribute('aria-checked'))).toEqual(['true']);
    expect(rows[0]).toHaveTextContent('VS Code1.105.1/usr/local/bin/code検出済み');
    // 検出済みの数に任意のコマンドは数えない。
    expect(toggle()).toHaveTextContent('他のエディタ（検出済み 1 · 未検出 1）');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    // 何に使うかは見出しの横の ⓘ に畳む。見つかり方は札で読めるので、文では言わない。
    expect(screen.queryByText(/検出状況/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'エディタの説明' }));
    expect(screen.getByRole('dialog', { name: 'エディタの説明' })).toHaveTextContent('変更したファイルを該当の行から開くときに使います');
  });
  it('畳みを開くと、検出済み（任意のコマンドを含む）が上、「未検出 n」の見出しの下に未検出が並び、見つかり方の札と場所を出す', () => {
    ui(withMissing());
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    const others = screen.getByRole('radiogroup', { name: '他のエディタ' });
    expect(others).toHaveTextContent(/Zed.*アプリのみ.*任意のコマンド.*未検出 1.*Cursor/);
    const rows = screen.getAllByRole('radio');
    expect(rows.map((r) => r.textContent?.match(/VS Code|Zed|任意のコマンド|Cursor/)?.[0])).toEqual(['VS Code', 'Zed', '任意のコマンド', 'Cursor']);
    expect(rows.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
    expect(rows[1]).toHaveTextContent('/Applications/Zed.app');
  });
  it('未検出が無ければ、未検出の見出しを出さない', () => {
    ui(props(), undefined, true);
    expect(screen.getByRole('radiogroup', { name: '他のエディタ' })).not.toHaveTextContent('未検出');
    expect(toggle()).toHaveTextContent('他のエディタ（検出済み 1 · 未検出 0）');
  });
  it('準備の帯から飛んできたとき（open）と、選んでいるエディタが見つからないときは、開いて始める', () => {
    const { unmount } = ui(props(), undefined, true);
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('radio', { name: /Zed/ })).toBeInTheDocument();
    unmount();
    const gone = props({ choices: props().choices.map((c) => (c.id === 'vscode' ? { ...c, state: 'none' as const, path: null, version: null, badge: { text: '未検出', tone: 'mute' as const } } : c)) });
    ui(gone);
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('radio', { name: /Zed/ })).toBeInTheDocument();
  });
  it('検出中は、数を添えない名前だけのボタンにする', () => {
    ui(props({ loading: true }));
    expect(toggle()).toHaveTextContent(/^他のエディタ$/);
  });
  it('選んだ時点で保存して畳みを閉じ、前のエディタのパスは持ち越さない。テストは選んだ行にだけある', async () => {
    const onAction = vi.fn();
    ui(props({ setting: { id: 'vscode', path: '/opt/code', fileCmd: '', dirCmd: '', terminal: 'none' } }), onAction);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('radio', { name: /Zed/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { editor: { id: 'zed', path: null, fileCmd: '', dirCmd: '', terminal: 'none' } }, field: 'editor' });
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByRole('radio', { name: /Zed/ })).toBeNull();
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
  it('テストの答えは、選んだ行（テストのボタン）のすぐ下に出す。欄の下端に出すと右下の札に隠れるため', () => {
    ui(props({ test: { running: false, result: { tone: 'ng', text: 'Cursor が未検出。インストール後に「再確認」をクリックするか、パスを指定してください。' } } }));
    expect(screen.getByRole('status')).toHaveTextContent('Cursor が未検出');
    expect(screen.getByRole('radio', { name: /VS Code/ }).nextElementSibling).toBe(screen.getByRole('status'));
  });
  it('開けなかった答えにだけ「エージェントで調査…」を出す', () => {
    const onAction = vi.fn();
    ui(props({ test: { running: false, result: { tone: 'ng', text: 'Cursor が未検出' } } }), onAction);
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'エージェントで調査…' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'investigate.open', op: 'editor', message: 'Cursor が未検出' });
  });
  it('開けた答えには「エージェントで調査…」を出さない', () => {
    ui(props({ test: { running: false, result: { tone: 'ok', text: '開きました' } } }));
    expect(screen.queryByRole('button', { name: 'エージェントで調査…' })).toBeNull();
  });
  it('畳みを開いても、テストの答えは選んだ行のすぐ下にある', () => {
    ui(props({ test: { running: false, result: { tone: 'ok', text: '開きました' } } }), undefined, true);
    expect(screen.getByRole('radio', { name: /VS Code/ }).nextElementSibling).toBe(screen.getByRole('status'));
  });
  it('テストの最中の文も、選んだ行のすぐ下に出す', () => {
    ui(props({ setting: { id: 'zed', path: null, fileCmd: '', dirCmd: '', terminal: 'none' }, name: 'Zed', test: { running: true, result: null }, choices: props().choices.map((c) => ({ ...c, selected: c.id === 'zed' })) }));
    expect(screen.getByRole('radio', { name: /Zed/ }).nextElementSibling).toBe(screen.getByRole('status'));
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
    expect(screen.getByText('{path} が含まれていません')).toBeInTheDocument();
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
    n, title: 'Cursor が未検出', lastPath: '/usr/local/bin/cursor',
    choices: [
      { key: 'settings', label: '設定でエディタを選択', icon: 'settings', send: { type: 'nav.go', to: { name: 'settings', at: 'editor' } } },
      { key: 'once:vscode', label: '今回は VS Code で開く', icon: 'openEditor', send: { type: 'project.openEditor', id: 'p1', once: 'vscode' } },
      { key: 'recheck', label: '再確認', icon: 'recheck', send: { type: 'project.openEditor', id: 'p1' } },
    ],
  });
  it('理由と次の手を出し、押したら送って閉じる。新しい断りでまた出す', () => {
    const onAction = vi.fn();
    const { rerender } = render(<ActionRoot onAction={onAction}><EditorMissing {...missing()} /></ActionRoot>);
    expect(screen.getByRole('dialog', { name: 'Cursor が未検出' })).toHaveTextContent('前回検出したパス：/usr/local/bin/cursor');
    expect(screen.getByRole('dialog', { name: 'Cursor が未検出' })).not.toHaveTextContent('移動した可能性があります');
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
