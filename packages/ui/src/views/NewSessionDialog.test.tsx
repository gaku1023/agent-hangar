import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Intent, LaunchParams } from '@agent-hangar/shared';
import { IntentRoot } from '../intent/chain.tsx';
import type { NewSessionProps } from '../presenters/newSession.ts';
import { presentAccounts, type AccountView } from '../presenters/accounts.ts';
import { accountsFixture } from '../test/accounts.ts';
import { initialStore } from '../store/store.ts';
import { pick } from '../test/pick.ts';
import { NewSessionDialog } from './NewSessionDialog.tsx';
import { NO_ASSIST, PromptAssistContext } from './primitives/promptAssist.ts';

const projects: NewSessionProps['projects'] = [
  { id: 'p1', name: 'alpha', path: '/w/alpha', status: 'active', lastActivity: '2 分前' },
  { id: 'p2', name: 'beta', path: '/w/beta', status: 'paused', lastActivity: '昨日' },
];
const base: NewSessionProps = { projects, recentIds: ['p1'], projectId: null, submitting: false, error: null, scratch: false, draft: null, prefs: {}, dirs: [{ name: 'url-short', path: '/w/url-short' }], takenNames: ['alpha', 'beta'], workspaceRoot: '/w', desktop: true, picked: null, createdProjectId: null, accounts: null };

/** 送られた params だけを集める。キーの有無を見たいので、呼び出しの照合ではなく値そのものを取る。 */
function collectParams(over: Partial<NewSessionProps> = {}): LaunchParams[] {
  const out: LaunchParams[] = [];
  render(<IntentRoot onIntent={(i) => { if (i.type === 'session.new.submit') out.push(i.params); }}><NewSessionDialog {...base} {...over} /></IntentRoot>);
  return out;
}
const start = () => fireEvent.click(screen.getByRole('button', { name: '起動' }));

