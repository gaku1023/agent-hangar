import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UiAction, LaunchParams } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { NewSessionProps } from '../presenters/newSession.ts';
import { presentAccounts, type AccountView } from '../presenters/accounts.ts';
import { accountsFixture } from '../test/accounts.ts';
import { initialStore } from '../store/store.ts';
import { pick } from '../test/pick.ts';
import { NewSessionDialog } from './NewSessionDialog.tsx';
import { LanguageRoot } from './primitives/language.tsx';
import { NO_ASSIST, PromptAssistContext } from './primitives/promptAssist.ts';
import { setClientUserAgent, WINDOWS_UA } from '../test/client.ts';

const projects: NewSessionProps['projects'] = [
  { id: 'p1', name: 'alpha', path: '/w/alpha', status: 'active', lastActivity: '2 分前' },
  { id: 'p2', name: 'beta', path: '/w/beta', status: 'paused', lastActivity: '昨日' },
];
const base: NewSessionProps = { projects, recentIds: ['p1'], projectId: null, submitting: false, error: null, scratch: false, draft: null, prefs: {}, dirs: [{ name: 'url-short', path: '/w/url-short' }], takenNames: ['alpha', 'beta'], workspaceRoot: '/w', desktop: true, picked: null, createdProjectId: null, accounts: null };

/** 送られた params だけを集める。キーの有無を見たいので、呼び出しの照合ではなく値そのものを取る。 */
function collectParams(over: Partial<NewSessionProps> = {}): LaunchParams[] {
  const out: LaunchParams[] = [];
  render(<ActionRoot onAction={(i) => { if (i.type === 'session.new.submit') out.push(i.params); }}><NewSessionDialog {...base} {...over} /></ActionRoot>);
  return out;
}
const start = () => fireEvent.click(screen.getByRole('button', { name: /^(Bypass permissions で)?起動$/ }));
const group = () => screen.getByRole('group', { name: '起動の設定' });
const chip = (name: string | RegExp) => within(group()).getByRole('button', { name });
/** 札を押して一覧を開き、行を選ぶ。 */
const choose = (chipName: string, option: string | RegExp) => {
  fireEvent.click(chip(chipName));
  fireEvent.click(screen.getByRole('option', { name: option }));
};
/** 「＋」から札を足す。足した札の入力欄が開く。 */
const addChip = (label: string) => {
  fireEvent.click(chip('札を足す'));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
};
/** 名前の札を足して打ち、Enter で閉じる。 */
const setName = (value: string) => {
  addChip('名前');
  const box = screen.getByRole('textbox', { name: '名前' });
  fireEvent.change(box, { target: { value } });
  fireEvent.keyDown(box, { key: 'Enter' });
};
const prompt = () => screen.getByLabelText('初期プロンプト（任意）');

