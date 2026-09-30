import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LaunchParams } from '@agent-hangar/shared';
import { IntentRoot } from '../intent/chain.tsx';
import type { NewSessionProps } from '../presenters/newSession.ts';
import { pick } from '../test/pick.ts';
import { NewSessionDialog } from './NewSessionDialog.tsx';

const projects: NewSessionProps['projects'] = [
  { id: 'p1', name: 'alpha', path: '/w/alpha', status: 'active', lastActivity: '2 分前' },
  { id: 'p2', name: 'beta', path: '/w/beta', status: 'paused', lastActivity: '昨日' },
];
const base: NewSessionProps = { projects, recentIds: ['p1'], projectId: null, submitting: false, error: null, scratch: false };

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
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['スクラッチ']);
  });
});