describe('NewSessionDialog', () => {
  it('選んで起動すると params を出す', () => {
    const params = collectParams();
    pick('プロジェクト', 'alpha');
    fireEvent.change(screen.getByLabelText('名前（任意）'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('初期プロンプト（任意）'), { target: { value: 'やって' } });
    fireEvent.click(screen.getByRole('radio', { name: 'opus' }));
    fireEvent.click(screen.getByRole('radio', { name: 'high' }));
    fireEvent.click(screen.getByRole('radio', { name: '計画だけ' }));
    fireEvent.change(screen.getByLabelText('追加ディレクトリ（1 行 1 つ）'), { target: { value: '/a\n\n/b\n' } });
    start();
    expect(params).toEqual([{ projectId: 'p1', name: 'n', prompt: 'やって', model: 'opus', effort: 'high', permissionMode: 'plan', addDirs: ['/a', '/b'] }]);
  });
  it('プロジェクトの一覧は、最近とすべての群に分かれ、パスと時期を添える', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
    expect(within(screen.getByRole('group', { name: '最近' })).getByRole('option', { name: 'alpha' })).toHaveAccessibleDescription('/w/alpha');
    expect(within(screen.getByRole('group', { name: 'すべて' })).getByRole('option', { name: 'beta' })).toHaveTextContent('昨日');
  });
  it('初期プロジェクトが選ばれ、Esc とやめるで閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} projectId="p2" /></IntentRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('beta');
    fireEvent.click(screen.getByText('やめる'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onIntent).toHaveBeenCalledTimes(2);
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  // 書きかけを背景の押し違いで失わないよう、背景では閉じない。
  it('背景を押しても閉じず、見出しの × で閉じる', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} /></IntentRoot>);
    fireEvent.click(container.querySelector('.overlay')!);
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('見出しが器の名前になり、開いたら名前の欄にフォーカスがある', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} /></IntentRoot>);
    expect(screen.getByRole('dialog', { name: '新しいセッション' })).toBeInTheDocument();
    expect(screen.getByLabelText('名前（任意）')).toHaveFocus();
  });
  it('一覧を開いている間の Esc は一覧だけを閉じ、Enter は起動しない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('プロジェクトを選ばずに押しても起動を出し、projectId は入れない', () => {
    // 未選択の判定は Mediator が持ち、失敗のメッセージが error として戻ってくる。
    const params = collectParams();
    start();
    expect(params).toHaveLength(1);
    expect(Object.keys(params[0]!)).toEqual([]);
  });
  it('読み上げの名前は可視ラベルと一致する', () => {
    // 「（任意）」を落とすと、読み上げでは必須かどうかが分からなくなる。
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} /></IntentRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '名前（任意）' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '初期プロンプト（任意）' })).toBeInTheDocument();
    expect(screen.getByLabelText('追加ディレクトリ（1 行 1 つ）')).toHaveAccessibleName('追加ディレクトリ（1 行 1 つ）');
    expect(screen.getByRole('radiogroup', { name: 'model' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'effort' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'permission mode' })).toBeInTheDocument();
    // 見える見出しも読み上げの名前と同じにする。
    expect([...document.querySelectorAll('.launch-option-label')].map((e) => e.textContent)).toEqual(['model', 'effort', 'permission mode']);
  });
  it('既定のままなら model、effort、permission mode はキーごと入れない', () => {
    // undefined を入れると、利用者の Claude Code の設定を上書きしかねない。
    const params = collectParams({ projectId: 'p1' });
    fireEvent.change(screen.getByLabelText('名前（任意）'), { target: { value: '  ' } });
    fireEvent.change(screen.getByLabelText('追加ディレクトリ（1 行 1 つ）'), { target: { value: '\n \n' } });
    start();
    expect(Object.keys(params[0]!)).toEqual(['projectId']);
  });
  it('permission mode と effort の選択肢は CLI の値に合わせる', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} /></IntentRoot>);
    expect(within(screen.getByRole('radiogroup', { name: 'effort' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['既定', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(within(screen.getByRole('radiogroup', { name: 'permission mode' })).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['既定', '都度たずねる', '編集は任せる', '計画だけ', '自動', 'たずねずに断る', '確認なし']);
  });
  it('「ほか」で打った model を、前後の空白を落として入れる', () => {
    const params = collectParams({ projectId: 'p1' });
    fireEvent.click(screen.getByRole('button', { name: 'ほか' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'model の名前' }), { target: { value: ' claude-opus-5-5 ' } });
    start();
    expect(params[0]).toEqual({ projectId: 'p1', model: 'claude-opus-5-5' });
  });
  it('「ほか」に空白だけを打ったら model を入れない', () => {
    const params = collectParams({ projectId: 'p1' });
    fireEvent.click(screen.getByRole('button', { name: 'ほか' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'model の名前' }), { target: { value: '   ' } });
    start();
    expect(Object.keys(params[0]!)).toEqual(['projectId']);
  });
  it('確認なしを選ぶと警告を出し、起動はそのまま押せる', () => {
    const params = collectParams({ projectId: 'p1' });
    expect(screen.queryByText('ファイルの削除やコマンドも、確認せずに実行します')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '確認なし' }));
    expect(screen.getByText('ファイルの削除やコマンドも、確認せずに実行します')).toBeInTheDocument();
    start();
    expect(params[0]).toEqual({ projectId: 'p1', permissionMode: 'bypassPermissions' });
  });
  it('詳細の見出しに、既定以外を選んだ値を並べる', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} /></IntentRoot>);
    expect(screen.getByText('詳細（model、effort、permission mode、worktree、追加ディレクトリ）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'opus' }));
    fireEvent.click(screen.getByRole('radio', { name: 'high' }));
    fireEvent.click(screen.getByRole('radio', { name: '自動' }));
    expect(screen.getByText('詳細（opus、high、自動）')).toBeInTheDocument();
  });
  it('送信中と失敗の表示', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} projectId="p1" submitting error="tmux が見つかりません" /></IntentRoot>);
    expect(screen.getByRole('button', { name: '起動しています' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('tmux が見つかりません');
    expect(screen.getByText(/信頼確認/)).toBeInTheDocument();
  });
  // 未選択で送った後にプロジェクトを選んでも、「プロジェクトを選んでください」が残っていた。
  it('失敗の文言は、プロジェクトを選び直したら消え、送り直して同じ失敗ならまた出す', () => {
    const onIntent = vi.fn();
    const ui = (error: string | null) => <IntentRoot onIntent={onIntent}><NewSessionDialog {...base} error={error} /></IntentRoot>;
    const { rerender } = render(ui('プロジェクトを選んでください'));
    expect(screen.getByRole('alert')).toHaveTextContent('プロジェクトを選んでください');
    pick('プロジェクト', 'alpha');
    expect(screen.queryByRole('alert')).toBeNull();
    start();
    rerender(ui('プロジェクトを選んでください'));
    expect(screen.getByRole('alert')).toHaveTextContent('プロジェクトを選んでください');
  });
  it('変換中の Enter では起動しない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} projectId="p1" /></IntentRoot>);
    const name = screen.getByLabelText('名前（任意）');
    fireEvent.change(name, { target: { value: 'なまえ' } });
    fireEvent.keyDown(name, { key: 'Enter', keyCode: 229 });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.submit', params: { projectId: 'p1', name: 'なまえ' } });
  });
  it('選択の部品の上の Enter は、その部品の操作であって起動ではない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} projectId="p1" /></IntentRoot>);
    for (const target of [screen.getByRole('radio', { name: '計画だけ' }), screen.getByRole('radio', { name: 'opus' }), screen.getByRole('button', { name: 'ほか' }), screen.getByText('やめる'), screen.getByText(/^詳細/)]) {
      fireEvent.keyDown(target, { key: 'Enter' });
    }
    expect(onIntent).not.toHaveBeenCalled();
  });
  describe('⌘Enter で起動', () => {
    it('初期プロンプトの欄の中からでも ⌘Enter と Ctrl+Enter で起動し、素の Enter は改行に残す', () => {
      const onIntent = vi.fn();
      render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} projectId="p1" /></IntentRoot>);
      const prompt = screen.getByLabelText('初期プロンプト（任意）');
      fireEvent.change(prompt, { target: { value: 'やって' } });
      expect(fireEvent.keyDown(prompt, { key: 'Enter' })).toBe(true);
      expect(onIntent).not.toHaveBeenCalled();
      expect(fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true })).toBe(false);
      fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });
      expect(onIntent.mock.calls).toEqual([[{ type: 'session.new.submit', params: { projectId: 'p1', prompt: 'やって' } }], [{ type: 'session.new.submit', params: { projectId: 'p1', prompt: 'やって' } }]]);
    });
    it('選択の部品や詳細の見出しの上でも ⌘Enter なら起動する', () => {
      const onIntent = vi.fn();
      render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} projectId="p1" /></IntentRoot>);
      fireEvent.keyDown(screen.getByRole('radio', { name: '計画だけ' }), { key: 'Enter', metaKey: true });
      fireEvent.keyDown(screen.getByText(/^詳細/), { key: 'Enter', metaKey: true });
      expect(onIntent).toHaveBeenCalledTimes(2);
    });
    it('変換中の ⌘Enter と、送信中の ⌘Enter では起動しない', () => {
      const onIntent = vi.fn();
      const { rerender } = render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} projectId="p1" /></IntentRoot>);
      fireEvent.keyDown(screen.getByLabelText('初期プロンプト（任意）'), { key: 'Enter', metaKey: true, keyCode: 229 });
      rerender(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} projectId="p1" submitting /></IntentRoot>);
      fireEvent.keyDown(screen.getByLabelText('初期プロンプト（任意）'), { key: 'Enter', metaKey: true });
      expect(onIntent).not.toHaveBeenCalled();
    });
    it('起動ボタンの中にキー帽を置き、読み上げの名前は「起動」のまま打鍵を添える（B1）', () => {
      render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} /></IntentRoot>);
      const button = screen.getByRole('button', { name: '起動' });
      expect(button).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter');
      const cap = button.querySelector('.kc')!;
      expect(cap).toHaveTextContent('⌘↵');
      expect(cap).toHaveAttribute('aria-hidden', 'true');
    });
  });
  it('一覧に出ないプロジェクトの id は、選んでいない扱いで送らない', () => {
    const params = collectParams({ projectId: 'archived1' });
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('選んでください');
    start();
    expect(Object.keys(params[0]!)).toEqual([]);
  });
});