describe('NewSessionDialog（N2）', () => {
  it('選んで起動すると、画面で決めた値が全部 params に載る', () => {
    const params = collectParams();
    pick('プロジェクト', 'alpha');
    fireEvent.change(prompt(), { target: { value: 'やって' } });
    setName('n');
    choose('モデル、既定', 'opus');
    choose('effort レベル、既定', 'high');
    choose('権限モード、既定', 'Plan');
    fireEvent.click(chip('worktree、なし'));
    fireEvent.change(screen.getByRole('textbox', { name: 'worktree' }), { target: { value: ' wt-1 ' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'worktree' }), { key: 'Enter' });
    addChip('追加ディレクトリ');
    fireEvent.change(screen.getByRole('textbox', { name: '追加ディレクトリ' }), { target: { value: '/a\n\n/b\n' } });
    fireEvent.keyDown(screen.getByRole('dialog', { name: '追加ディレクトリ' }), { key: 'Escape' });
    start();
    expect(params).toEqual([{ projectId: 'p1', name: 'n', prompt: 'やって', model: 'opus', effort: 'high', permissionMode: 'plan', worktree: 'wt-1', addDirs: ['/a', '/b'] }]);
  });
  it('開いたら大きい初期プロンプトの欄が主役で、そこに焦点がある', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} /></ActionRoot>);
    expect(screen.getByRole('dialog', { name: '新しいセッション' })).toBeInTheDocument();
    expect(prompt()).toHaveFocus();
    expect(prompt().closest('.pc')).toHaveAttribute('data-hero', 'true');
    expect(prompt()).toHaveAttribute('placeholder', '何をしますか。/ でスキル、@ でファイル、画像やファイルはドロップ');
  });
  it('名前の欄も詳細の畳みも無く、設定は札の 1 行に並ぶ', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} /></ActionRoot>);
    expect(screen.queryByLabelText('名前（任意）')).toBeNull();
    expect(screen.queryByText(/^詳細/)).toBeNull();
    expect(screen.getByRole('dialog').querySelector('details')).toBeNull();
    expect(within(group()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.getAttribute('title'))).toEqual(['プロジェクト', 'モデル、既定', 'effort レベル、既定', '権限モード、既定', 'worktree、なし', '札を足す']);
  });
  it('何も選ばなければ札は「クイックセッション」と言い、そのまま起動すると scratch で始まる', () => {
    const params = collectParams();
    expect(chip('プロジェクト')).toHaveTextContent('クイックセッション');
    expect(screen.getByText(/プロジェクトを選ばないと、クイックセッション/)).toBeInTheDocument();
    start();
    expect(params).toEqual([{ scratch: true }]);
  });
  it('プロジェクトの一覧は、クイックスタート、最近、すべての群に分かれ、パスと時期を添える', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
    const groups = within(screen.getByRole('listbox')).getAllByRole('group');
    expect(groups[0]).toHaveAccessibleName('クイックスタート');
    expect(within(groups[0]!).getByRole('option', { name: 'クイックセッション' })).toHaveAccessibleDescription('名前は決めずに始めて、あとでプロジェクトに昇格できる');
    expect(within(screen.getByRole('group', { name: '最近' })).getByRole('option', { name: 'alpha' })).toHaveAccessibleDescription('/w/alpha');
    expect(within(screen.getByRole('group', { name: 'すべて' })).getByRole('option', { name: 'beta' })).toHaveTextContent('昨日');
  });
  it('初期プロジェクトが選ばれ、Esc とキャンセルで閉じる', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><NewSessionDialog {...base} projectId="p2" /></ActionRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('beta');
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  // 書きかけを背景の押し違いで失わないよう、背景では閉じない。
  it('背景を押しても閉じず、見出しの × で閉じる', () => {
    const onAction = vi.fn();
    const { container } = render(<ActionRoot onAction={onAction}><NewSessionDialog {...base} /></ActionRoot>);
    fireEvent.click(container.querySelector('.overlay')!);
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('一覧を開いている間の Esc は一覧だけを閉じ、Enter は起動しない', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><NewSessionDialog {...base} /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
  });
  it('読み上げの名前は可視ラベルと一致する', () => {
    // 「（任意）」を落とすと、読み上げでは必須かどうかが分からなくなる。
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} /></ActionRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '初期プロンプト（任意）' })).toBeInTheDocument();
    for (const name of ['モデル、既定', 'effort レベル、既定', '権限モード、既定', 'worktree、なし']) {
      const c = chip(name);
      expect(c).toHaveTextContent(name.split('、')[1]!);
    }
  });
  it('既定のままなら model、effort、権限モード、worktree、名前、追加ディレクトリはキーごと入れない', () => {
    // undefined を入れると、利用者の Claude Code の設定を上書きしかねない。
    const params = collectParams({ projectId: 'p1' });
    setName('  ');
    addChip('追加ディレクトリ');
    fireEvent.change(screen.getByRole('textbox', { name: '追加ディレクトリ' }), { target: { value: '\n \n' } });
    start();
    expect(Object.keys(params[0]!)).toEqual(['projectId']);
  });
  it('effort レベルと権限モードの選択肢は CLI の値に合わせ、権限モードは英語の名前で並べる', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} /></ActionRoot>);
    fireEvent.click(chip('effort レベル、既定'));
    expect(within(screen.getByRole('listbox', { name: 'effort レベル' })).getAllByRole('option').map((r) => r.textContent)).toEqual(['既定', 'low', 'medium', 'high', 'xhigh', 'max']);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'effort レベル' }), { key: 'Escape' });
    fireEvent.click(chip('権限モード、既定'));
    expect(within(screen.getByRole('listbox', { name: '権限モード' })).getAllByRole('option').map((r) => r.textContent)).toEqual(['既定', 'Plan', 'Manual', 'Accept edits', 'Auto', "Don't ask", 'Bypass permissions']);
  });
  it('「ほか」で打った model を、前後の空白を落として入れる', () => {
    const params = collectParams({ projectId: 'p1' });
    fireEvent.click(chip('モデル、既定'));
    fireEvent.change(screen.getByRole('textbox', { name: 'ほかのモデルの名前' }), { target: { value: ' claude-opus-5-5 ' } });
    start();
    expect(params[0]).toEqual({ projectId: 'p1', model: 'claude-opus-5-5' });
  });
  it('「ほか」に空白だけを打ったら model を入れない', () => {
    const params = collectParams({ projectId: 'p1' });
    fireEvent.click(chip('モデル、既定'));
    fireEvent.change(screen.getByRole('textbox', { name: 'ほかのモデルの名前' }), { target: { value: '   ' } });
    start();
    expect(Object.keys(params[0]!)).toEqual(['projectId']);
  });
  describe('Bypass permissions', () => {
    it('選ぶと札が赤くなり、起動のボタンが赤い「Bypass permissions で起動」になる。確認のダイアログも注意の文も出さない', () => {
      const params = collectParams({ projectId: 'p1' });
      expect(screen.getByRole('button', { name: '起動' })).toHaveClass('btn-primary');
      choose('権限モード、既定', /Bypass permissions/);
      expect(chip('権限モード、Bypass permissions')).toHaveAttribute('data-tone', 'danger');
      const go = screen.getByRole('button', { name: 'Bypass permissions で起動' });
      expect(go).toHaveClass('btn-danger-fill');
      expect(go).not.toHaveClass('btn-primary');
      expect(go).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter');
      expect(go.querySelector('.kc')).toHaveTextContent('⌘↵');
      expect(screen.queryByText('ファイルの削除やコマンドも、確認せずに実行します')).toBeNull();
      expect(screen.queryByRole('alertdialog')).toBeNull();
      start();
      expect(params).toEqual([{ projectId: 'p1', permissionMode: 'bypassPermissions' }]);
    });
    it('別の値へ戻すと、ボタンも札も元に戻る', () => {
      render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} projectId="p1" prefs={{ p1: { permissionMode: 'bypassPermissions' } }} /></ActionRoot>);
      expect(screen.getByRole('button', { name: 'Bypass permissions で起動' })).toBeInTheDocument();
      choose('権限モード、Bypass permissions', 'Plan');
      expect(screen.queryByRole('button', { name: 'Bypass permissions で起動' })).toBeNull();
      expect(screen.getByRole('button', { name: '起動' })).toHaveClass('btn-primary');
    });
    it('起動を送っている間は、赤いままで「起動しています」と言う', () => {
      render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} projectId="p1" prefs={{ p1: { permissionMode: 'bypassPermissions' } }} submitting /></ActionRoot>);
      expect(screen.getByRole('button', { name: '起動しています' })).toBeDisabled();
    });
  });
  it('送信中と失敗の表示', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} projectId="p1" submitting error="tmux が見つかりません" /></ActionRoot>);
    expect(screen.getByRole('button', { name: '起動しています' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('tmux が見つかりません');
    expect(screen.getByText(/信頼確認/)).toBeInTheDocument();
  });
  // 未選択で送った後にプロジェクトを選んでも、「プロジェクトを選んでください」が残っていた。
  it('失敗の文言は、プロジェクトを選び直したら消え、送り直して同じ失敗ならまた出す', () => {
    const onAction = vi.fn();
    const ui = (error: string | null) => <ActionRoot onAction={onAction}><NewSessionDialog {...base} error={error} /></ActionRoot>;
    const { rerender } = render(ui('プロジェクトを選んでください'));
    expect(screen.getByRole('alert')).toHaveTextContent('プロジェクトを選んでください');
    pick('プロジェクト', 'alpha');
    expect(screen.queryByRole('alert')).toBeNull();
    start();
    rerender(ui('プロジェクトを選んでください'));
    expect(screen.getByRole('alert')).toHaveTextContent('プロジェクトを選んでください');
  });
  it('名前の入力欄の変換中の Enter では閉じず、変換が済んだ Enter で閉じる。どちらも起動はしない', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><NewSessionDialog {...base} projectId="p1" /></ActionRoot>);
    addChip('名前');
    const name = screen.getByRole('textbox', { name: '名前' });
    fireEvent.change(name, { target: { value: 'なまえ' } });
    fireEvent.keyDown(name, { key: 'Enter', keyCode: 229 });
    expect(screen.getByRole('dialog', { name: '名前' })).toBeInTheDocument();
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(screen.queryByRole('dialog', { name: '名前' })).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
    start();
    expect(onAction).toHaveBeenCalledWith({ type: 'session.new.submit', params: { projectId: 'p1', name: 'なまえ' } });
  });
  it('札やボタンの上の Enter は、その部品の操作であって起動ではない', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><NewSessionDialog {...base} projectId="p1" /></ActionRoot>);
    for (const target of [chip('権限モード、既定'), chip('モデル、既定'), chip('札を足す'), screen.getByRole('button', { name: 'キャンセル' })]) {
      fireEvent.keyDown(target, { key: 'Enter' });
    }
    expect(onAction).not.toHaveBeenCalled();
  });
  describe('⌘Enter で起動', () => {
    it('初期プロンプトの欄の中からでも ⌘Enter と Ctrl+Enter で起動し、素の Enter は改行に残す', () => {
      const onAction = vi.fn();
      render(<ActionRoot onAction={onAction}><NewSessionDialog {...base} projectId="p1" /></ActionRoot>);
      fireEvent.change(prompt(), { target: { value: 'やって' } });
      expect(fireEvent.keyDown(prompt(), { key: 'Enter' })).toBe(true);
      expect(onAction).not.toHaveBeenCalled();
      expect(fireEvent.keyDown(prompt(), { key: 'Enter', metaKey: true })).toBe(false);
      fireEvent.keyDown(prompt(), { key: 'Enter', ctrlKey: true });
      expect(onAction.mock.calls).toEqual([[{ type: 'session.new.submit', params: { projectId: 'p1', prompt: 'やって' } }], [{ type: 'session.new.submit', params: { projectId: 'p1', prompt: 'やって' } }]]);
    });
    it('札の上でも ⌘Enter なら起動する', () => {
      const onAction = vi.fn();
      render(<ActionRoot onAction={onAction}><NewSessionDialog {...base} projectId="p1" /></ActionRoot>);
      fireEvent.keyDown(chip('権限モード、既定'), { key: 'Enter', metaKey: true });
      fireEvent.keyDown(chip('モデル、既定'), { key: 'Enter', metaKey: true });
      expect(onAction).toHaveBeenCalledTimes(2);
    });
    it('変換中の ⌘Enter と、送信中の ⌘Enter では起動しない', () => {
      const onAction = vi.fn();
      const { rerender } = render(<ActionRoot onAction={onAction}><NewSessionDialog {...base} projectId="p1" /></ActionRoot>);
      fireEvent.keyDown(prompt(), { key: 'Enter', metaKey: true, keyCode: 229 });
      rerender(<ActionRoot onAction={onAction}><NewSessionDialog {...base} projectId="p1" submitting /></ActionRoot>);
      fireEvent.keyDown(prompt(), { key: 'Enter', metaKey: true });
      expect(onAction).not.toHaveBeenCalled();
    });
    it('起動ボタンの中にキー帽を置き、読み上げの名前は「起動」のまま打鍵を添える（B1）', () => {
      render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} /></ActionRoot>);
      const button = screen.getByRole('button', { name: '起動' });
      expect(button).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter');
      const cap = button.querySelector('.kc')!;
      expect(cap).toHaveTextContent('⌘↵');
      expect(cap).toHaveAttribute('aria-hidden', 'true');
    });
    it('Windows では、キー帽と一言と読み上げの打鍵を Ctrl で見せる', () => {
      setClientUserAgent(WINDOWS_UA);
      render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} /></ActionRoot>);
      const button = screen.getByRole('button', { name: '起動' });
      expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+Enter');
      expect(button.querySelector('.kc')).toHaveTextContent('Ctrl+Enter');
      expect(screen.getByText('そのまま Ctrl+Enter でクイックセッションを開始')).toBeInTheDocument();
    });
    it('クイックセッションのままのときだけ、下端に「そのまま ⌘↵ で」の一言を出す', () => {
      render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} /></ActionRoot>);
      expect(screen.getByText('そのまま ⌘↵ でクイックセッションを開始')).toBeInTheDocument();
      pick('プロジェクト', 'alpha');
      expect(screen.queryByText('そのまま ⌘↵ でクイックセッションを開始')).toBeNull();
    });
  });
  it('一覧に出ないプロジェクトの id は、選んでいない扱いでクイックセッションにする', () => {
    const params = collectParams({ projectId: 'archived1' });
    expect(chip('プロジェクト')).toHaveTextContent('クイックセッション');
    start();
    expect(params).toEqual([{ scratch: true }]);
  });
  it('English では札の名前と文と権限モードの既定が替わり、Bypass permissions のボタンも替わる', () => {
    render(<LanguageRoot language="en"><ActionRoot onAction={() => {}}><NewSessionDialog {...base} projectId="p1" prefs={{ p1: { permissionMode: 'bypassPermissions' } }} /></ActionRoot></LanguageRoot>);
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Launch settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Launch with Bypass permissions' })).toBeInTheDocument();
    expect(screen.getByLabelText('Initial prompt (optional)')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Launch settings' })).getByRole('button', { name: 'Permission mode: Bypass permissions' })).toBeInTheDocument();
  });
});

