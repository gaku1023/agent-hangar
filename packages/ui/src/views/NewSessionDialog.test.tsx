import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexOptionsDto, UiAction, LaunchParams } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { NewSessionProps } from '../presenters/newSession.ts';
import { presentAccounts, type AccountView } from '../presenters/accounts.ts';
import { accountsFixture } from '../test/accounts.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { initialStore } from '../store/store.ts';
import type { LaunchPrepView } from '../presenters/launchPrep.ts';
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
  fireEvent.click(chip('設定を追加'));
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
  it('同じファイルの編集の警告から開いたときは、worktree の札に新しい名前が入り、そのまま起動に載る', () => {
    const params = collectParams({ projectId: 'p1', worktree: true });
    expect(chip(/^worktree、parallel-[0-9a-z]+$/)).toBeInTheDocument();
    start();
    expect(params[0]?.worktree).toMatch(/^parallel-[0-9a-z]+$/);
    expect(params[0]?.projectId).toBe('p1');
  });
  it('選んで起動すると、画面で決めた値が全部 params に載る', () => {
    const params = collectParams();
    pick('プロジェクト', 'alpha');
    fireEvent.change(prompt(), { target: { value: 'やって' } });
    setName('n');
    choose('モデル、デフォルト', 'opus');
    choose('effort レベル、デフォルト', 'high');
    choose('権限モード、デフォルト', 'Plan');
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
    expect(within(group()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.getAttribute('title'))).toEqual(['プロジェクト', 'モデル、デフォルト', 'effort レベル、デフォルト', '権限モード、デフォルト', 'worktree、なし', '設定を追加']);
  });
  it('何も選ばなければ札は「クイックセッション」と言い、そのまま起動すると scratch で始まる', () => {
    const params = collectParams();
    expect(chip('プロジェクト')).toHaveTextContent('クイックセッション');
    // 札の「クイックセッション」で読めるので、説明の文は添えない。
    expect(screen.queryByText(/プロジェクトを選ばない場合は/)).toBeNull();
    start();
    expect(params).toEqual([{ scratch: true }]);
  });
  it('プロジェクトの一覧は、クイックスタート、最近、すべての群に分かれ、パスと時期を添える', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
    const groups = within(screen.getByRole('listbox')).getAllByRole('group');
    expect(groups[0]).toHaveAccessibleName('クイックスタート');
    expect(within(groups[0]!).getByRole('option', { name: 'クイックセッション' })).toHaveAccessibleDescription('名前を決めずに開始し、あとでプロジェクトにできます');
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
    for (const name of ['モデル、デフォルト', 'effort レベル、デフォルト', '権限モード、デフォルト', 'worktree、なし']) {
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
    fireEvent.click(chip('effort レベル、デフォルト'));
    expect(within(screen.getByRole('listbox', { name: 'effort レベル' })).getAllByRole('option').map((r) => r.textContent)).toEqual(['デフォルト', 'low', 'medium', 'high', 'xhigh', 'max']);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'effort レベル' }), { key: 'Escape' });
    fireEvent.click(chip('権限モード、デフォルト'));
    expect(within(screen.getByRole('listbox', { name: '権限モード' })).getAllByRole('option').map((r) => r.textContent)).toEqual(['デフォルト', 'Plan', 'Manual', 'Accept edits', 'Auto', "Don't ask", 'Bypass permissions']);
  });
  it('「ほか」で打った model を、前後の空白を落として入れる', () => {
    const params = collectParams({ projectId: 'p1' });
    fireEvent.click(chip('モデル、デフォルト'));
    fireEvent.change(screen.getByRole('textbox', { name: 'その他のモデル名' }), { target: { value: ' claude-opus-5-5 ' } });
    start();
    expect(params[0]).toEqual({ projectId: 'p1', model: 'claude-opus-5-5' });
  });
  it('「ほか」に空白だけを打ったら model を入れない', () => {
    const params = collectParams({ projectId: 'p1' });
    fireEvent.click(chip('モデル、デフォルト'));
    fireEvent.change(screen.getByRole('textbox', { name: 'その他のモデル名' }), { target: { value: '   ' } });
    start();
    expect(Object.keys(params[0]!)).toEqual(['projectId']);
  });
  describe('Bypass permissions', () => {
    it('選ぶと札が赤くなり、起動のボタンが赤い「Bypass permissions で起動」になる。確認のダイアログも注意の文も出さない', () => {
      const params = collectParams({ projectId: 'p1' });
      expect(screen.getByRole('button', { name: '起動' })).toHaveClass('btn-primary');
      choose('権限モード、デフォルト', /Bypass permissions/);
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
      expect(screen.getByRole('button', { name: '起動中…' })).toBeDisabled();
    });
  });
  it('送信中と失敗の表示', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} projectId="p1" submitting error="tmux が未検出" /></ActionRoot>);
    expect(screen.getByRole('button', { name: '起動中…' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('tmux が未検出');
    expect(screen.getByText(/信頼の確認ダイアログ/)).toBeInTheDocument();
  });
  // クイックセッションの置き場は hangar が前もって信頼済みにするので、信頼確認の注意は出さない。
  it('クイックセッションでは信頼確認の注意を出さない', () => {
    render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} scratch /></ActionRoot>);
    expect(screen.queryByText(/信頼確認/)).toBeNull();
  });
  // 未選択で送った後にプロジェクトを選んでも、「プロジェクトを選択してください」が残っていた。
  it('失敗の文言は、プロジェクトを選び直したら消え、送り直して同じ失敗ならまた出す', () => {
    const onAction = vi.fn();
    const ui = (error: string | null) => <ActionRoot onAction={onAction}><NewSessionDialog {...base} error={error} /></ActionRoot>;
    const { rerender } = render(ui('プロジェクトを選択してください'));
    expect(screen.getByRole('alert')).toHaveTextContent('プロジェクトを選択してください');
    pick('プロジェクト', 'alpha');
    expect(screen.queryByRole('alert')).toBeNull();
    start();
    rerender(ui('プロジェクトを選択してください'));
    expect(screen.getByRole('alert')).toHaveTextContent('プロジェクトを選択してください');
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
    for (const target of [chip('権限モード、デフォルト'), chip('モデル、デフォルト'), chip('設定を追加'), screen.getByRole('button', { name: 'キャンセル' })]) {
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
      fireEvent.keyDown(chip('権限モード、デフォルト'), { key: 'Enter', metaKey: true });
      fireEvent.keyDown(chip('モデル、デフォルト'), { key: 'Enter', metaKey: true });
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
    });
    it('下端には「そのまま ⌘↵ で」の一言を出さない（ボタンのキー帽で足りる）', () => {
      render(<ActionRoot onAction={() => {}}><NewSessionDialog {...base} /></ActionRoot>);
      expect(document.querySelector('.dialog-hint')).toBeNull();
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
    fireEvent.click(chip('設定を追加'));
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
    fireEvent.click(chip('設定を追加'));
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
  it('クイックセッションの行は昇格できることを添え、選ぶと scratch を付けて送る', () => {
    const params = collectParams({ projectId: 'p1' });
    expect(screen.queryByText(/プロジェクトを選ばないと/)).toBeNull();
    pick('プロジェクト', 'クイックセッション');
    expect(screen.getByRole('dialog', { name: '新しいセッション' })).toBeInTheDocument();
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
    expect(screen.queryByText(/あとでプロジェクトにできます/)).toBeNull();
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
  it('添付があると、本文の後に空行とパスを足して起動する。追加ディレクトリは画面では足さない（置き場はサーバーが足す）', () => {
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
      const btn = screen.getByRole('button', { name: '添付ファイルをアップロード中…' });
      expect(btn).toBeDisabled();
      fireEvent.keyDown(prompt(), { key: 'Enter', metaKey: true });
      expect(t.actions.filter((i) => i.type === 'session.new.submit')).toEqual([]);
      await act(async () => { t.finish(); });
      expect(screen.queryByRole('button', { name: '添付ファイルをアップロード中…' })).toBeNull();
      start();
      expect(t.actions.filter((i) => i.type === 'session.new.submit')).toEqual([{ type: 'session.new.submit', params: { projectId: 'p1', prompt: '見て\n\n/h/.agent-hangar/drops/1-0-a.png' } }]);
    });
    it('失敗したら、起動できる状態に戻る', async () => {
      const t = pending();
      paste();
      expect(screen.getByRole('button', { name: '添付ファイルをアップロード中…' })).toBeDisabled();
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
    expect(screen.getByRole('button', { name: 'デフォルトに戻す' })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'デフォルトに戻す' }));
    for (const name of ['モデル、デフォルト', 'effort レベル、デフォルト', '権限モード、デフォルト', 'worktree、なし']) expect(chip(name)).toBeInTheDocument();
    expect(prev()).toBeNull();
    expect(screen.queryByRole('button', { name: 'デフォルトに戻す' })).toBeNull();
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
  it('設定の既定のモデルを、前回値の無いときのモデルの札の初めの値にする。前回値のモデルが先', () => {
    const params = collectParams({ projectId: 'p1', prefs: { p2: { worktree: 'wt' } }, defaultModel: 'sonnet' });
    expect(chip('モデル、sonnet')).toBeInTheDocument();
    start();
    expect(params).toEqual([{ projectId: 'p1', model: 'sonnet' }]);
  });
  it('前回値にモデルがあれば、既定のモデルより先に使う。モデルの無い前回値には既定のモデルを入れる', () => {
    collectParams({ projectId: 'p1', prefs, defaultModel: 'sonnet' });
    expect(chip('モデル、opus')).toBeInTheDocument();
    pick('プロジェクト', 'beta');
    expect(chip('モデル、claude-x')).toBeInTheDocument();
  });
  it('「既定に戻す」は、モデルを設定の既定のモデルに戻す', () => {
    const params = collectParams({ projectId: 'p1', prefs, defaultModel: 'haiku' });
    fireEvent.click(screen.getByRole('button', { name: 'デフォルトに戻す' }));
    expect(chip('モデル、haiku')).toBeInTheDocument();
    start();
    expect(params).toEqual([{ projectId: 'p1', model: 'haiku' }]);
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
    fireEvent.click(screen.getByRole('option', { name: '新しいディレクトリ「price」を作成' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('新しいディレクトリで開始');
    expect(chip('プロジェクト')).toHaveTextContent('price');
    expect(screen.getByLabelText('ディレクトリ名')).toHaveValue('price');
    expect(screen.getByText('/w/price を作成し、プロジェクトに登録して起動します')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'git init を実行' })).toHaveAttribute('aria-checked', 'true');
    start();
    expect(out.filter((i) => i.type === 'session.new.submit')).toEqual([{ type: 'session.new.submit', params: {}, place: { kind: 'newDir', name: 'price', gitInit: true } }]);
  });
  // 作成場所は任意（2026-10-13）。空なら、新しいフォルダを作る場所を選んでから起動する。
  it('作成場所が空なら、作る場所を選ぶまで起動できず、選んだ場所を添えて送る', () => {
    const { out, view } = collect({ workspaceRoot: '', dirs: [] });
    openList();
    typeQuery('price');
    fireEvent.click(screen.getByRole('option', { name: '新しいディレクトリ「price」を作成' }));
    expect(screen.getByRole('button', { name: /^(Bypass permissions で)?起動$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '選択…、作成先' }));
    view.rerender(<ActionRoot onAction={(i) => out.push(i)}><NewSessionDialog {...base} workspaceRoot="" dirs={[]} picked={{ path: '/Users/me/src', n: 1 }} /></ActionRoot>);
    expect(screen.getByLabelText('作成先')).toHaveValue('/Users/me/src');
    expect(screen.getByText('/Users/me/src/price を作成し、プロジェクトに登録して起動します')).toBeInTheDocument();
    start();
    expect(out.filter((i) => i.type === 'session.new.submit')).toEqual([{ type: 'session.new.submit', params: {}, place: { kind: 'newDir', name: 'price', gitInit: true, parent: '/Users/me/src' } }]);
  });
  it('フォルダの名前の欄では、変換中の Enter で起動せず、Enter で起動する', () => {
    const { out } = collect();
    openList();
    typeQuery('price');
    fireEvent.click(screen.getByRole('option', { name: '新しいディレクトリ「price」を作成' }));
    const box = screen.getByLabelText('ディレクトリ名');
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    expect(out.filter((i) => i.type === 'session.new.submit')).toEqual([]);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(out.filter((i) => i.type === 'session.new.submit')).toHaveLength(1);
  });
  it('語が既存のプロジェクトか未登録のフォルダの名前と同じなら、作る操作はその名前にしない', () => {
    collect();
    openList();
    typeQuery('alpha');
    expect(screen.queryByRole('option', { name: '新しいディレクトリ「alpha」を作成' })).toBeNull();
    expect(screen.getByRole('option', { name: '新しいディレクトリを作成…' })).toBeInTheDocument();
    typeQuery('url-short');
    expect(screen.queryByRole('option', { name: '新しいディレクトリ「url-short」を作成' })).toBeNull();
  });
  it('アーカイブのプロジェクトのフォルダ名と、大文字小文字だけ違う名前にも、作る操作をその名前にしない', () => {
    collect({ takenNames: ['alpha', 'beta', 'old-kadai'] });
    openList();
    for (const q of ['old-kadai', 'Old-Kadai', 'ALPHA', 'URL-Short']) {
      typeQuery(q);
      expect(screen.queryByRole('option', { name: `「${q}」を作成` })).toBeNull();
      expect(screen.getByRole('option', { name: '新しいディレクトリを作成…' })).toBeInTheDocument();
    }
  });
  it('未登録のフォルダは語に一致したときだけ「未登録」の札付きで出て、選ぶと登録して始める', () => {
    const { out } = collect();
    openList();
    expect(screen.queryByRole('option', { name: 'url-short' })).toBeNull();
    typeQuery('url');
    fireEvent.click(screen.getByRole('option', { name: 'url-short' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('ディレクトリを登録して開始');
    expect(screen.getByText('/w/url-short はまだプロジェクトではありません。起動すると登録します')).toBeInTheDocument();
    start();
    expect(out.find((i) => i.type === 'session.new.submit')).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/w/url-short' } });
  });
  it('アーカイブのプロジェクトは語に一致したときだけ「Archived」の札付きで出て、ほかのプロジェクトの後、未登録のフォルダの前に並ぶ', () => {
    const { out } = collect({ projects: [...projects, { id: 'p3', name: 'urban', path: '/w/urban', status: 'done', lastActivity: '先月' }, { id: 'p9', name: 'url-old', path: '/w/old/url-old', status: 'archived', lastActivity: '半年前' }] });
    openList();
    expect(screen.queryByRole('option', { name: 'url-old' })).toBeNull();
    typeQuery('ur');
    expect(screen.getAllByRole('option').map((o) => o.textContent).slice(0, 3)).toEqual([expect.stringContaining('urban'), expect.stringContaining('url-old'), expect.stringContaining('url-short')]);
    expect(within(screen.getByRole('option', { name: 'url-old' })).getByText('Archived')).toBeInTheDocument();
    // 2 段目のパスでは当てない（未登録のフォルダと同じ）。
    typeQuery('/w/old');
    expect(screen.queryByRole('option', { name: 'url-old' })).toBeNull();
    typeQuery('url-old');
    fireEvent.click(screen.getByRole('option', { name: 'url-old' }));
    start();
    expect(out.find((i) => i.type === 'session.new.submit')).toMatchObject({ params: { projectId: 'p9' } });
  });
  it('「他の場所を選ぶ…」は殻の中だけで出て、押すと folder.pick を送る', () => {
    const { out, view } = collect();
    openList();
    fireEvent.click(screen.getByRole('option', { name: '他のディレクトリを選択…' }));
    expect(out).toContainEqual({ type: 'folder.pick' });
    view.unmount();
    collect({ desktop: false });
    openList();
    expect(screen.queryByRole('option', { name: '他のディレクトリを選択…' })).toBeNull();
  });
  it('「他の場所を選択…」に添える選び手の名前は、macOS は Finder、Windows はエクスプローラー', () => {
    const { view } = collect();
    openList();
    expect(screen.getByRole('option', { name: '他のディレクトリを選択…' })).toHaveTextContent('Finder');
    view.unmount();
    setClientUserAgent(WINDOWS_UA);
    collect();
    openList();
    const option = screen.getByRole('option', { name: '他のディレクトリを選択…' });
    expect(option).toHaveTextContent('エクスプローラー');
    expect(option).not.toHaveTextContent('Finder');
  });
  it('Finder で選んだプロジェクトの親フォルダの外のフォルダは、外である旨を添えて登録して始める', () => {
    const { out, view } = collect();
    view.rerender(<ActionRoot onAction={(i) => out.push(i)}><NewSessionDialog {...base} picked={{ path: '/Users/me/thesis', n: 1 }} /></ActionRoot>);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('ディレクトリを登録して開始');
    expect(chip('プロジェクト')).toHaveTextContent('thesis');
    expect(screen.getByText(/新しいディレクトリの作成先の外のディレクトリです。この PC でのパスだけを保存します/)).toBeInTheDocument();
    start();
    expect(out.find((i) => i.type === 'session.new.submit')).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/Users/me/thesis' } });
  });
  it('Finder で選んだのが未登録の一覧にあるフォルダなら、未登録のフォルダと同じ 1 行で登録して始める', () => {
    const { out, view } = collect();
    view.rerender(<ActionRoot onAction={(i) => out.push(i)}><NewSessionDialog {...base} picked={{ path: '/w/url-short', n: 1 }} /></ActionRoot>);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('ディレクトリを登録して開始');
    expect(screen.getByText('/w/url-short はまだプロジェクトではありません。起動すると登録します')).toBeInTheDocument();
    expect(screen.queryByText(/親ディレクトリの外のディレクトリです/)).toBeNull();
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
  it('Windows の親フォルダなら、新しいフォルダの場所を \\ でつないで見せ、送るのは名前だけ', () => {
    const { out } = collect({ workspaceRoot: 'C:\\Users\\me\\workspace' });
    openList();
    typeQuery('価格');
    const option = screen.getByRole('option', { name: '新しいディレクトリ「価格」を作成' });
    expect(option).toHaveTextContent('C:\\Users\\me\\workspace\\価格');
    fireEvent.click(option);
    expect(screen.getByText('C:\\Users\\me\\workspace\\価格 を作成し、プロジェクトに登録して起動します')).toBeInTheDocument();
    start();
    expect(out.filter((i) => i.type === 'session.new.submit')).toEqual([{ type: 'session.new.submit', params: {}, place: { kind: 'newDir', name: '価格', gitInit: true } }]);
  });
  it('親フォルダがまだ届いていないときの仮の場所は、Windows では \\ で書く', () => {
    setClientUserAgent(WINDOWS_UA);
    collect({ workspaceRoot: null });
    openList();
    typeQuery('price');
    fireEvent.click(screen.getByRole('option', { name: '新しいディレクトリ「price」を作成' }));
    expect(screen.getByText('~\\workspace\\price を作成し、プロジェクトに登録して起動します')).toBeInTheDocument();
  });
  it('エクスプローラーで選んだ Windows のフォルダは、最後の名前を札にし、パスはそのまま送る', () => {
    const { out, view } = collect({ workspaceRoot: 'C:\\Users\\me\\workspace' });
    view.rerender(<ActionRoot onAction={(i) => out.push(i)}><NewSessionDialog {...base} workspaceRoot="C:\\Users\\me\\workspace" picked={{ path: 'C:\\Users\\me\\論文', n: 1 }} /></ActionRoot>);
    expect(chip('プロジェクト')).toHaveTextContent('論文');
    expect(chip('プロジェクト')).not.toHaveTextContent('C:');
    start();
    expect(out.find((i) => i.type === 'session.new.submit')).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: 'C:\\Users\\me\\論文' } });
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
    fireEvent.click(screen.getByRole('option', { name: '新しいディレクトリ「price」を作成' }));
    view.rerender(<ActionRoot onAction={(i) => out.push(i)}><NewSessionDialog {...base} projects={projectsWithNew} error="tmux が未検出" createdProjectId="p9" /></ActionRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('price');
    expect(screen.getByRole('alert')).toHaveTextContent('tmux が未検出');
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
    expect(within(group()).getAllByRole('button').map((b) => b.getAttribute('aria-label')).slice(0, 3)).toEqual(['プロジェクト', 'アカウント、会社', 'モデル、デフォルト']);
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

// 0.6.1：登録済みのプロジェクトの下のフォルダと、他の PC から届いた同じプロジェクト（試作の 6 と 7 の A）。
describe('NewSessionDialog の選んだフォルダとプロジェクトの結び付き', () => {
  const ui = '/w/alpha/packages/ui';
  type Inspect = NonNullable<NewSessionProps['inspect']>;
  const ready = (path: string, over: Partial<Extract<Inspect, { status: 'ready' }>['data']>): Inspect => ({ path, name: null, status: 'ready', data: { path, git: false, worktree: false, remote: null, registered: null, enclosing: null, link: null, ...over } });
  const nested = ready(ui, { enclosing: { projectId: 'p1', name: 'alpha', path: '/w/alpha', relative: 'packages/ui' } });
  const note = () => document.querySelector('.dir-note');
  /** Finder で選んだ結果を渡し、問い合わせの答えを重ねて描き直す。 */
  function pickWith(path: string, inspect: Inspect | null, over: Partial<NewSessionProps> = {}) {
    const { out, view } = collect(over);
    const again = (i: Inspect | null) => view.rerender(<ActionRoot onAction={(a) => out.push(a)}><NewSessionDialog {...base} {...over} picked={{ path, n: 1 }} inspect={i} /></ActionRoot>);
    again(null);
    if (inspect) again(inspect);
    return { out, again };
  }
  const submits = (out: UiAction[]) => out.filter((i) => i.type === 'session.new.submit');

  it('フォルダを選ぶと、そのフォルダの事前の問い合わせを頼む', () => {
    const { out } = pickWith(ui, null);
    expect(out).toContainEqual({ type: 'folder.inspect', path: ui });
  });
  it('登録済みのプロジェクトの下なら、札を包むプロジェクトにして下のフォルダを添え、その場の 1 行で言う。起動は包むプロジェクトの cwd で', () => {
    const { out } = pickWith(ui, nested);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('新しいセッション');
    expect(chip('プロジェクト')).toHaveTextContent('alpha');
    expect(chip('プロジェクト')).toHaveTextContent('packages/ui');
    expect(note()).toHaveTextContent('alpha の中のディレクトリのため、alpha のセッションとして packages/ui で開始します。');
    expect(screen.queryByText(/はまだプロジェクトではありません/)).toBeNull();
    start();
    expect(submits(out)).toEqual([{ type: 'session.new.submit', params: { projectId: 'p1', cwd: ui } }]);
  });
  it('「別のプロジェクトにする」を押すと、分けて登録する旨を言い、allowNested を付けて登録してから始める。戻すこともできる', () => {
    const { out } = pickWith(ui, nested);
    fireEvent.click(screen.getByRole('button', { name: '別のプロジェクトにする' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('ディレクトリを登録して開始');
    expect(chip('プロジェクト')).toHaveTextContent('ui');
    expect(chip('プロジェクト')).not.toHaveTextContent('alpha');
    expect(note()).toHaveTextContent('alpha から分けて、別のプロジェクトとして登録します。既存の会話は alpha に残り、以降の会話が分かれます。');
    start();
    expect(submits(out).at(-1)).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: ui, allowNested: true } });
    fireEvent.click(screen.getByRole('button', { name: 'alpha のセッションにする' }));
    start();
    expect(submits(out).at(-1)).toEqual({ type: 'session.new.submit', params: { projectId: 'p1', cwd: ui } });
  });
  it('包むプロジェクトの前回値を札の値にする', () => {
    pickWith(ui, nested, { prefs: { p1: { model: 'opus' } } });
    expect(chip('モデル、opus')).toBeInTheDocument();
  });
  it('他の PC から届いた同じリポジトリのプロジェクトがあれば、札に「他の PC」を添え、理由と行き先を 1 行で言い、結び付けて始める', () => {
    const link = ready('/w/notes-app', { link: { projectId: 'p7', name: 'notes-app', match: 'remote', remote: 'github.com/me/notes-app', deviceName: 'work-pc', previousPath: 'D:\\src\\notes-app' } });
    const { out } = pickWith('/w/notes-app', link, { dirs: [{ name: 'notes-app', path: '/w/notes-app' }] });
    expect(screen.getByRole('dialog')).toHaveAccessibleName('新しいセッション');
    expect(chip('プロジェクト')).toHaveTextContent('notes-app');
    expect(chip('プロジェクト')).toHaveTextContent('他の PC');
    expect(note()).toHaveTextContent('work-pc の notes-app と同じリポジトリです。この PC のパス（/w/notes-app）に関連付けて開始します。');
    start();
    expect(submits(out).at(-1)).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/w/notes-app', linkTo: 'p7' } });
    fireEvent.click(screen.getByRole('button', { name: '新規作成' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('ディレクトリを登録して開始');
    expect(note()).toHaveTextContent('work-pc の notes-app には関連付けず、新しいプロジェクトとして登録します。');
    start();
    expect(submits(out).at(-1)).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/w/notes-app' } });
    fireEvent.click(screen.getByRole('button', { name: 'notes-app に関連付ける' }));
    start();
    expect(submits(out).at(-1)).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/w/notes-app', linkTo: 'p7' } });
  });
  it('名前だけが同じときは「同じ名前です」と言う。場所を持つ PC が分からなければ名前だけで言い、札に「他の PC」を添えない', () => {
    pickWith('/w/notes', ready('/w/notes', { link: { projectId: 'p7', name: 'notes', match: 'name', remote: null, deviceName: null, previousPath: null } }));
    expect(note()).toHaveTextContent('notes と同じ名前です。この PC のパス（/w/notes）に関連付けて開始します。');
    expect(chip('プロジェクト')).not.toHaveTextContent('他の PC');
  });
  it('問い合わせの答えを待つ間は起動できない。読めなかったら今までどおり登録して始める', () => {
    const { out, again } = pickWith('/Users/me/thesis', { path: '/Users/me/thesis', name: null, status: 'loading' });
    expect(screen.getByRole('button', { name: /起動$/ })).toBeDisabled();
    again({ path: '/Users/me/thesis', name: null, status: 'failed' });
    start();
    expect(submits(out)).toEqual([{ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/Users/me/thesis' } }]);
  });
  it('他のフォルダの答えは使わない', () => {
    const { out } = pickWith('/Users/me/thesis', nested);
    expect(note()).toBeNull();
    start();
    expect(submits(out)).toEqual([{ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/Users/me/thesis' } }]);
  });
  it('登録済みのフォルダだったら（綴りが違っても）、そのプロジェクトを選ぶ', () => {
    const { out } = pickWith('/w/beta/', ready('/w/beta/', { registered: { projectId: 'p2', name: 'beta' } }));
    expect(chip('プロジェクト')).toHaveTextContent('beta');
    start();
    expect(submits(out)).toEqual([{ type: 'session.new.submit', params: { projectId: 'p2' } }]);
  });
  it('作成のダイアログから渡されたフォルダを選んで開き、問い合わせを頼む', () => {
    const { out } = collect({ projectId: 'p1', dir: ui, inspect: nested });
    expect(out).toContainEqual({ type: 'folder.inspect', path: ui });
    expect(chip('プロジェクト')).toHaveTextContent('packages/ui');
    start();
    expect(submits(out)).toEqual([{ type: 'session.new.submit', params: { projectId: 'p1', cwd: ui } }]);
  });
});

describe('NewSessionDialog のエージェント（opencode、ベータ）', () => {
  const OPTIONS = {
    version: '2.1.4', verified: true,
    modes: [{ id: 'build', description: 'The default agent.' }, { id: 'plan', description: 'Plan mode.' }],
    models: [
      { id: 'opencode/glm-5.3-flash-free', label: 'GLM-5.3-Flash Free', group: 'OpenCode', provider: 'opencode', tools: true, context: 200_000, cost: { input: 0, output: 0 } },
      { id: 'lmstudio/qwen/qwen3-coder-30b', label: 'Qwen3 Coder 30B', group: 'LM Studio (local)', provider: 'lmstudio', tools: true, context: 262_144, cost: null },
    ],
    providers: [{ id: 'opencode', name: 'OpenCode', where: 'remote' as const }, { id: 'lmstudio', name: 'LM Studio (local)', where: 'device' as const }],
    defaultModel: 'lmstudio/qwen/qwen3-coder-30b', pricesAt: null, fetchedAt: 1, stale: false,
  };
  const ready = (dir: string | null = '/w/alpha') => ({ options: { dir, status: 'ready' as const, data: OPTIONS } });
  function collect(over: Partial<NewSessionProps> = {}) {
    const actions: UiAction[] = [];
    const ui = (p: Partial<NewSessionProps>) => <ActionRoot onAction={(i) => { actions.push(i); }}><NewSessionDialog {...base} {...p} /></ActionRoot>;
    const view = render(ui(over));
    return {
      actions,
      params: () => actions.flatMap((i) => (i.type === 'session.new.submit' ? [i.params] : [])),
      asked: () => actions.flatMap((i) => (i.type === 'opencode.options' ? [i.dir] : [])),
      rerender: (p: Partial<NewSessionProps>) => view.rerender(ui({ ...over, ...p })),
    };
  }
  const names = () => within(group()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.getAttribute('title'));
  /** エージェントの札から opencode を選ぶ。消える札が薄れ終わってから入れ替わる。 */
  const toOpencode = async () => {
    fireEvent.click(chip('エージェント、Claude Code'));
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: /opencode/ })); });
    await screen.findByRole('button', { name: 'エージェント、opencode' });
  };

  it('設定で有効にしていなければ、エージェントの札を出さず、札も起動の本文も今のまま', () => {
    const { params, asked } = collect({ projectId: 'p1' });
    expect(names()).toEqual(['プロジェクト', 'モデル、デフォルト', 'effort レベル、デフォルト', '権限モード、デフォルト', 'worktree、なし', '設定を追加']);
    expect(screen.getByText(/信頼の確認ダイアログ/)).toBeInTheDocument();
    start();
    expect(params()).toEqual([{ projectId: 'p1' }]);
    expect(asked()).toEqual([]);
  });
  it('有効なら札の先頭にエージェント（Claude Code）を出し、Claude の札と信頼の注記はそのまま。opencode の一覧は読まない', () => {
    const { params, asked } = collect({ projectId: 'p1', opencode: { options: null } });
    expect(names()).toEqual(['エージェント、Claude Code', 'プロジェクト', 'モデル、デフォルト', 'effort レベル、デフォルト', '権限モード、デフォルト', 'worktree、なし', '設定を追加']);
    expect(screen.getByText(/信頼の確認ダイアログ/)).toBeInTheDocument();
    start();
    expect(params()).toEqual([{ projectId: 'p1' }]);
    expect(asked()).toEqual([]);
  });
  it('エージェントの一覧は Claude Code と opencode で、opencode に「ベータ」と版の確かめを添える', () => {
    collect({ projectId: 'p1', opencode: ready() });
    fireEvent.click(chip('エージェント、Claude Code'));
    const list = screen.getByRole('listbox', { name: 'エージェント' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['Claude Code', 'opencodeベータopencode 2.1.4 · 検証済み']);
  });
  it('opencode を選ぶと、アカウント・モデル・effort・権限モード・worktree の札と信頼の注記を外し、モード・モデル・自動承認を出す。選んだ場所の一覧を読む', async () => {
    const { asked } = collect({ projectId: 'p1', opencode: ready(), accounts: null });
    await toOpencode();
    expect(names()).toEqual(['エージェント、opencode', 'プロジェクト', 'モード、build', 'モデル', '自動承認、オフ', '設定を追加']);
    expect(chip('エージェント、opencode')).toHaveTextContent('ベータ');
    expect(screen.queryByText(/信頼の確認ダイアログ/)).toBeNull();
    expect(asked()).toEqual(['/w/alpha']);
    // 「＋」から足せるのは名前だけ（追加ディレクトリは Claude Code だけのもの）。
    fireEvent.click(chip('設定を追加'));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['名前']);
  });
  it('モードは primary の一覧から、自動承認はオフとオン（--auto）から選び、説明を添える', async () => {
    collect({ projectId: 'p1', opencode: ready() });
    await toOpencode();
    fireEvent.click(chip('モード、build'));
    expect(within(screen.getByRole('listbox', { name: 'モード' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['buildThe default agent.', 'planPlan mode.']);
    fireEvent.click(screen.getByRole('option', { name: /^plan/ }));
    expect(chip('モード、plan')).toBeInTheDocument();
    fireEvent.click(chip('自動承認、オフ'));
    expect(within(screen.getByRole('listbox', { name: '自動承認' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['オフask のツールは実行前に確認', 'オン（--auto）deny 以外をすべて許可']);
    fireEvent.click(screen.getByRole('option', { name: /^オン/ }));
    expect(chip('自動承認、オン（--auto）')).toHaveAttribute('data-tone', 'danger');
  });
  it('モデルはデフォルトとプロバイダーごとのまとまり（ローカル、無料の順）で並べ、デフォルトには opencode.json のモデルを添える', async () => {
    collect({ projectId: 'p1', opencode: ready() });
    await toOpencode();
    expect(chip('モデル')).toHaveTextContent('デフォルト');
    fireEvent.click(chip('モデル'));
    const list = screen.getByRole('listbox', { name: 'モデル' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('デフォルト'), expect.stringContaining('Qwen3 Coder 30B'), expect.stringContaining('GLM-5.3-Flash Free'),
    ]);
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent('lmstudio/qwen/qwen3-coder-30b');
    expect(screen.getByText('opencode.json のデフォルト')).toBeInTheDocument();
    expect(screen.getByText('LM Studio（1）')).toBeInTheDocument();
    expect(screen.getByText('OpenCode Zen（1）')).toBeInTheDocument();
  });
  it('モデルの小窓の再読み込みは、同じ場所の一覧の取り直しを頼み、「プロバイダーを管理…」は閉じて設定の opencode の面へ移る', async () => {
    const { actions } = collect({ projectId: 'p1', opencode: ready() });
    await toOpencode();
    fireEvent.click(chip('モデル'));
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));
    expect(actions).toContainEqual({ type: 'opencode.options', dir: '/w/alpha', refresh: true });
    fireEvent.click(screen.getByRole('button', { name: 'プロバイダーを管理…' }));
    // 閉じて移るのと、設定に「‹ 新しいセッションに戻る」を出すための戻り先を覚えるのは Mediator が行う（mediator/opencodeReturn.test.ts）。
    expect(actions.at(-1)).toEqual({ type: 'opencode.providers.manage' });
  });
  it('起動の本文に agent・mode・model・autoApprove を載せ、Claude だけの値は載せない', async () => {
    const { params } = collect({ projectId: 'p1', opencode: ready(), prefs: { p1: { model: 'opus', effort: 'high', permissionMode: 'plan', addDirs: ['/a'] } }, accounts: null });
    await toOpencode();
    fireEvent.click(chip('モード、build'));
    fireEvent.click(screen.getByRole('option', { name: /^plan/ }));
    pick('モデル', /GLM-5.3-Flash Free/);
    fireEvent.click(chip('自動承認、オフ'));
    fireEvent.click(screen.getByRole('option', { name: /^オン/ }));
    fireEvent.change(prompt(), { target: { value: 'やって' } });
    start();
    expect(params()).toEqual([{ projectId: 'p1', prompt: 'やって', agent: 'opencode', mode: 'plan', model: 'opencode/glm-5.3-flash-free', autoApprove: true, prepKey: expect.any(String) }]);
  });
  it('既定のままの opencode では、モデルを載せず、自動承認はオフで載せる', async () => {
    const { params } = collect({ projectId: 'p1', opencode: ready() });
    await toOpencode();
    start();
    expect(params()).toEqual([{ projectId: 'p1', agent: 'opencode', mode: 'build', autoApprove: false, prepKey: expect.any(String) }]);
  });
  it('一覧が届く前は、モードを載せない（opencode の既定に任せる）。届かなければ札の下で言う', async () => {
    const view = collect({ projectId: 'p1', opencode: { options: { dir: '/w/alpha', status: 'loading', data: null } } });
    await toOpencode();
    expect(screen.getByText('opencode から一覧を取得しています…')).toBeInTheDocument();
    start();
    expect(view.params()[0]).toEqual({ projectId: 'p1', agent: 'opencode', autoApprove: false, prepKey: expect.any(String) });
    view.rerender({ opencode: { options: { dir: '/w/alpha', status: 'failed', data: null } } });
    expect(screen.getByText('opencode から一覧を取得できませんでした。')).toBeInTheDocument();
  });
  it('ほかの場所の一覧は使わない', async () => {
    collect({ projectId: 'p1', opencode: ready('/w/beta') });
    await toOpencode();
    fireEvent.click(chip('モデル'));
    expect(within(screen.getByRole('listbox', { name: 'モデル' })).getAllByRole('option')).toHaveLength(1);
  });
  it('前回 opencode で起動したプロジェクトは、opencode と前回のモデルで開く', () => {
    const { params, asked } = collect({ projectId: 'p1', opencode: ready(), prefs: { p1: { agent: 'opencode', opencodeModel: 'opencode/glm-5.3-flash-free' } } });
    expect(names()[0]).toBe('エージェント、opencode');
    expect(chip('モデル')).toHaveTextContent('GLM-5.3-Flash Free');
    expect(asked()).toEqual(['/w/alpha']);
    start();
    expect(params()[0]).toMatchObject({ agent: 'opencode', model: 'opencode/glm-5.3-flash-free' });
  });
  it('前回のモデルが一覧から消えていたら、デフォルトに戻して起動する（戻したことは札が持つ）', () => {
    const { params } = collect({ projectId: 'p1', opencode: ready(), prefs: { p1: { agent: 'opencode', opencodeModel: 'opencode/gone-free' } } });
    expect(chip('モデル')).toHaveTextContent('デフォルト');
    expect(chip('モデル')).toHaveAttribute('data-reset', 'true');
    start();
    expect(params()[0]).not.toHaveProperty('model');
  });
  const RESET_NOTE = '前回の opencode/gone-free は一覧にないため、デフォルトに戻しました。';
  const resetNote = () => screen.queryByText(RESET_NOTE)?.closest<HTMLElement>('.oc-model-note') ?? null;
  it('前回のモデルが一覧から消えていたら、札の列の下に 1 行の注記で言う（試作の M1）', () => {
    collect({ projectId: 'p1', opencode: ready(), prefs: { p1: { agent: 'opencode', opencodeModel: 'opencode/gone-free' } } });
    const note = resetNote()!;
    expect(note).not.toBeNull();
    expect(group().compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.querySelector('[data-icon="info"]')).not.toBeNull();
  });
  it('前回のモデルが一覧にあれば、注記は出さない', () => {
    collect({ projectId: 'p1', opencode: ready(), prefs: { p1: { agent: 'opencode', opencodeModel: 'opencode/glm-5.3-flash-free' } } });
    expect(document.querySelector('.oc-model-note')).toBeNull();
  });
  it('注記は ✕ で消える。起動にはデフォルトのまま載せない', () => {
    const { params } = collect({ projectId: 'p1', opencode: ready(), prefs: { p1: { agent: 'opencode', opencodeModel: 'opencode/gone-free' } } });
    fireEvent.click(within(resetNote()!).getByRole('button', { name: '閉じる' }));
    expect(resetNote()).toBeNull();
    start();
    expect(params()[0]).not.toHaveProperty('model');
  });
  it('モデルを選び直すと、注記は消える', () => {
    collect({ projectId: 'p1', opencode: ready(), prefs: { p1: { agent: 'opencode', opencodeModel: 'opencode/gone-free' } } });
    fireEvent.click(chip('モデル'));
    fireEvent.click(within(screen.getByRole('listbox', { name: 'モデル' })).getByRole('option', { name: /GLM-5.3-Flash Free/ }));
    expect(resetNote()).toBeNull();
    expect(chip('モデル')).not.toHaveAttribute('data-reset');
  });
  describe('注記の出入りの動き', () => {
    let restore: (() => void) | null = null;
    let animations: { el: Element; frames: Keyframe[]; resolve: () => void }[] = [];
    beforeEach(() => {
      restore = fakeMotionTokens(undefined, { everywhere: true });
      animations = [];
      (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = () => [];
      (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
        let resolve!: () => void;
        const finished = new Promise<void>((r) => { resolve = r; });
        animations.push({ el: this, frames, resolve });
        return { finished, cancel: vi.fn() };
      };
    });
    afterEach(() => {
      restore?.(); restore = null;
      delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
      delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
    });
    it('高さを 0 から伸ばして入り（growIn）、✕ で高さを畳んでから外れる（collapseOut）', async () => {
      collect({ projectId: 'p1', opencode: ready(), prefs: { p1: { agent: 'opencode', opencodeModel: 'opencode/gone-free' } } });
      const note = resetNote()!;
      expect(animations.filter((a) => a.el === note).map((a) => a.frames[0])).toEqual([expect.objectContaining({ height: '0px', opacity: 0 })]);
      fireEvent.click(within(note).getByRole('button', { name: '閉じる' }));
      const out = animations.filter((a) => a.el === note).at(-1)!;
      expect(out.frames.at(-1)).toMatchObject({ height: '0px', opacity: 0 });
      // 畳み終わるまでは前の中身のまま残り、読み上げからは外す。
      expect(resetNote()).toBe(note);
      expect(note).toHaveAttribute('aria-hidden', 'true');
      await act(async () => { out.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(resetNote()).toBeNull();
    });
  });
  it('前回 opencode でも、設定で無効にしたら Claude Code で開く', () => {
    const { params } = collect({ projectId: 'p1', prefs: { p1: { agent: 'opencode', opencodeModel: 'opencode/glm-5.3-flash-free', effort: 'high' } } });
    expect(names()[0]).toBe('プロジェクト');
    start();
    expect(params()).toEqual([{ projectId: 'p1', effort: 'high' }]);
  });
  it('札に触れる前にプロジェクトを選び直すと、そのプロジェクトの前回のエージェントにする', () => {
    collect({ projectId: 'p1', opencode: ready(), prefs: { p2: { agent: 'opencode' } } });
    expect(names()[0]).toBe('エージェント、Claude Code');
    pick('プロジェクト', 'beta');
    expect(names()[0]).toBe('エージェント、opencode');
  });
  it('opencode から Claude Code に戻すと、Claude の札と信頼の注記が戻る', async () => {
    collect({ projectId: 'p1', opencode: ready(), prefs: { p1: { agent: 'opencode' } } });
    fireEvent.click(chip('エージェント、opencode'));
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Claude Code' })); });
    await screen.findByRole('button', { name: 'エージェント、Claude Code' });
    expect(names()).toEqual(['エージェント、Claude Code', 'プロジェクト', 'モデル、デフォルト', 'effort レベル、デフォルト', '権限モード、デフォルト', 'worktree、なし', '設定を追加']);
    expect(screen.getByText(/信頼の確認ダイアログ/)).toBeInTheDocument();
  });
});

describe('NewSessionDialog の起動前の準備（opencode のローカルのモデル）', () => {
  const OPTIONS = {
    version: '2.1.4', verified: true,
    modes: [{ id: 'build', description: 'The default agent.' }],
    models: [{ id: 'lmstudio/qwen3.8-27b', label: 'Qwen3.8 27B', group: 'LM Studio (local)', provider: 'lmstudio', tools: true, context: 262_144, cost: null }],
    providers: [{ id: 'lmstudio', name: 'LM Studio (local)', where: 'device' as const }],
    defaultModel: 'lmstudio/qwen3.8-27b', pricesAt: null, fetchedAt: 1, stale: false,
  };
  const ocProps: Partial<NewSessionProps> = { projectId: 'p1', opencode: { options: { dir: '/w/alpha', status: 'ready' as const, data: OPTIONS } }, prefs: { p1: { agent: 'opencode', opencodeModel: 'lmstudio/qwen3.8-27b' } } };
  const prepView = (over: Partial<LaunchPrepView> = {}): LaunchPrepView => ({ key: 'key-12345678', phase: 'running', startedAt: Date.now() - 9_000, line: { text: 'qwen3.8-27b をロード中…（64K）', bar: true }, done: [{ id: '1', text: 'old をアンロードしました' }], ask: null, failure: null, failureTitle: 'モデルのロードに失敗しました', ...over });
  const mount = (over: Partial<NewSessionProps> = {}) => {
    const actions: UiAction[] = [];
    const ui = (p: Partial<NewSessionProps>) => <ActionRoot onAction={(i) => { actions.push(i); }}><NewSessionDialog {...base} {...ocProps} {...p} /></ActionRoot>;
    const view = render(ui(over));
    return { actions, submits: () => actions.flatMap((i) => (i.type === 'session.new.submit' ? [i] : [])), rerender: (p: Partial<NewSessionProps>) => view.rerender(ui({ ...over, ...p })) };
  };
  const box = () => document.querySelector<HTMLElement>('.launch-prep');
  const startButton = () => screen.getByRole('button', { name: /^(起動|準備中…)/ });

  it('opencode の起動には、送るたびに新しい準備の鍵（8〜64 字の英数と _-）を添える', () => {
    const { submits } = mount();
    fireEvent.click(startButton());
    fireEvent.click(startButton());
    const keys = submits().map((i) => i.params.prepKey);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(keys[1]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(keys[0]).not.toBe(keys[1]);
    expect(submits()[0]!.params).toMatchObject({ projectId: 'p1', agent: 'opencode', model: 'lmstudio/qwen3.8-27b' });
  });
  it('Claude Code の起動は、準備の鍵を持たない', () => {
    const out = collectParams({ projectId: 'p1', prefs: {} });
    start();
    expect(out[0]).not.toHaveProperty('prepKey');
  });

  it('準備の進みが無ければ、今までどおり送信中の「起動中…」だけで、箱は出さない', () => {
    mount({ submitting: true, prep: null });
    expect(box()).toBeNull();
    expect(screen.getByRole('button', { name: '起動中…' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '準備を中止' })).toBeNull();
  });
  it('進みの間は、箱に今の段の 1 行と経過時間と済んだ段を出し、始めるボタンを「準備中…」にして、左に「準備を中止」を置く', () => {
    const { actions } = mount({ submitting: true, prep: prepView() });
    expect(box()).not.toBeNull();
    expect(within(box()!).getByText('qwen3.8-27b をロード中…（64K）')).toBeInTheDocument();
    expect(within(box()!).getByText(/^0:0\d$/)).toBeInTheDocument();
    expect(within(box()!).getByText('old をアンロードしました')).toBeInTheDocument();
    expect(box()!.querySelector('[role="progressbar"]')).not.toBeNull();
    const go = screen.getByRole('button', { name: '準備中…' });
    expect(go).toBeDisabled();
    const cancel = screen.getByRole('button', { name: '準備を中止' });
    expect(cancel.compareDocumentPosition(go) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(cancel);
    expect(actions).toContainEqual({ type: 'launchPrep.cancel', key: 'key-12345678' });
  });
  it('帯は load と reload の間だけ。確かめや起動中の行には出さない', () => {
    mount({ submitting: true, prep: prepView({ line: { text: 'opencode を起動中…', bar: false } }) });
    expect(box()!.querySelector('[role="progressbar"]')).toBeNull();
  });
  it('経過時間は 1 秒ごとに進む', () => {
    vi.useFakeTimers({ now: 100_000 });
    try {
      mount({ submitting: true, prep: prepView({ startedAt: 100_000 }) });
      expect(within(box()!).getByText('0:00')).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(3_000); });
      expect(within(box()!).getByText('0:03')).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
  it('準備が済んだあとの送信中（opencode を起動中…）は、準備中…を出さずに起動中…にする', () => {
    mount({ submitting: true, prep: prepView({ phase: 'ready' }) });
    expect(screen.getByRole('button', { name: '起動中…' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '準備を中止' })).toBeNull();
  });

  const unloadAsk: LaunchPrepView['ask'] = { title: 'gemma-4-26b をアンロードしてロードしますか？', body: 'LM Studio で手動ロードされた gemma-4-26b が残っています。', hint: null, choices: [{ id: 'unload', label: 'アンロードしてロード', choice: { unload: ['i1'] }, primary: true }, { id: 'skip', label: 'そのまま開始', choice: { skip: true }, primary: false }] };
  it('問いが来たら、ダイアログの中に札を出す（見出し、本文、答えのボタン）', () => {
    mount({ prep: prepView({ phase: 'asking', ask: unloadAsk }) });
    const card = screen.getByRole('group', { name: 'gemma-4-26b をアンロードしてロードしますか？' });
    expect(within(card).getByText(/手動ロードされた gemma-4-26b/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'アンロードしてロード' })).toBeInTheDocument();
    expect(box()).toBeNull();
  });
  it('問いの補足があれば添える', () => {
    mount({ prep: prepView({ phase: 'asking', ask: { ...unloadAsk, hint: 'サブエージェントにも同じモデルを指定すると、メモリに収まります。' } }) });
    expect(screen.getByText('サブエージェントにも同じモデルを指定すると、メモリに収まります。')).toBeInTheDocument();
  });
  it('答えを選ぶと、同じ詳細に prepChoice を足し、新しい鍵で送り直す', () => {
    const { submits } = mount({ prep: prepView({ phase: 'asking', ask: unloadAsk }) });
    fireEvent.click(screen.getByRole('button', { name: 'アンロードしてロード' }));
    fireEvent.click(screen.getByRole('button', { name: 'そのまま開始' }));
    const [a, b] = submits();
    expect(a!.params).toMatchObject({ projectId: 'p1', agent: 'opencode', model: 'lmstudio/qwen3.8-27b', prepChoice: { unload: ['i1'] } });
    expect(b!.params).toMatchObject({ prepChoice: { skip: true } });
    expect(a!.params.prepKey).not.toBe(b!.params.prepKey);
    expect(a!.params.prepKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
  it('送信中は問いの札を出さない', () => {
    mount({ submitting: true, prep: prepView({ phase: 'asking', ask: unloadAsk }) });
    expect(screen.queryByRole('group', { name: unloadAsk!.title })).toBeNull();
  });

  it('失敗したら、箱を閉じ、ダイアログの中に失敗の札（見出しと理由）を出す。同じ理由の赤い 1 行は重ねない', () => {
    mount({ error: 'LM Studio が「メモリが足りません」と返しました。', prep: prepView({ phase: 'failed', failure: 'LM Studio が「メモリが足りません」と返しました。' }) });
    const card = screen.getByRole('alert');
    expect(within(card).getByText('モデルのロードに失敗しました')).toBeInTheDocument();
    expect(within(card).getByText('LM Studio が「メモリが足りません」と返しました。')).toBeInTheDocument();
    expect(screen.getAllByText('LM Studio が「メモリが足りません」と返しました。')).toHaveLength(1);
    expect(box()).toBeNull();
  });
  it('理由が空なら、起動の失敗の文を理由にする。準備の失敗でない失敗は今までの赤い 1 行', () => {
    const { rerender } = mount({ error: 'tmux が未検出', prep: prepView({ phase: 'failed', failure: '' }) });
    expect(within(screen.getByRole('alert')).getByText('tmux が未検出')).toBeInTheDocument();
    rerender({ error: 'tmux が未検出', prep: prepView({ phase: 'ready' }) });
    expect(screen.queryByText('モデルのロードに失敗しました')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('tmux が未検出');
  });

  describe('出入りの動き', () => {
    let restore: (() => void) | null = null;
    let animations: { el: Element; frames: Keyframe[]; resolve: () => void }[] = [];
    beforeEach(() => {
      restore = fakeMotionTokens(undefined, { everywhere: true });
      animations = [];
      (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = () => [];
      (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
        let resolve!: () => void;
        const finished = new Promise<void>((r) => { resolve = r; });
        animations.push({ el: this, frames, resolve });
        return { finished, cancel: vi.fn() };
      };
    });
    afterEach(() => {
      restore?.(); restore = null;
      delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
      delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
    });
    it('進みの箱は高さを 0 から伸ばして入り（growIn）、準備が済んだら畳んでから外れる（collapseOut）', async () => {
      const { rerender } = mount({ submitting: false, prep: null });
      rerender({ submitting: true, prep: prepView() });
      const el = box()!;
      expect(animations.filter((a) => a.el === el).map((a) => a.frames[0])).toEqual([expect.objectContaining({ height: '0px', opacity: 0 })]);
      rerender({ submitting: false, prep: prepView({ phase: 'failed', failure: 'x' }), error: 'x' });
      const out = animations.filter((a) => a.el === el).at(-1)!;
      expect(out.frames.at(-1)).toMatchObject({ height: '0px', opacity: 0 });
      expect(box()).toBe(el);
      await act(async () => { out.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(box()).toBeNull();
    });
    it('問いの札と失敗の札も、伸びて入る', () => {
      const { rerender } = mount({ prep: null });
      rerender({ prep: prepView({ phase: 'asking', ask: unloadAsk }) });
      const ask = screen.getByRole('group', { name: unloadAsk!.title });
      expect(animations.filter((a) => a.el === ask).map((a) => a.frames[0])).toEqual([expect.objectContaining({ height: '0px', opacity: 0 })]);
      rerender({ prep: prepView({ phase: 'failed', failure: 'x' }), error: 'x' });
      const fail = screen.getByRole('alert');
      expect(animations.filter((a) => a.el === fail).map((a) => a.frames[0])).toEqual([expect.objectContaining({ height: '0px', opacity: 0 })]);
    });
  });
});

describe('NewSessionDialog のエージェント（Codex、ベータ）', () => {
  const eff = (...ids: string[]) => ids.map((id) => ({ id, description: `${id} の説明` }));
  const OPTIONS: CodexOptionsDto = {
    version: '0.164.0', verified: true, fetchedAt: 1,
    models: [
      { id: 'gpt-full', label: 'GPT Full', description: '何でも向き', efforts: eff('low', 'medium', 'high', 'ultra'), defaultEffort: 'low' },
      { id: 'gpt-nomedium', label: 'GPT NoMedium', description: '軽い', efforts: eff('low', 'high'), defaultEffort: 'high' },
    ],
  };
  const ready = (data: CodexOptionsDto | null = OPTIONS) => ({ options: { status: 'ready' as const, data } });
  function collect(over: Partial<NewSessionProps> = {}) {
    const actions: UiAction[] = [];
    const ui = (p: Partial<NewSessionProps>) => <ActionRoot onAction={(i) => { actions.push(i); }}><NewSessionDialog {...base} {...p} /></ActionRoot>;
    const view = render(ui(over));
    return {
      actions,
      params: () => actions.flatMap((i) => (i.type === 'session.new.submit' ? [i.params] : [])),
      asked: () => actions.filter((i) => i.type === 'codex.options').length,
      rerender: (p: Partial<NewSessionProps>) => view.rerender(ui({ ...over, ...p })),
    };
  }
  const names = () => within(group()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.getAttribute('title'));
  const toCodex = async () => {
    fireEvent.click(chip('エージェント、Claude Code'));
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: /Codex/ })); });
    await screen.findByRole('button', { name: 'エージェント、Codex' });
  };

  it('設定で有効にしていなければ、Codex は札の一覧に出ない（opencode だけ有効なら Claude Code と opencode）', () => {
    collect({ projectId: 'p1', opencode: { options: null } });
    fireEvent.click(chip('エージェント、Claude Code'));
    expect(within(screen.getByRole('listbox', { name: 'エージェント' })).getAllByRole('option').map((o) => o.textContent?.replace(/ベータ.*/, ''))).toEqual(['Claude Code', 'opencode']);
  });
  it('有効にしても、Codex を選ぶまでは一覧を読まず、札も今のまま', () => {
    const { asked } = collect({ projectId: 'p1', codex: { options: null } });
    expect(names()).toEqual(['エージェント、Claude Code', 'プロジェクト', 'モデル、デフォルト', 'effort レベル、デフォルト', '権限モード、デフォルト', 'worktree、なし', '設定を追加']);
    expect(asked()).toBe(0);
  });
  it('エージェントの一覧は、Codex に「ベータ」と版の確かめを添える。opencode も有効なら Codex が先に並ぶ', () => {
    collect({ projectId: 'p1', codex: ready(), opencode: { options: null } });
    fireEvent.click(chip('エージェント、Claude Code'));
    expect(within(screen.getByRole('listbox', { name: 'エージェント' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['Claude Code', 'Codexベータcodex 0.164.0 · 検証済み', 'opencodeベータ']);
  });
  it('エージェントの札と一覧の Codex の行に、Codex の絵（svg）が出る', async () => {
    collect({ projectId: 'p1', codex: ready() });
    fireEvent.click(chip('エージェント、Claude Code'));
    const row = within(screen.getByRole('listbox', { name: 'エージェント' })).getByRole('option', { name: /Codex/ });
    expect(row.querySelector('.agent-icon[data-agent="codex"] svg path')).not.toBeNull();
    await act(async () => { fireEvent.click(row); });
    expect((await screen.findByRole('button', { name: 'エージェント、Codex' })).querySelector('.agent-icon[data-agent="codex"] svg path')).not.toBeNull();
  });
  it('Codex を選ぶと、アカウント・モデル（自由入力）・effort・権限モード・worktree の札と信頼の注記を外し、モデル・推論・権限の 3 枚を出す。一覧を読む', async () => {
    const { asked } = collect({ projectId: 'p1', codex: ready(), accounts: null });
    await toCodex();
    expect(names()).toEqual(['エージェント、Codex', 'プロジェクト', 'モデル、デフォルト', '推論、medium', '権限、自動', '設定を追加']);
    expect(chip('エージェント、Codex')).toHaveTextContent('ベータ');
    expect(screen.queryByText(/信頼の確認ダイアログ/)).toBeNull();
    expect(asked()).toBe(1);
  });
  it('アカウントが 2 件以上あっても、Codex ではアカウントの札を出さず、params にも account を載せない', async () => {
    const accounts = { list: presentAccounts({ ...initialStore(), accounts: accountsFixture }, 0), currentId: 'primary' };
    const { params } = collect({ projectId: 'p1', codex: ready(), accounts });
    expect(names().some((n) => n?.startsWith('アカウント'))).toBe(true);
    await toCodex();
    expect(names().some((n) => n?.startsWith('アカウント'))).toBe(false);
    start();
    expect(params()[0]).not.toHaveProperty('account');
  });
  it('モデルはデフォルトと一覧のモデルで、選ぶと札に出て、起動に載る。推論は既定の medium を載せる', async () => {
    const { params } = collect({ projectId: 'p1', codex: ready() });
    await toCodex();
    fireEvent.click(chip('モデル、デフォルト'));
    expect(within(screen.getByRole('listbox', { name: 'モデル' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['デフォルト', 'GPT Full何でも向き', 'GPT NoMedium軽い']);
    fireEvent.click(screen.getByRole('option', { name: /GPT Full/ }));
    expect(chip('モデル、GPT Full')).toBeInTheDocument();
    start();
    expect(params()).toEqual([{ projectId: 'p1', agent: 'codex', model: 'gpt-full', effort: 'medium', permissionMode: 'auto' }]);
  });
  it('モデルを選ばなければ model は載せない', async () => {
    const { params } = collect({ projectId: 'p1', codex: ready() });
    await toCodex();
    start();
    expect(params()[0]).toEqual({ projectId: 'p1', agent: 'codex', effort: 'medium', permissionMode: 'auto' });
  });
  it('推論の一覧は、選んだモデルで選べる段階だけを説明つきで並べる', async () => {
    collect({ projectId: 'p1', codex: ready() });
    await toCodex();
    choose('モデル、デフォルト', /GPT NoMedium/);
    fireEvent.click(chip(/^推論、/));
    expect(within(screen.getByRole('listbox', { name: '推論' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['lowlow の説明', 'highhigh の説明']);
  });
  it('選んだ推論がモデルを替えて選べなくなったら medium に戻す。medium も無いモデルは、そのモデルの既定の段階にする', async () => {
    const { params } = collect({ projectId: 'p1', codex: ready() });
    await toCodex();
    choose('モデル、デフォルト', /GPT Full/);
    choose('推論、medium', /ultra/);
    expect(chip('推論、ultra')).toBeInTheDocument();
    choose('モデル、GPT Full', /GPT NoMedium/);
    expect(chip('推論、high')).toBeInTheDocument();
    choose('モデル、GPT NoMedium', /GPT Full/);
    expect(chip('推論、high')).toBeInTheDocument();
    choose('推論、high', /ultra/);
    choose('モデル、GPT Full', 'デフォルト');
    expect(chip('推論、ultra')).toBeInTheDocument();
    start();
    expect(params()[0]).toMatchObject({ effort: 'ultra' });
  });
  it('権限は 1 枚の札で、読み取りのみ・自動・フルアクセスの 3 段を説明つきで並べる。既定は自動', async () => {
    collect({ projectId: 'p1', codex: ready() });
    await toCodex();
    fireEvent.click(chip('権限、自動'));
    expect(within(screen.getByRole('listbox', { name: '権限' })).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '読み取りのみファイルの変更とコマンドの実行の前に確認', '自動作業ディレクトリ内は確認なし。外へアクセスするときは確認', 'フルアクセス確認なしですべて実行（危険）',
    ]);
  });
  it('権限の 3 段が params.permissionMode に載る', async () => {
    const { params } = collect({ projectId: 'p1', codex: ready() });
    await toCodex();
    choose('権限、自動', /読み取りのみ/);
    start();
    expect(params().at(-1)).toMatchObject({ permissionMode: 'read-only' });
  });
  it('フルアクセスは札を赤い枠にして、下に注意を出す。選び直すと注意は消える', async () => {
    const { params } = collect({ projectId: 'p1', codex: ready() });
    await toCodex();
    expect(screen.queryByText('確認なしでコマンドを実行します。信頼できるディレクトリでだけ使ってください。')).toBeNull();
    choose('権限、自動', /フルアクセス/);
    expect(chip('権限、フルアクセス')).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByText('確認なしでコマンドを実行します。信頼できるディレクトリでだけ使ってください。')).toBeInTheDocument();
    start();
    expect(params().at(-1)).toMatchObject({ permissionMode: 'full-access' });
    choose('権限、フルアクセス', /^自動/);
    expect(screen.queryByText('確認なしでコマンドを実行します。信頼できるディレクトリでだけ使ってください。')).toBeNull();
  });
  it('前回 Codex で起こしたプロジェクトは、Codex と前回のモデルと推論で開く', () => {
    const { params, asked } = collect({ projectId: 'p1', codex: ready(), prefs: { p1: { agent: 'codex', codexModel: 'gpt-nomedium', codexEffort: 'low' } } });
    expect(names()).toEqual(['エージェント、Codex', 'プロジェクト', 'モデル、GPT NoMedium', '推論、low', '権限、自動', '設定を追加']);
    expect(asked()).toBe(1);
    start();
    expect(params()[0]).toEqual({ projectId: 'p1', agent: 'codex', model: 'gpt-nomedium', effort: 'low', permissionMode: 'auto' });
  });
  it('前回のモデルが一覧から消えていたらデフォルトに戻し、そのモデルで選べない前回の推論は medium に戻す', () => {
    collect({ projectId: 'p1', codex: ready(), prefs: { p1: { agent: 'codex', codexModel: 'gone', codexEffort: 'max' } } });
    expect(names()).toContain('モデル、デフォルト');
    expect(names()).toContain('推論、medium');
  });
  it('一覧が届く前は、前回のモデルと推論をそのまま見せる', () => {
    collect({ projectId: 'p1', codex: { options: null }, prefs: { p1: { agent: 'codex', codexModel: 'gpt-nomedium', codexEffort: 'low' } } });
    expect(names()).toContain('モデル、gpt-nomedium');
    expect(names()).toContain('推論、low');
  });
  it('前回 Codex でも、設定で無効にしたら Claude Code で開く。別のプロジェクトの前回値は使わない', () => {
    collect({ projectId: 'p1', prefs: { p1: { agent: 'codex', codexModel: 'x' } } });
    expect(names()).not.toContain('エージェント、Codex');
    expect(names()).toContain('モデル、デフォルト');
    collect({ projectId: 'p2', codex: ready(), prefs: { p1: { agent: 'codex' } } });
    expect(screen.getAllByRole('button', { name: 'エージェント、Claude Code' }).length).toBeGreaterThan(0);
  });
  it('一覧が届かなければ、札の下で言う', () => {
    collect({ projectId: 'p1', codex: { options: { status: 'failed', data: null } }, prefs: { p1: { agent: 'codex' } } });
    expect(screen.getByText('codex から一覧を取得できませんでした。')).toBeInTheDocument();
  });
  it('Codex から Claude Code に戻すと、Claude の札と信頼の注記が戻る', async () => {
    collect({ projectId: 'p1', codex: ready(), prefs: { p1: { agent: 'codex' } } });
    fireEvent.click(chip('エージェント、Codex'));
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: /Claude Code/ })); });
    await screen.findByRole('button', { name: 'エージェント、Claude Code' });
    expect(names()).toContain('effort レベル、デフォルト');
    expect(screen.getByText(/信頼の確認ダイアログ/)).toBeInTheDocument();
  });
});