describe('NewSessionDialog のスクラッチ', () => {
  it('一覧の先頭の「すぐ始める」にスクラッチの行があり、昇格できることを添える', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
    const groups = within(screen.getByRole('listbox')).getAllByRole('group');
    expect(groups[0]).toHaveAccessibleName('すぐ始める');
    expect(within(groups[0]!).getByRole('option', { name: 'スクラッチ' })).toHaveAccessibleDescription('名前は決めずに始めて、あとでプロジェクトに昇格できる');
  });
  it('スクラッチを選ぶと見出しと説明が変わり、scratch を付けて送る', () => {
    const params = collectParams();
    expect(screen.getByText('新しいセッション')).toBeInTheDocument();
    pick('プロジェクト', 'スクラッチ');
    expect(screen.getByText('スクラッチで始める')).toBeInTheDocument();
    expect(screen.getByText(/の下に日時のディレクトリを作って起動します/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('~/.agent-hangar/scratch/<日時>/');
    start();
    expect(params).toEqual([{ scratch: true }]);
  });
  it('初期プロンプトの @（ファイル）は、パスのあるプロジェクトを選んだときだけ使える', () => {
    const noPath: NewSessionProps['projects'] = [...projects, { id: 'p3', name: 'gamma', path: null, status: 'active', lastActivity: '' }];
    collectParams({ projects: noPath });
    const files = () => screen.getByRole('button', { name: 'ファイル' });
    // 未選択
    expect(files()).toBeDisabled();
    pick('プロジェクト', 'alpha');
    expect(files()).toBeEnabled();
    // パスの無いプロジェクトは、探す先のフォルダが無い。
    pick('プロジェクト', 'gamma');
    expect(files()).toBeDisabled();
    pick('プロジェクト', 'スクラッチ');
    expect(files()).toBeDisabled();
  });
  it('scratch で開くとスクラッチが選ばれ、プロジェクトに選び直せば projectId で送る', () => {
    // ⌘⇧N、パレット、スクラッチのプロジェクト画面は、この状態でダイアログを開く。
    const params = collectParams({ scratch: true });
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('スクラッチ');
    expect(screen.getByText('スクラッチで始める')).toBeInTheDocument();
    pick('プロジェクト', 'alpha');
    expect(screen.getByText('新しいセッション')).toBeInTheDocument();
    expect(screen.queryByText(/の下に日時のディレクトリを作って起動します/)).toBeNull();
    start();
    expect(params).toEqual([{ projectId: 'p1' }]);
  });
  it('scratch と projectId が両方来たらスクラッチを選ぶ', () => {
    // サーバも scratch を優先する（runs/manager.ts）。見た目と送る内容をそろえる。
    const params = collectParams({ scratch: true, projectId: 'p1' });
    start();
    expect(params).toEqual([{ scratch: true }]);
  });
  it('検索欄に「スクラッチ」と打つと当たる', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, name: `proj-${i}`, path: `/w/proj-${i}`, status: 'active' as const, lastActivity: '' }));
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} projects={many} recentIds={[]} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'スクラッチ' } });
    // 下端の操作も option なので、行だけを比べる。
    expect(screen.getAllByRole('option').filter((o) => !o.classList.contains('listbox-act')).map((o) => o.getAttribute('aria-label'))).toEqual(['スクラッチ']);
  });
});