describe('NewSessionDialog の名前と追加ディレクトリ（「＋」）', () => {
  it('はじめは札を出さず、「＋」の一覧に名前と追加ディレクトリが並ぶ', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} projectId="p1" /></ActionRoot>);
    expect(within(group()).queryByRole('button', { name: /^名前/ })).toBeNull();
    expect(within(group()).queryByRole('button', { name: /^追加ディレクトリ/ })).toBeNull();
    fireEvent.click(chip('札を足す'));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['名前', '追加ディレクトリ']);
  });
  it('名前を足すと札が増えて入力欄が開き、打った名前で起動する', () => {
    const params = collectParams({ projectId: 'p1' });
    addChip('名前');
    expect(screen.getByRole('textbox', { name: '名前' })).toHaveFocus();
    fireEvent.change(screen.getByRole('textbox', { name: '名前' }), { target: { value: '  決済の検証  ' } });
    expect(chip('名前、決済の検証')).toBeInTheDocument();
    start();
    expect(params).toEqual([{ projectId: 'p1', name: '決済の検証' }]);
  });
  it('追加ディレクトリを足すと、1 行に 1 つで打ち、空行を落として起動する。札には件数を出す', () => {
    const params = collectParams({ projectId: 'p1' });
    addChip('追加ディレクトリ');
    fireEvent.change(screen.getByRole('textbox', { name: '追加ディレクトリ' }), { target: { value: '/a\n\n/b\n' } });
    expect(chip('追加ディレクトリ、2 件')).toBeInTheDocument();
    start();
    expect(params).toEqual([{ projectId: 'p1', addDirs: ['/a', '/b'] }]);
  });
  it('下書きの名前があれば、はじめから名前の札を出す', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} draft={{ name: 'API の節', prompt: '', attachments: [] }} /></ActionRoot>);
    expect(chip('名前、API の節')).toBeInTheDocument();
    fireEvent.click(chip('札を足す'));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['追加ディレクトリ']);
  });
  it('前回の追加ディレクトリがあれば、はじめから札を出す。プロジェクトを選び直して入れ替わっても出る', () => {
    const prefs = { p1: { addDirs: ['/a', '/b'] } };
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} prefs={prefs} /></ActionRoot>);
    expect(within(group()).queryByRole('button', { name: /^追加ディレクトリ/ })).toBeNull();
    pick('プロジェクト', 'alpha');
    expect(chip('追加ディレクトリ、2 件')).toBeInTheDocument();
  });
});