describe('NewSessionDialog の下書き（C1）', () => {
  it('前に閉じたときの書きかけを戻し、見出しの右に「下書き」の札と「消す」を出す', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} draft={{ name: 'API の節', prompt: '関数ごとに表を', attachments: [] }} /></IntentRoot>);
    expect(screen.getByLabelText('名前（任意）')).toHaveValue('API の節');
    expect(screen.getByLabelText('初期プロンプト（任意）')).toHaveValue('関数ごとに表を');
    const head = screen.getByRole('dialog').querySelector('.dialog-head')!;
    expect(within(head as HTMLElement).getByText('下書き')).toBeInTheDocument();
    expect(within(head as HTMLElement).getByRole('button', { name: '下書きを消す' })).toBeInTheDocument();
  });
  it('下書きが無ければ札を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} /></IntentRoot>);
    expect(screen.queryByText('下書き')).toBeNull();
    expect(screen.queryByRole('button', { name: '下書きを消す' })).toBeNull();
  });
  it('「消す」で名前と初期プロンプトを空にし、札を外し、下書きも消す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} draft={{ name: 'n', prompt: 'p', attachments: [] }} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '下書きを消す' }));
    expect(screen.getByLabelText('名前（任意）')).toHaveValue('');
    expect(screen.getByLabelText('初期プロンプト（任意）')).toHaveValue('');
    expect(screen.queryByText('下書き')).toBeNull();
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.draft', name: '', prompt: '', attachments: [] });
    // 消した後は名前の欄から打ち直せる。
    expect(screen.getByLabelText('名前（任意）')).toHaveFocus();
  });
  it('閉じるときに、名前と初期プロンプトの書きかけを下書きとして送る', () => {
    const onIntent = vi.fn();
    const { unmount } = render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('名前（任意）'), { target: { value: 'なまえ' } });
    fireEvent.change(screen.getByLabelText('初期プロンプト（任意）'), { target: { value: 'やって' } });
    // 打っている間は送らない。打鍵のたびに画面全体を描き直さないためである。
    expect(onIntent).not.toHaveBeenCalled();
    unmount();
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.draft', name: 'なまえ', prompt: 'やって', attachments: [] });
  });
  it('添付があると、本文の後に空行とパスを足して起動する', () => {
    const params = collectParams({ projectId: 'p1', draft: { name: '', prompt: '見て', attachments: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }] } });
    start();
    expect(params).toEqual([{ projectId: 'p1', prompt: '見て\n\n/h/.agent-hangar/drops/1-0-a.png' }]);
  });
  it('本文が空でも、添付だけで起動できる', () => {
    const params = collectParams({ projectId: 'p1', draft: { name: '', prompt: '', attachments: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }] } });
    start();
    expect(params).toEqual([{ projectId: 'p1', prompt: '/h/.agent-hangar/drops/1-0-a.png' }]);
  });
  it('閉じるときの下書きに、添付も入れる', () => {
    const drafts: unknown[] = [];
    const a = { path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 };
    const { unmount } = render(<IntentRoot onIntent={(i) => { if (i.type === 'session.new.draft') drafts.push(i); }}><NewSessionDialog {...base} draft={{ name: 'n', prompt: '', attachments: [a] }} /></IntentRoot>);
    unmount();
    expect(drafts).toEqual([{ type: 'session.new.draft', name: 'n', prompt: '', attachments: [a] }]);
  });
  it('下書きを消すと、添付も消える', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} draft={{ name: 'n', prompt: '', attachments: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }] }} /></IntentRoot>);
    expect(screen.getByRole('listitem', { name: 'a.png' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下書きを消す' }));
    expect(screen.queryByRole('listitem', { name: 'a.png' })).toBeNull();
  });
  describe('添付を送っている最中', () => {
    /** 手で解決できる送信を持つ、ダイアログの描画。 */
    function pending(over: Partial<NewSessionProps> = {}) {
      const intents: Intent[] = [];
      let finish: (d: { path: string; name: string; size: number }) => void = () => {};
      let fail: (e: Error) => void = () => {};
      const upload = vi.fn(() => new Promise<{ path: string; name: string; size: number }>((res, rej) => { finish = res; fail = rej; }));
      const ui = (props: Partial<NewSessionProps>) => (
        <PromptAssistContext.Provider value={{ ...NO_ASSIST, upload }}>
          <IntentRoot onIntent={(i) => intents.push(i)}><NewSessionDialog {...base} projectId="p1" {...over} {...props} /></IntentRoot>
        </PromptAssistContext.Provider>
      );
      const view = render(ui({}));
      return { ...view, intents, ui, finish: (d = { path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }) => finish(d), fail: (e: Error) => fail(e) };
    }
    const paste = () => fireEvent.paste(screen.getByLabelText('初期プロンプト（任意）'), { clipboardData: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });

    it('起動ボタンは使えず「添付を送っています」と出し、⌘Enter でも起動しない。終われば添付のパスつきで起動できる', async () => {
      const t = pending();
      fireEvent.change(screen.getByLabelText('初期プロンプト（任意）'), { target: { value: '見て' } });
      paste();
      const btn = screen.getByRole('button', { name: '添付を送っています' });
      expect(btn).toBeDisabled();
      fireEvent.keyDown(screen.getByLabelText('初期プロンプト（任意）'), { key: 'Enter', metaKey: true });
      expect(t.intents.filter((i) => i.type === 'session.new.submit')).toEqual([]);
      await act(async () => { t.finish(); });
      expect(screen.queryByRole('button', { name: '添付を送っています' })).toBeNull();
      start();
      expect(t.intents.filter((i) => i.type === 'session.new.submit')).toEqual([{ type: 'session.new.submit', params: { projectId: 'p1', prompt: '見て\n\n/h/.agent-hangar/drops/1-0-a.png' } }]);
    });
    it('失敗したら、起動できる状態に戻る', async () => {
      const t = pending();
      paste();
      expect(screen.getByRole('button', { name: '添付を送っています' })).toBeDisabled();
      await act(async () => { t.fail(new Error('x')); });
      expect(screen.getByRole('button', { name: /起動/ })).toBeEnabled();
    });
    // 閉じる前の名前と本文で下書きを置き換えると、開き直したダイアログの書きかけを上書きする。遅れて着いた添付だけを足す Intent を送る。
    it('送っている最中に閉じても、終わったときに、着いた添付だけを下書きへ足す（名前と本文は送らない）', async () => {
      const t = pending();
      fireEvent.change(screen.getByLabelText('名前（任意）'), { target: { value: 'なまえ' } });
      fireEvent.change(screen.getByLabelText('初期プロンプト（任意）'), { target: { value: '見て' } });
      paste();
      t.unmount();
      t.intents.length = 0;
      await act(async () => { t.finish(); });
      expect(t.intents).toEqual([{ type: 'session.new.draft.attach', attachments: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }] }]);
    });
    it('閉じた後に 2 件が終わったら、1 件ずつ、その 1 件だけを持つ Intent を送る', async () => {
      const intents: Intent[] = [];
      const done: ((d: { path: string; name: string; size: number }) => void)[] = [];
      const upload = vi.fn(() => new Promise<{ path: string; name: string; size: number }>((res) => { done.push(res); }));
      const view = render(
        <PromptAssistContext.Provider value={{ ...NO_ASSIST, upload }}>
          <IntentRoot onIntent={(i) => intents.push(i)}><NewSessionDialog {...base} projectId="p1" /></IntentRoot>
        </PromptAssistContext.Provider>,
      );
      paste();
      paste();
      // 閉じる前に着いたものは、閉じるときの下書きに入る。ここでは何も着いていない。
      view.unmount();
      intents.length = 0;
      const a = { path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 };
      const b = { path: '/h/.agent-hangar/drops/1-1-b.png', name: 'b.png', size: 4 };
      await act(async () => { done[0]!(a); });
      await act(async () => { done[1]!(b); });
      expect(intents).toEqual([{ type: 'session.new.draft.attach', attachments: [a] }, { type: 'session.new.draft.attach', attachments: [b] }]);
    });
    it('起動を送った後に閉じたなら、終わっても下書きを送らない', async () => {
      const t = pending();
      paste();
      t.rerender(t.ui({ submitting: true }));
      t.unmount();
      t.intents.length = 0;
      await act(async () => { t.finish(); });
      expect(t.intents).toEqual([]);
    });
  });
  it('起動を送った後に閉じたとき（起動し終えたとき）は、下書きを送らない', () => {
    const onIntent = vi.fn();
    const { rerender, unmount } = render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} projectId="p1" /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('名前（任意）'), { target: { value: 'なまえ' } });
    rerender(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} projectId="p1" submitting /></IntentRoot>);
    unmount();
    expect(onIntent.mock.calls.filter(([i]) => i.type === 'session.new.draft')).toEqual([]);
  });
});