describe('NewSessionDialog のクイックセッション', () => {
  it('クイックセッションの行は昇格できることを添え、選ぶと説明が出て scratch を付けて送る', () => {
    const params = collectParams({ projectId: 'p1' });
    expect(screen.queryByText(/プロジェクトを選ばないと/)).toBeNull();
    pick('プロジェクト', 'クイックセッション');
    expect(screen.getByRole('dialog', { name: '新しいセッション' })).toBeInTheDocument();
    expect(screen.getByText(/あとでプロジェクトに昇格できます/)).toBeInTheDocument();
    start();
    expect(params).toEqual([{ scratch: true }]);
  });
  it('初期プロンプトの @（ファイル）は、パスのあるプロジェクトを選んだときだけ使える', () => {
    const noPath: NewSessionProps['projects'] = [...projects, { id: 'p3', name: 'gamma', path: null, status: 'active', lastActivity: '' }];
    collectParams({ projects: noPath });
    const files = () => screen.getByRole('button', { name: 'ファイル' });
    // 未選択（クイックセッション）
    expect(files()).toBeDisabled();
    pick('プロジェクト', 'alpha');
    expect(files()).toBeEnabled();
    // パスの無いプロジェクトは、探す先のフォルダが無い。
    pick('プロジェクト', 'gamma');
    expect(files()).toBeDisabled();
    pick('プロジェクト', 'クイックセッション');
    expect(files()).toBeDisabled();
  });
  it('scratch で開くとクイックセッションが選ばれ、プロジェクトに選び直せば projectId で送る', () => {
    // ⌘⇧N、パレット、クイックセッションのプロジェクト画面は、この状態でダイアログを開く。
    const params = collectParams({ scratch: true });
    expect(chip('プロジェクト')).toHaveTextContent('クイックセッション');
    pick('プロジェクト', 'alpha');
    expect(screen.queryByText(/あとでプロジェクトに昇格できます/)).toBeNull();
    start();
    expect(params).toEqual([{ projectId: 'p1' }]);
  });
  it('scratch と projectId が両方来たらクイックセッションを選ぶ', () => {
    // サーバも scratch を優先する（runs/manager.ts）。見た目と送る内容をそろえる。
    const params = collectParams({ scratch: true, projectId: 'p1' });
    start();
    expect(params).toEqual([{ scratch: true }]);
  });
  it('検索欄に「クイック」と打つと当たる', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, name: `proj-${i}`, path: `/w/proj-${i}`, status: 'active' as const, lastActivity: '' }));
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} projects={many} recentIds={[]} /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'クイック' } });
    // 下端の操作も option なので、行だけを比べる。
    expect(screen.getAllByRole('option').filter((o) => !o.classList.contains('listbox-act')).map((o) => o.getAttribute('aria-label'))).toEqual(['クイックセッション']);
  });
});

describe('NewSessionDialog の下書き（C1）', () => {
  it('前に閉じたときの書きかけを戻し、見出しの右に「下書き」の札と「破棄」を出す', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} draft={{ name: 'API の節', prompt: '関数ごとに表を', attachments: [] }} /></ActionRoot>);
    expect(prompt()).toHaveValue('関数ごとに表を');
    fireEvent.click(chip('名前、API の節'));
    expect(screen.getByRole('textbox', { name: '名前' })).toHaveValue('API の節');
    const head = screen.getByRole('dialog', { name: '新しいセッション' }).querySelector('.dialog-head')!;
    expect(within(head as HTMLElement).getByText('下書き')).toBeInTheDocument();
    expect(within(head as HTMLElement).getByRole('button', { name: '下書きを破棄' })).toBeInTheDocument();
  });
  it('下書きが無ければ札を出さない', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} /></ActionRoot>);
    expect(screen.queryByText('下書き')).toBeNull();
    expect(screen.queryByRole('button', { name: '下書きを破棄' })).toBeNull();
  });
  it('「破棄」で名前と初期プロンプトを空にし、札を外し、下書きも消す。焦点は初期プロンプトの欄に戻る', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><NewSessionDialog {...base} draft={{ name: 'n', prompt: 'p', attachments: [] }} /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: '下書きを破棄' }));
    expect(prompt()).toHaveValue('');
    expect(chip('名前、なし')).toBeInTheDocument();
    expect(screen.queryByText('下書き')).toBeNull();
    expect(onAction).toHaveBeenCalledWith({ type: 'session.new.draft', name: '', prompt: '', attachments: [] });
    expect(prompt()).toHaveFocus();
  });
  it('閉じるときに、名前と初期プロンプトの書きかけを下書きとして送る', () => {
    const onAction = vi.fn();
    const { unmount } = render(<ActionRoot onAction={onAction}><NewSessionDialog {...base} /></ActionRoot>);
    setName('なまえ');
    fireEvent.change(prompt(), { target: { value: 'やって' } });
    // 打っている間は送らない。打鍵のたびに画面全体を描き直さないためである。
    expect(onAction).not.toHaveBeenCalled();
    unmount();
    expect(onAction).toHaveBeenCalledWith({ type: 'session.new.draft', name: 'なまえ', prompt: 'やって', attachments: [] });
  });
  it('添付があると、本文の後に空行とパスを足して起動する。追加ディレクトリは画面では足さない（置き場はサーバが足す）', () => {
    const params = collectParams({ projectId: 'p1', draft: { name: '', prompt: '見て', attachments: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }] } });
    start();
    expect(params).toEqual([{ projectId: 'p1', prompt: '見て\n\n/h/.agent-hangar/drops/1-0-a.png' }]);
    expect('addDirs' in params[0]!).toBe(false);
  });
  it('添付があっても、利用者が足した追加ディレクトリだけを渡す', () => {
    const params = collectParams({ projectId: 'p1', prefs: { p1: { addDirs: ['/mine'] } }, draft: { name: '', prompt: '見て', attachments: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }] } });
    start();
    expect(params[0]!.addDirs).toEqual(['/mine']);
  });
  it('本文が空でも、添付だけで起動できる', () => {
    const params = collectParams({ projectId: 'p1', draft: { name: '', prompt: '', attachments: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }] } });
    start();
    expect(params).toEqual([{ projectId: 'p1', prompt: '/h/.agent-hangar/drops/1-0-a.png' }]);
  });
  it('閉じるときの下書きに、添付も入れる', () => {
    const drafts: unknown[] = [];
    const a = { path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 };
    const { unmount } = render(<ActionRoot onAction={(i) => { if (i.type === 'session.new.draft') drafts.push(i); }}><NewSessionDialog {...base} draft={{ name: 'n', prompt: '', attachments: [a] }} /></ActionRoot>);
    unmount();
    expect(drafts).toEqual([{ type: 'session.new.draft', name: 'n', prompt: '', attachments: [a] }]);
  });
  it('下書きを破棄すると、添付も消える', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} draft={{ name: 'n', prompt: '', attachments: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }] }} /></ActionRoot>);
    expect(screen.getByRole('listitem', { name: 'a.png' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下書きを破棄' }));
    expect(screen.queryByRole('listitem', { name: 'a.png' })).toBeNull();
  });
  describe('添付を送っている最中', () => {
    /** 手で解決できる送信を持つ、ダイアログの描画。 */
    function pending(over: Partial<NewSessionProps> = {}) {
      const actions: UiAction[] = [];
      let finish: (d: { path: string; name: string; size: number }) => void = () => {};
      let fail: (e: Error) => void = () => {};
      const upload = vi.fn(() => new Promise<{ path: string; name: string; size: number }>((res, rej) => { finish = res; fail = rej; }));
      const ui = (props: Partial<NewSessionProps>) => (
        <PromptAssistContext.Provider value={{ ...NO_ASSIST, upload }}>
          <ActionRoot onAction={(i) => actions.push(i)}><NewSessionDialog {...base} projectId="p1" {...over} {...props} /></ActionRoot>
        </PromptAssistContext.Provider>
      );
      const view = render(ui({}));
      return { ...view, actions, ui, finish: (d = { path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }) => finish(d), fail: (e: Error) => fail(e) };
    }
    const paste = () => fireEvent.paste(prompt(), { clipboardData: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });

    it('起動ボタンは使えず「添付を送っています」と出し、⌘Enter でも起動しない。終われば添付のパスつきで起動できる', async () => {
      const t = pending();
      fireEvent.change(prompt(), { target: { value: '見て' } });
      paste();
      const btn = screen.getByRole('button', { name: '添付を送っています' });
      expect(btn).toBeDisabled();
      fireEvent.keyDown(prompt(), { key: 'Enter', metaKey: true });
      expect(t.actions.filter((i) => i.type === 'session.new.submit')).toEqual([]);
      await act(async () => { t.finish(); });
      expect(screen.queryByRole('button', { name: '添付を送っています' })).toBeNull();
      start();
      expect(t.actions.filter((i) => i.type === 'session.new.submit')).toEqual([{ type: 'session.new.submit', params: { projectId: 'p1', prompt: '見て\n\n/h/.agent-hangar/drops/1-0-a.png' } }]);
    });
    it('失敗したら、起動できる状態に戻る', async () => {
      const t = pending();
      paste();
      expect(screen.getByRole('button', { name: '添付を送っています' })).toBeDisabled();
      await act(async () => { t.fail(new Error('x')); });
      expect(screen.getByRole('button', { name: /起動/ })).toBeEnabled();
    });
    // 閉じる前の名前と本文で下書きを置き換えると、開き直したダイアログの書きかけを上書きする。遅れて着いた添付だけを足す UiAction を送る。
    it('送っている最中に閉じても、終わったときに、着いた添付だけを下書きへ足す（名前と本文は送らない）', async () => {
      const t = pending();
      setName('なまえ');
      fireEvent.change(prompt(), { target: { value: '見て' } });
      paste();
      t.unmount();
      t.actions.length = 0;
      await act(async () => { t.finish(); });
      expect(t.actions).toEqual([{ type: 'session.new.draft.attach', attachments: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }] }]);
    });
    it('閉じた後に 2 件が終わったら、1 件ずつ、その 1 件だけを持つ UiAction を送る', async () => {
      const actions: UiAction[] = [];
      const done: ((d: { path: string; name: string; size: number }) => void)[] = [];
      const upload = vi.fn(() => new Promise<{ path: string; name: string; size: number }>((res) => { done.push(res); }));
      const view = render(
        <PromptAssistContext.Provider value={{ ...NO_ASSIST, upload }}>
          <ActionRoot onAction={(i) => actions.push(i)}><NewSessionDialog {...base} projectId="p1" /></ActionRoot>
        </PromptAssistContext.Provider>,
      );
      paste();
      paste();
      // 閉じる前に着いたものは、閉じるときの下書きに入る。ここでは何も着いていない。
      view.unmount();
      actions.length = 0;
      const a = { path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 };
      const b = { path: '/h/.agent-hangar/drops/1-1-b.png', name: 'b.png', size: 4 };
      await act(async () => { done[0]!(a); });
      await act(async () => { done[1]!(b); });
      expect(actions).toEqual([{ type: 'session.new.draft.attach', attachments: [a] }, { type: 'session.new.draft.attach', attachments: [b] }]);
    });
    it('起動を送った後に閉じたなら、終わっても下書きを送らない', async () => {
      const t = pending();
      paste();
      t.rerender(t.ui({ submitting: true }));
      t.unmount();
      t.actions.length = 0;
      await act(async () => { t.finish(); });
      expect(t.actions).toEqual([]);
    });
  });
  it('起動を送った後に閉じたとき（起動し終えたとき）は、下書きを送らない', () => {
    const onAction = vi.fn();
    const { rerender, unmount } = render(<ActionRoot onAction={onAction}><NewSessionDialog {...base} projectId="p1" /></ActionRoot>);
    setName('なまえ');
    rerender(<ActionRoot onAction={onAction}><NewSessionDialog {...base} projectId="p1" submitting /></ActionRoot>);
    unmount();
    expect(onAction.mock.calls.filter(([i]) => i.type === 'session.new.draft')).toEqual([]);
  });
});