describe('NewSessionDialog の前回値（D1）', () => {
  const prefs = { p1: { model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }, p2: { model: 'claude-x', worktree: 'wt', addDirs: ['/a', '/b'] } };
  const fold = () => screen.getByRole('dialog').querySelector('summary')!;
  it('選んだプロジェクトの前回値を初期値にし、詳細の見出しに「前回と同じ」と中身を出す', () => {
    const params = collectParams({ projectId: 'p1', prefs });
    expect(screen.getByRole('radio', { name: 'opus' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'high' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '編集は任せる' })).toHaveAttribute('aria-checked', 'true');
    expect(within(fold()).getByText('前回と同じ')).toBeInTheDocument();
    expect(fold()).toHaveTextContent('opus、high、編集は任せる');
    start();
    expect(params).toEqual([{ projectId: 'p1', model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }]);
  });
  it('worktree と追加ディレクトリ、選択肢に無い model も戻す', () => {
    const params = collectParams({ projectId: 'p2', prefs });
    expect(screen.getByRole('textbox', { name: 'model の名前' })).toHaveValue('claude-x');
    expect(screen.getByLabelText('worktree')).toHaveValue('wt');
    expect(screen.getByLabelText('追加ディレクトリ（1 行 1 つ）')).toHaveValue('/a\n/b');
    expect(fold()).toHaveTextContent('claude-x、worktree wt、追加ディレクトリ 2 件');
    start();
    expect(params).toEqual([{ projectId: 'p2', model: 'claude-x', worktree: 'wt', addDirs: ['/a', '/b'] }]);
  });
  it('「既定に戻す」で詳細を全部空にし、見出しを元に戻す。詳細は開閉しない', () => {
    const params = collectParams({ projectId: 'p1', prefs });
    const details = screen.getByRole('dialog').querySelector('details')!;
    fireEvent.click(within(fold()).getByRole('button', { name: '既定に戻す' }));
    expect(details.open).toBe(false);
    for (const g of ['model', 'effort', 'permission mode']) {
      expect(within(screen.getByRole('radiogroup', { name: g })).getByRole('radio', { checked: true })).toHaveAccessibleName('既定');
    }
    expect(screen.queryByText('前回と同じ')).toBeNull();
    expect(screen.getByText('詳細（model、effort、permission mode、worktree、追加ディレクトリ）')).toBeInTheDocument();
    start();
    expect(params).toEqual([{ projectId: 'p1' }]);
  });
  it('値を変えると「前回と同じ」を外し、選んだ値を並べる', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} projectId="p1" prefs={prefs} /></IntentRoot>);
    fireEvent.click(screen.getByRole('radio', { name: 'sonnet' }));
    expect(screen.queryByText('前回と同じ')).toBeNull();
    expect(screen.getByText('詳細（sonnet、high、編集は任せる）')).toBeInTheDocument();
  });
  it('詳細に触れる前にプロジェクトを選び直すと、そのプロジェクトの前回値に入れ替える', () => {
    const params = collectParams({ projectId: 'p1', prefs });
    pick('プロジェクト', 'beta');
    expect(screen.getByLabelText('worktree')).toHaveValue('wt');
    pick('プロジェクト', 'スクラッチ');
    // 前回値の無いプロジェクトは既定に戻す。
    expect(screen.getByLabelText('worktree')).toHaveValue('');
    expect(screen.queryByText('前回と同じ')).toBeNull();
    start();
    expect(params).toEqual([{ scratch: true }]);
  });
  it('詳細に触れた後は、プロジェクトを選び直しても自分で選んだ値を残す', () => {
    const params = collectParams({ projectId: 'p1', prefs });
    fireEvent.click(screen.getByRole('radio', { name: 'low' }));
    pick('プロジェクト', 'beta');
    start();
    expect(params).toEqual([{ projectId: 'p2', model: 'opus', effort: 'low', permissionMode: 'acceptEdits' }]);
  });
  it('スクラッチで開くとスクラッチの前回値を使う', () => {
    const params = collectParams({ scratch: true, prefs: { ':scratch': { effort: 'max' } } });
    expect(screen.getByRole('radio', { name: 'max' })).toHaveAttribute('aria-checked', 'true');
    start();
    expect(params).toEqual([{ scratch: true, effort: 'max' }]);
  });
  it('初期プロンプトで / の候補から選ぶと、その文で起動する', async () => {
    const out: LaunchParams[] = [];
    const assist = { ...NO_ASSIST, commands: () => Promise.resolve([{ name: 'goal', description: '長く走る', argumentHint: null, source: 'user' as const, uses: 3 }]) };
    render(<PromptAssistContext.Provider value={assist}><IntentRoot onIntent={(i) => { if (i.type === 'session.new.submit') out.push(i.params); }}><NewSessionDialog {...base} projectId="p1" /></IntentRoot></PromptAssistContext.Provider>);
    await act(async () => {});
    const ta = screen.getByLabelText('初期プロンプト（任意）');
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
    render(<PromptAssistContext.Provider value={assist}><IntentRoot onIntent={(i) => { if (i.type === 'overlay.close') closed(); }}><NewSessionDialog {...base} projectId="p1" /></IntentRoot></PromptAssistContext.Provider>);
    await act(async () => {});
    const ta = screen.getByLabelText('初期プロンプト（任意）');
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: '/', selectionStart: 1, selectionEnd: 1 } });
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(closed).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox', { name: 'スキルとコマンド' })).toBeNull();
  });
});