describe('NewSessionDialog の前回値（D1）', () => {
  const prefs = { p1: { model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }, p2: { model: 'claude-x', worktree: 'wt', addDirs: ['/a', '/b'] } };
  const prev = () => screen.queryByText('前回と同じ');
  it('選んだプロジェクトの前回値を札の値にし、札の下に「前回と同じ」と「既定に戻す」を出す', () => {
    const params = collectParams({ projectId: 'p1', prefs });
    expect(chip('モデル、opus')).toBeInTheDocument();
    expect(chip('effort レベル、high')).toBeInTheDocument();
    expect(chip('権限モード、Accept edits')).toBeInTheDocument();
    expect(prev()).toBeInTheDocument();
    expect(screen.getByText('alpha で最後に起動したときの設定です')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '既定に戻す' })).toBeInTheDocument();
    // 札の列の下にある。
    expect(Boolean(group().compareDocumentPosition(prev()!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    start();
    expect(params).toEqual([{ projectId: 'p1', model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }]);
  });
  it('権限モードの一覧では、前回の値の行に「前回」を添える', () => {
    collectParams({ projectId: 'p1', prefs });
    fireEvent.click(chip('権限モード、Accept edits'));
    const rows = within(screen.getByRole('listbox', { name: '権限モード' })).getAllByRole('option');
    expect(rows.filter((r) => r.textContent?.includes('前回')).map((r) => r.textContent)).toEqual(['Accept edits前回']);
  });
  it('worktree は残さず、追加ディレクトリ、選択肢に無い model は戻す', () => {
    const params = collectParams({ projectId: 'p2', prefs });
    expect(chip('モデル、claude-x')).toBeInTheDocument();
    expect(chip('追加ディレクトリ、2 件')).toBeInTheDocument();
    // 前回値の worktree は札の値になる（prefs が持つ場合）が、保存側（launchPrefsOf）は書かない。ここでは受けた値をそのまま出す。
    expect(chip('worktree、wt')).toBeInTheDocument();
    fireEvent.click(chip('追加ディレクトリ、2 件'));
    expect(screen.getByRole('textbox', { name: '追加ディレクトリ' })).toHaveValue('/a\n/b');
    start();
    expect(params).toEqual([{ projectId: 'p2', model: 'claude-x', worktree: 'wt', addDirs: ['/a', '/b'] }]);
  });
  it('「既定に戻す」で札を全部既定に戻し、「前回と同じ」を外す', () => {
    const params = collectParams({ projectId: 'p1', prefs });
    fireEvent.click(screen.getByRole('button', { name: '既定に戻す' }));
    for (const name of ['モデル、既定', 'effort レベル、既定', '権限モード、既定', 'worktree、なし']) expect(chip(name)).toBeInTheDocument();
    expect(prev()).toBeNull();
    expect(screen.queryByRole('button', { name: '既定に戻す' })).toBeNull();
    start();
    expect(params).toEqual([{ projectId: 'p1' }]);
  });
  it('値を変えると「前回と同じ」を外す', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} projectId="p1" prefs={prefs} /></ActionRoot>);
    choose('モデル、opus', 'sonnet');
    expect(prev()).toBeNull();
    expect(chip('モデル、sonnet')).toBeInTheDocument();
  });
  it('前回値が無い（既定だけの）プロジェクトでは、「前回と同じ」を出さない', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} projectId="p1" prefs={{ p2: { model: 'opus' } }} /></ActionRoot>);
    expect(prev()).toBeNull();
  });
  it('札に触れる前にプロジェクトを選び直すと、そのプロジェクトの前回値に入れ替える', () => {
    const params = collectParams({ projectId: 'p1', prefs });
    pick('プロジェクト', 'beta');
    expect(chip('worktree、wt')).toBeInTheDocument();
    pick('プロジェクト', 'クイックセッション');
    // 前回値の無い場所は既定に戻す。
    expect(chip('worktree、なし')).toBeInTheDocument();
    expect(prev()).toBeNull();
    start();
    expect(params).toEqual([{ scratch: true }]);
  });
  it('札に触れた後は、プロジェクトを選び直しても自分で選んだ値を残す', () => {
    const params = collectParams({ projectId: 'p1', prefs });
    choose('effort レベル、high', 'low');
    pick('プロジェクト', 'beta');
    start();
    expect(params).toEqual([{ projectId: 'p2', model: 'opus', effort: 'low', permissionMode: 'acceptEdits' }]);
  });
  it('クイックセッションの前回値を使う。何も選ばずに開いたときも同じ', () => {
    const params = collectParams({ prefs: { ':scratch': { effort: 'max' } } });
    expect(chip('effort レベル、max')).toBeInTheDocument();
    expect(screen.getByText('クイックセッション で最後に起動したときの設定です')).toBeInTheDocument();
    start();
    expect(params).toEqual([{ scratch: true, effort: 'max' }]);
  });
  it('初期プロンプトで / の候補から選ぶと、その文で起動する', async () => {
    const out: LaunchParams[] = [];
    const assist = { ...NO_ASSIST, commands: () => Promise.resolve([{ name: 'goal', description: '長く走る', argumentHint: null, source: 'user' as const, uses: 3 }]) };
    render(<PromptAssistContext.Provider value={assist}><ActionRoot onAction={(i) => { if (i.type === 'session.new.submit') out.push(i.params); }}><NewSessionDialog {...base} projectId="p1" /></ActionRoot></PromptAssistContext.Provider>);
    await act(async () => {});
    const ta = prompt();
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: '/g', selectionStart: 2, selectionEnd: 2 } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(out).toEqual([]);
    start();
    expect(out).toEqual([{ projectId: 'p1', prompt: '/goal' }]);
  });
  it('候補が開いている間の Esc は、ダイアログを閉じない', async () => {
    const closed = vi.fn();
    const assist = { ...NO_ASSIST, commands: () => Promise.resolve([{ name: 'goal', description: '', argumentHint: null, source: 'user' as const, uses: 0 }]) };
    render(<PromptAssistContext.Provider value={assist}><ActionRoot onAction={(i) => { if (i.type === 'overlay.close') closed(); }}><NewSessionDialog {...base} projectId="p1" /></ActionRoot></PromptAssistContext.Provider>);
    await act(async () => {});
    const ta = prompt();
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: '/', selectionStart: 1, selectionEnd: 1 } });
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(closed).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox', { name: 'スキルとコマンド' })).toBeNull();
  });
});

/** 送られた action をすべて集める。 */
function collect(over: Partial<NewSessionProps> = {}) {
  const out: UiAction[] = [];
  const view = render(<ActionRoot onAction={(i) => out.push(i)}><NewSessionDialog {...base} {...over} /></ActionRoot>);
  return { out, view };
}
const openList = () => fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
const typeQuery = (q: string) => fireEvent.change(screen.getByRole('combobox'), { target: { value: q } });