/** 送られた intent をすべて集める。 */
function collect(over: Partial<NewSessionProps> = {}) {
  const out: Intent[] = [];
  const view = render(<IntentRoot onIntent={(i) => out.push(i)}><NewSessionDialog {...base} {...over} /></IntentRoot>);
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
    expect(screen.getByLabelText('フォルダの名前')).toHaveValue('price');
    expect(screen.getByText('/w/price を作り、プロジェクトに登録して起動します')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'git init する' })).toHaveAttribute('aria-checked', 'true');
    start();
    expect(out.filter((i) => i.type === 'session.new.submit')).toEqual([{ type: 'session.new.submit', params: {}, place: { kind: 'newDir', name: 'price', gitInit: true } }]);
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
    fireEvent.click(screen.getByRole('option', { name: 'ほかの場所を選ぶ…' }));
    expect(out).toContainEqual({ type: 'folder.pick' });
    view.unmount();
    collect({ desktop: false });
    openList();
    expect(screen.queryByRole('option', { name: 'ほかの場所を選ぶ…' })).toBeNull();
  });
  it('Finder で選んだワークスペースの外のフォルダは、外である旨を添えて登録して始める', () => {
    const { out, view } = collect();
    view.rerender(<IntentRoot onIntent={(i) => out.push(i)}><NewSessionDialog {...base} picked={{ path: '/Users/me/thesis', n: 1 }} /></IntentRoot>);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('フォルダを登録して始める');
    expect(screen.getByText('ワークスペースの外のフォルダです。この PC でのパスだけを覚えます。ほかの PC では、開いたときに場所を聞きます')).toBeInTheDocument();
    start();
    expect(out.find((i) => i.type === 'session.new.submit')).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/Users/me/thesis' } });
  });
  it('Finder で選んだのが未登録の一覧にあるフォルダなら、未登録のフォルダと同じ 1 行で登録して始める', () => {
    const { out, view } = collect();
    view.rerender(<IntentRoot onIntent={(i) => out.push(i)}><NewSessionDialog {...base} picked={{ path: '/w/url-short', n: 1 }} /></IntentRoot>);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('フォルダを登録して始める');
    expect(screen.getByText('/w/url-short はまだプロジェクトではありません。起動すると登録します')).toBeInTheDocument();
    expect(screen.queryByText(/ワークスペースの外のフォルダです/)).toBeNull();
    start();
    expect(out.find((i) => i.type === 'session.new.submit')).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/w/url-short' } });
  });
  it('Finder で選んだのが登録済みのプロジェクトなら、そのプロジェクトを選ぶ', () => {
    const { out, view } = collect();
    view.rerender(<IntentRoot onIntent={(i) => out.push(i)}><NewSessionDialog {...base} picked={{ path: '/w/beta', n: 1 }} /></IntentRoot>);
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
    view.rerender(<IntentRoot onIntent={(i) => out.push(i)}><NewSessionDialog {...base} projects={projectsWithNew} error="tmux が見つかりません" createdProjectId="p9" /></IntentRoot>);
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
  const cards = () => screen.getByRole('radiogroup', { name: 'アカウント' });
  const card = (name: string) => within(cards()).getByRole('radio', { name: new RegExp(name) });
  /** 起動と accounts.load を集める。 */
  function collect(over: Partial<NewSessionProps> = {}) {
    const intents: { type: string; params?: LaunchParams }[] = [];
    const ui = (p: Partial<NewSessionProps>) => <IntentRoot onIntent={(i) => { intents.push(i as never); }}><NewSessionDialog {...base} {...p} /></IntentRoot>;
    const view = render(ui(over));
    return { intents, params: () => intents.filter((i) => i.type === 'session.new.submit').map((i) => i.params!), rerender: (p: Partial<NewSessionProps>) => view.rerender(ui(p)) };
  }

  it('accounts が null なら、アカウントの段を出さず、params に account を入れない', () => {
    const { params, intents } = collect({ projectId: 'p1', accounts: null });
    expect(screen.queryByRole('radiogroup', { name: 'アカウント' })).toBeNull();
    expect(screen.queryByText('アカウント')).toBeNull();
    start();
    expect(params()).toEqual([{ projectId: 'p1' }]);
    expect('account' in params()[0]!).toBe(false);
    expect(intents.some((i) => i.type === 'accounts.load')).toBe(false);
  });
  it('段は、プロジェクトの欄の下、名前の欄の上に、見出し「アカウント」で出る', () => {
    collect({ accounts: accountsOf() });
    const project = screen.getByRole('button', { name: 'プロジェクト' });
    const name = screen.getByLabelText('名前（任意）');
    const order = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(order(project, cards())).toBe(true);
    expect(order(cards(), name)).toBe(true);
    expect(cards().closest('.field')).toHaveTextContent(/^アカウント/);
    expect(within(cards()).getAllByRole('radio')).toHaveLength(2);
  });
  it('はじめはいまのアカウントを選び、そのまま起動すると account に入れる', () => {
    const { params } = collect({ projectId: 'p1', accounts: accountsOf() });
    expect(card('会社')).toHaveAttribute('aria-checked', 'true');
    expect(card('大学')).toHaveAttribute('aria-checked', 'false');
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
  it('大学を選んで起動すると account は a1 で、いまのアカウントは変えない（account.choose を出さない）', () => {
    const { intents, params } = collect({ projectId: 'p1', accounts: accountsOf() });
    fireEvent.click(card('大学'));
    expect(card('大学')).toHaveAttribute('aria-checked', 'true');
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'a1' }]);
    expect(intents.map((i) => i.type)).not.toContain('account.choose');
  });
  it('いまのアカウントが未ログインなら、はじめはログイン済みの最初の 1 件を選ぶ', () => {
    const { params } = collect({ projectId: 'p1', accounts: accountsOf([{ auth: 'out' }, {}]) });
    expect(card('会社')).toHaveAttribute('aria-disabled', 'true');
    expect(card('大学')).toHaveAttribute('aria-checked', 'true');
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'a1' }]);
  });
  it('いまのアカウントが初めてのログインの途中でも飛ばす。まだ読めていない（unknown）なら選ぶ', () => {
    collect({ accounts: accountsOf([{ auth: 'running', loggedIn: false }, {}]) });
    expect(card('大学')).toHaveAttribute('aria-checked', 'true');
    document.body.innerHTML = '';
    collect({ accounts: accountsOf([{ auth: 'unknown' }, {}]) });
    expect(card('会社')).toHaveAttribute('aria-checked', 'true');
  });
  it('いまのアカウントがログインし直しの途中でも、はじめの選択は動かず、選べる', () => {
    const { params } = collect({ projectId: 'p1', accounts: accountsOf([{ auth: 'running', loggedIn: true }, {}]) });
    expect(card('会社')).toHaveAttribute('aria-checked', 'true');
    expect(card('会社')).not.toHaveAttribute('aria-disabled');
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
  it('どれも選べないときは、いまのアカウントのままにする', () => {
    const { params } = collect({ projectId: 'p1', accounts: accountsOf([{ auth: 'out' }, { auth: 'out' }]) });
    expect(card('会社')).toHaveAttribute('aria-checked', 'true');
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
  it('未ログインの札は押しても選べない', () => {
    const { params } = collect({ projectId: 'p1', accounts: accountsOf([{}, { auth: 'out' }]) });
    fireEvent.click(card('大学'));
    expect(card('会社')).toHaveAttribute('aria-checked', 'true');
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
  it('開いたときに accounts.load を 1 回だけ出す', () => {
    const { intents, rerender } = collect({ accounts: accountsOf() });
    expect(intents.filter((i) => i.type === 'accounts.load')).toHaveLength(1);
    fireEvent.click(card('大学'));
    rerender({ accounts: accountsOf() });
    expect(intents.filter((i) => i.type === 'accounts.load')).toHaveLength(1);
  });
  it('選んでいた id が props から消えたら、いまのアカウントに戻す', () => {
    const { params, rerender } = collect({ projectId: 'p1', accounts: accountsOf() });
    fireEvent.click(card('大学'));
    rerender({ projectId: 'p1', accounts: { list: [list[0]!, { ...list[0]!, id: 'a2', name: '個人', current: false }], currentId: 'primary' } });
    expect(card('会社')).toHaveAttribute('aria-checked', 'true');
    expect(within(cards()).queryByRole('radio', { name: /大学/ })).toBeNull();
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
  it('開いてから送るまでにいまのアカウントが変わっても、選んだとおりに起こす', () => {
    const { params, rerender } = collect({ projectId: 'p1', accounts: accountsOf() });
    fireEvent.click(card('大学'));
    rerender({ projectId: 'p1', accounts: accountsOf([{}, {}], 'a1') });
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'a1' }]);
  });
  it.each(['out', 'running'] as const)('選んでいた札が選べなくなったら（%s）、いまのアカウントへ戻し、そのとおりに起動する', (auth) => {
    const { params, rerender } = collect({ projectId: 'p1', accounts: accountsOf() });
    fireEvent.click(card('大学'));
    expect(card('大学')).toHaveAttribute('aria-checked', 'true');
    rerender({ projectId: 'p1', accounts: accountsOf([{}, { auth, loggedIn: false }]) });
    expect(card('会社')).toHaveAttribute('aria-checked', 'true');
    expect(card('大学')).toHaveAttribute('aria-checked', 'false');
    expect(card('大学')).toHaveAttribute('aria-disabled', 'true');
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
  it('まだ自分で選んでいない間は、開いたままいまのアカウントが変わるとはじめの選択も付いていく', () => {
    const { params, rerender } = collect({ projectId: 'p1', accounts: accountsOf() });
    expect(card('会社')).toHaveAttribute('aria-checked', 'true');
    rerender({ projectId: 'p1', accounts: accountsOf([{}, {}], 'a1') });
    expect(card('大学')).toHaveAttribute('aria-checked', 'true');
    expect(card('会社')).toHaveAttribute('aria-checked', 'false');
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'a1' }]);
  });
  it('選んだあとにプロジェクトを選び直しても、アカウントの選択は残る', () => {
    const { params } = collect({ accounts: accountsOf() });
    fireEvent.click(card('大学'));
    pick('プロジェクト', 'alpha');
    start();
    expect(params()).toEqual([{ projectId: 'p1', account: 'a1' }]);
  });
  it('札の上の Enter は起動に使わず、⌘Enter なら起動する', () => {
    const { params } = collect({ projectId: 'p1', accounts: accountsOf() });
    fireEvent.keyDown(card('会社'), { key: 'Enter' });
    expect(params()).toEqual([]);
    fireEvent.keyDown(card('会社'), { key: 'Enter', metaKey: true });
    expect(params()).toEqual([{ projectId: 'p1', account: 'primary' }]);
  });
});