describe('NewSessionDialog から作って始める', () => {
  it('語に一致しなければ「『語』を新しいフォルダとして作る」を選べ、git init 付きの place で送る', () => {
    const { out } = collect();
    openList();
    typeQuery('price');
    fireEvent.click(screen.getByRole('option', { name: '「price」を新しいフォルダとして作る' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('新しいフォルダで始める');
    expect(chip('プロジェクト')).toHaveTextContent('price');
    expect(screen.getByLabelText('フォルダの名前')).toHaveValue('price');
    expect(screen.getByText('/w/price を作り、プロジェクトに登録して起動します')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'git init を実行' })).toHaveAttribute('aria-checked', 'true');
    start();
    expect(out.filter((i) => i.type === 'session.new.submit')).toEqual([{ type: 'session.new.submit', params: {}, place: { kind: 'newDir', name: 'price', gitInit: true } }]);
  });
  it('フォルダの名前の欄では、変換中の Enter で起動せず、Enter で起動する', () => {
    const { out } = collect();
    openList();
    typeQuery('price');
    fireEvent.click(screen.getByRole('option', { name: '「price」を新しいフォルダとして作る' }));
    const box = screen.getByLabelText('フォルダの名前');
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    expect(out.filter((i) => i.type === 'session.new.submit')).toEqual([]);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(out.filter((i) => i.type === 'session.new.submit')).toHaveLength(1);
  });
  it('語が既存のプロジェクトか未登録のフォルダの名前と同じなら、作る操作はその名前にしない', () => {
    collect();
    openList();
    typeQuery('alpha');
    expect(screen.queryByRole('option', { name: '「alpha」を新しいフォルダとして作る' })).toBeNull();
    expect(screen.getByRole('option', { name: '新しいフォルダを作る…' })).toBeInTheDocument();
    typeQuery('url-short');
    expect(screen.queryByRole('option', { name: '「url-short」を新しいフォルダとして作る' })).toBeNull();
  });
  it('アーカイブのプロジェクトのフォルダ名と、大文字小文字だけ違う名前にも、作る操作をその名前にしない', () => {
    collect({ takenNames: ['alpha', 'beta', 'old-kadai'] });
    openList();
    for (const q of ['old-kadai', 'Old-Kadai', 'ALPHA', 'URL-Short']) {
      typeQuery(q);
      expect(screen.queryByRole('option', { name: `「${q}」を新しいフォルダとして作る` })).toBeNull();
      expect(screen.getByRole('option', { name: '新しいフォルダを作る…' })).toBeInTheDocument();
    }
  });
  it('未登録のフォルダは語に一致したときだけ「未登録」の札付きで出て、選ぶと登録して始める', () => {
    const { out } = collect();
    openList();
    expect(screen.queryByRole('option', { name: 'url-short' })).toBeNull();
    typeQuery('url');
    fireEvent.click(screen.getByRole('option', { name: 'url-short' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('フォルダを登録して始める');
    expect(screen.getByText('/w/url-short はまだプロジェクトではありません。起動すると登録します')).toBeInTheDocument();
    start();
    expect(out.find((i) => i.type === 'session.new.submit')).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/w/url-short' } });
  });
  it('「ほかの場所を選ぶ…」は殻の中だけで出て、押すと folder.pick を送る', () => {
    const { out, view } = collect();
    openList();
    fireEvent.click(screen.getByRole('option', { name: 'ほかの場所を選択…' }));
    expect(out).toContainEqual({ type: 'folder.pick' });
    view.unmount();
    collect({ desktop: false });
    openList();
    expect(screen.queryByRole('option', { name: 'ほかの場所を選択…' })).toBeNull();
  });
  it('「ほかの場所を選択…」に添える選び手の名前は、macOS は Finder、Windows はエクスプローラー', () => {
    const { view } = collect();
    openList();
    expect(screen.getByRole('option', { name: 'ほかの場所を選択…' })).toHaveTextContent('Finder');
    view.unmount();
    setClientUserAgent(WINDOWS_UA);
    collect();
    openList();
    const option = screen.getByRole('option', { name: 'ほかの場所を選択…' });
    expect(option).toHaveTextContent('エクスプローラー');
    expect(option).not.toHaveTextContent('Finder');
  });
  it('Finder で選んだプロジェクトの親フォルダの外のフォルダは、外である旨を添えて登録して始める', () => {
    const { out, view } = collect();
    view.rerender(<ActionRoot onAction={(i) => out.push(i)}><NewSessionDialog {...base} picked={{ path: '/Users/me/thesis', n: 1 }} /></ActionRoot>);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('フォルダを登録して始める');
    expect(chip('プロジェクト')).toHaveTextContent('thesis');
    expect(screen.getByText(/プロジェクトの親フォルダの外のフォルダです。この PC でのパスだけを覚えます/)).toBeInTheDocument();
    start();
    expect(out.find((i) => i.type === 'session.new.submit')).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/Users/me/thesis' } });
  });
  it('Finder で選んだのが未登録の一覧にあるフォルダなら、未登録のフォルダと同じ 1 行で登録して始める', () => {
    const { out, view } = collect();
    view.rerender(<ActionRoot onAction={(i) => out.push(i)}><NewSessionDialog {...base} picked={{ path: '/w/url-short', n: 1 }} /></ActionRoot>);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('フォルダを登録して始める');
    expect(screen.getByText('/w/url-short はまだプロジェクトではありません。起動すると登録します')).toBeInTheDocument();
    expect(screen.queryByText(/親フォルダの外のフォルダです/)).toBeNull();
    start();
    expect(out.find((i) => i.type === 'session.new.submit')).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/w/url-short' } });
  });
  it('Finder で選んだのが登録済みのプロジェクトなら、そのプロジェクトを選ぶ', () => {
    const { out, view } = collect();
    view.rerender(<ActionRoot onAction={(i) => out.push(i)}><NewSessionDialog {...base} picked={{ path: '/w/beta', n: 1 }} /></ActionRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('beta');
    start();
    expect(out.find((i) => i.type === 'session.new.submit')).toEqual({ type: 'session.new.submit', params: { projectId: 'p2' } });
  });
  it('開いたときに既にあった Finder の結果は使わない（別のダイアログで選んだもの）', () => {
    collect({ picked: { path: '/Users/me/old', n: 3 } });
    expect(screen.getByRole('dialog')).toHaveAccessibleName('新しいセッション');
  });
  it('作れた後に起動だけ失敗したら、作ったプロジェクトを選び直し、押し直しでは作らない', () => {
    const projectsWithNew = [...projects, { id: 'p9', name: 'price', path: '/w/price', status: 'active' as const, lastActivity: '' }];
    const { out, view } = collect();
    openList();
    typeQuery('price');
    fireEvent.click(screen.getByRole('option', { name: '「price」を新しいフォルダとして作る' }));
    view.rerender(<ActionRoot onAction={(i) => out.push(i)}><NewSessionDialog {...base} projects={projectsWithNew} error="tmux が見つかりません" createdProjectId="p9" /></ActionRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('price');
    expect(screen.getByRole('alert')).toHaveTextContent('tmux が見つかりません');
    start();
    expect(out.filter((i) => i.type === 'session.new.submit').at(-1)).toEqual({ type: 'session.new.submit', params: { projectId: 'p9' } });
  });
});

describe('NewSessionDialog のアカウントの札', () => {
  const NOW = new Date(2026, 9, 6, 12, 0).getTime();
  const list = presentAccounts({ ...initialStore(), accounts: accountsFixture }, NOW);
  const accountsOf = (over: Partial<AccountView>[] = [{}, {}], currentId = 'primary'): NonNullable<NewSessionProps['accounts']> => ({ list: list.map((a, i) => ({ ...a, ...over[i] })), currentId });
  const accountChip = (now: string) => chip(`アカウント、${now}`);
  const accountRow = (name: string) => within(screen.getByRole('listbox', { name: 'アカウント' })).getByRole('option', { name: new RegExp(name) });
  /** 札を開いて行を押す。選べない行は押しても変わらず、一覧も開いたままである。 */
  const chooseAccount = (from: string, to: string) => { fireEvent.click(accountChip(from)); fireEvent.click(accountRow(to)); };
  /** 起動と accounts.load を集める。 */
  function collect(over: Partial<NewSessionProps> = {}) {
    const actions: { type: string; params?: LaunchParams }[] = [];
    const ui = (p: Partial<NewSessionProps>) => <ActionRoot onAction={(i) => { actions.push(i as never); }}><NewSessionDialog {...base} {...p} /></ActionRoot>;
    const view = render(ui(over));
    return { actions, params: () => actions.filter((i) => i.type === 'session.new.submit').map((i) => i.params!), rerender: (p: Partial<NewSessionProps>) => view.rerender(ui(p)) };
  }

  it('accounts が null なら、アカウントの札を出さず、params に account を入れない', () => {
    const { params, actions } = collect({ projectId: 'p1', accounts: null });
    expect(within(group()).queryByRole('button', { name: /^アカウント/ })).toBeNull();
    start();
    expect(params()).toEqual([{ projectId: 'p1' }]);
    expect('account' in params()[0]!).toBe(false);
    expect(actions.some((i) => i.type === 'accounts.load')).toBe(false);
  });
  it('札は、プロジェクトの札の次、モデルの札の前に、アカウントの色の点つきで出る', () => {
    collect({ accounts: accountsOf() });
    expect(within(group()).getAllByRole('button').map((b) => b.getAttribute('aria-label')).slice(0, 3)).toEqual(['プロジェクト', 'アカウント、会社', 'モデル、既定']);
    expect((accountChip('会社').querySelector('.st-dot') as HTMLElement).style.color).toBe('rgb(42, 87, 184)');
  });
  it('一覧は 2 件のアカウントを色の点つきで並べ、はじめはいまのアカウントを選ぶ。そのまま起動すると account に入れる', () => {
    const { params } = collect({ projectId: 'p1', accounts: accountsOf() });
    fireEvent.click(accountChip('会社'));
    expect(within(screen.getByRole('listbox', { name: 'アカウント' })).getAllByRole('option')).toHaveLength(2);
    expect(accountRow('会社')).toHaveAttribute('aria-selected', 'true');
    expect(accountRow('大学')).toHaveAttribute('aria-selected', 'false');
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'アカウント' }), { key: 'Escape' });
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
  it('大学を選んで起動すると account は a1 で、いまのアカウントは変えない（account.choose を出さない）', () => {
    const { actions, params } = collect({ projectId: 'p1', accounts: accountsOf() });
    chooseAccount('会社', '大学');
    expect(accountChip('大学')).toBeInTheDocument();
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'a1' }]);
    expect(actions.map((i) => i.type)).not.toContain('account.choose');
  });
  it('いまのアカウントが未ログインなら、はじめはログイン済みの最初の 1 件を選び、その行に理由を添える', () => {
    const { params } = collect({ projectId: 'p1', accounts: accountsOf([{ auth: 'out' }, {}]) });
    expect(accountChip('大学')).toBeInTheDocument();
    fireEvent.click(accountChip('大学'));
    expect(accountRow('会社')).toHaveAttribute('aria-disabled', 'true');
    expect(accountRow('会社')).toHaveTextContent('未ログイン');
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'アカウント' }), { key: 'Escape' });
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'a1' }]);
  });
  it('いまのアカウントが初めてのログインの途中でも飛ばす。まだ読めていない（unknown）なら選ぶ', () => {
    collect({ accounts: accountsOf([{ auth: 'running', loggedIn: false }, {}]) });
    expect(accountChip('大学')).toBeInTheDocument();
    document.body.innerHTML = '';
    collect({ accounts: accountsOf([{ auth: 'unknown' }, {}]) });
    expect(accountChip('会社')).toBeInTheDocument();
  });
  it('いまのアカウントがログインし直しの途中でも、はじめの選択は動かず、選べる', () => {
    const { params } = collect({ projectId: 'p1', accounts: accountsOf([{ auth: 'running', loggedIn: true }, {}]) });
    expect(accountChip('会社')).toBeInTheDocument();
    fireEvent.click(accountChip('会社'));
    expect(accountRow('会社')).not.toHaveAttribute('aria-disabled');
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'アカウント' }), { key: 'Escape' });
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
  it('どれも選べないときは、いまのアカウントのままにする', () => {
    const { params } = collect({ projectId: 'p1', accounts: accountsOf([{ auth: 'out' }, { auth: 'out' }]) });
    expect(accountChip('会社')).toBeInTheDocument();
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
  it('未ログインの行は押しても選べない', () => {
    const { params } = collect({ projectId: 'p1', accounts: accountsOf([{}, { auth: 'out' }]) });
    chooseAccount('会社', '大学');
    expect(screen.getByRole('dialog', { name: 'アカウント' })).toBeInTheDocument();
    expect(accountRow('会社')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'アカウント' }), { key: 'Escape' });
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
  it('開いたときに accounts.load を 1 回だけ出す', () => {
    const { actions, rerender } = collect({ accounts: accountsOf() });
    expect(actions.filter((i) => i.type === 'accounts.load')).toHaveLength(1);
    chooseAccount('会社', '大学');
    rerender({ accounts: accountsOf() });
    expect(actions.filter((i) => i.type === 'accounts.load')).toHaveLength(1);
  });
  it('選んでいた id が props から消えたら、いまのアカウントに戻す', () => {
    const { params, rerender } = collect({ projectId: 'p1', accounts: accountsOf() });
    chooseAccount('会社', '大学');
    rerender({ projectId: 'p1', accounts: { list: [list[0]!, { ...list[0]!, id: 'a2', name: '個人', current: false }], currentId: 'primary' } });
    expect(accountChip('会社')).toBeInTheDocument();
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
  it('開いてから送るまでにいまのアカウントが変わっても、選んだとおりに起こす', () => {
    const { params, rerender } = collect({ projectId: 'p1', accounts: accountsOf() });
    chooseAccount('会社', '大学');
    rerender({ projectId: 'p1', accounts: accountsOf([{}, {}], 'a1') });
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'a1' }]);
  });
  it.each(['out', 'running'] as const)('選んでいた行が選べなくなったら（%s）、いまのアカウントへ戻し、そのとおりに起動する', (auth) => {
    const { params, rerender } = collect({ projectId: 'p1', accounts: accountsOf() });
    chooseAccount('会社', '大学');
    expect(accountChip('大学')).toBeInTheDocument();
    rerender({ projectId: 'p1', accounts: accountsOf([{}, { auth, loggedIn: false }]) });
    expect(accountChip('会社')).toBeInTheDocument();
    fireEvent.click(accountChip('会社'));
    expect(accountRow('大学')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'アカウント' }), { key: 'Escape' });
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
  it('まだ自分で選んでいない間は、開いたままいまのアカウントが変わるとはじめの選択も付いていく', () => {
    const { params, rerender } = collect({ projectId: 'p1', accounts: accountsOf() });
    expect(accountChip('会社')).toBeInTheDocument();
    rerender({ projectId: 'p1', accounts: accountsOf([{}, {}], 'a1') });
    expect(accountChip('大学')).toBeInTheDocument();
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'a1' }]);
  });
  it('選んだあとにプロジェクトを選び直しても、アカウントの選択は残る', () => {
    const { params } = collect({ accounts: accountsOf() });
    chooseAccount('会社', '大学');
    pick('プロジェクト', 'alpha');
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'a1' }]);
  });
  it('札の上の Enter は起動に使わず、⌘Enter なら起動する', () => {
    const { params } = collect({ projectId: 'p1', accounts: accountsOf() });
    fireEvent.keyDown(accountChip('会社'), { key: 'Enter' });
    expect(params()).toEqual([]);
    fireEvent.keyDown(accountChip('会社'), { key: 'Enter', metaKey: true });
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
});
