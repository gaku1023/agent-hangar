import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountDirPreviewDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { AddAccountProps } from '../presenters/addAccount.ts';
import { AddAccountDialog } from './AddAccountDialog.tsx';

const HOME = '/Users/taro';
const base: AddAccountProps = { home: HOME, primaryDirLabel: '~/.claude', desktop: true, picked: null, preview: null, submitting: false, error: null };
const preview = (o: Partial<AccountDirPreviewDto> = {}): AccountDirPreviewDto => ({ name: '', input: '', dir: `${HOME}/.claude-2`, suggested: true, exists: false, conflicts: [], registeredAs: null, ...o });

function mount(p: Partial<AddAccountProps> = {}) {
  const onAction = vi.fn();
  const view = render(<ActionRoot onAction={onAction}><AddAccountDialog {...base} {...p} /></ActionRoot>);
  const rerender = (q: Partial<AddAccountProps>) => view.rerender(<ActionRoot onAction={onAction}><AddAccountDialog {...base} {...q} /></ActionRoot>);
  return { onAction, rerender };
}
const nameField = () => screen.getByRole('textbox', { name: '名前' });
const dirField = () => screen.getByRole('textbox', { name: '設定ディレクトリ' });
const submit = () => screen.getByRole('button', { name: '追加してログイン' });
const sent = (onAction: ReturnType<typeof vi.fn>, type: string) => onAction.mock.calls.map((c) => c[0]).filter((a: { type: string }) => a.type === type);

afterEach(() => vi.restoreAllMocks());

describe('AddAccountDialog', () => {
  it('開くと、空の名前で足す前の確かめを読む。名前を打つたびに読み直す', () => {
    const { onAction } = mount();
    expect(sent(onAction, 'account.add.preview')).toEqual([{ type: 'account.add.preview', name: '', dir: '' }]);
    fireEvent.change(nameField(), { target: { value: 'univ' } });
    expect(sent(onAction, 'account.add.preview').at(-1)).toEqual({ type: 'account.add.preview', name: 'univ', dir: '' });
  });

  it('場所は、名前に合った答えが届くと ~ の形で埋まる。古い名前の答えでは埋めない', () => {
    const { rerender } = mount();
    fireEvent.change(nameField(), { target: { value: 'univ' } });
    rerender({ preview: preview({ name: 'uni', dir: `${HOME}/.claude-uni` }) });
    expect(dirField()).toHaveValue('');
    rerender({ preview: preview({ name: 'univ', dir: `${HOME}/.claude-univ` }) });
    expect(dirField()).toHaveValue('~/.claude-univ');
  });

  it('登録すると、名前と、見えている場所（埋まった候補なら絶対パス）を送る', () => {
    const { onAction, rerender } = mount();
    fireEvent.change(nameField(), { target: { value: ' univ ' } });
    rerender({ preview: preview({ name: ' univ ', dir: `${HOME}/.claude-univ` }) });
    fireEvent.click(submit());
    expect(sent(onAction, 'account.add')).toEqual([{ type: 'account.add', name: ' univ ', dir: `${HOME}/.claude-univ` }]);
  });

  it('場所を自分で打ったら、その場所で確かめ、その場所を送る。名前を変えても上書きしない', () => {
    const { onAction } = mount();
    fireEvent.change(nameField(), { target: { value: 'lab' } });
    fireEvent.change(dirField(), { target: { value: '~/.claude-lab2' } });
    expect(sent(onAction, 'account.add.preview').at(-1)).toEqual({ type: 'account.add.preview', name: 'lab', dir: '~/.claude-lab2' });
    fireEvent.change(nameField(), { target: { value: 'lab3' } });
    expect(dirField()).toHaveValue('~/.claude-lab2');
    fireEvent.click(submit());
    expect(sent(onAction, 'account.add')).toEqual([{ type: 'account.add', name: 'lab3', dir: '~/.claude-lab2' }]);
  });

  it('名前が空か送信中は押せない。登録済みの場所なら理由を出して押せない', () => {
    const { rerender } = mount();
    expect(submit()).toBeDisabled();
    fireEvent.change(nameField(), { target: { value: 'x' } });
    rerender({ preview: preview({ name: 'x' }) });
    expect(submit()).toBeEnabled();
    rerender({ preview: preview({ name: 'x' }), submitting: true });
    expect(submit()).toBeDisabled();
    rerender({ preview: preview({ name: 'x', registeredAs: '会社' }) });
    expect(submit()).toBeDisabled();
    expect(screen.getByText('この設定ディレクトリは「会社」で登録済みです。')).toBeInTheDocument();
  });

  it('共有するもの 4 組と、分けるもの 3 つを、2 列で見せる', () => {
    mount();
    const shared = screen.getByRole('list', { name: '~/.claude と共有する（リンク）' });
    expect(within(shared).getAllByRole('listitem').map((li) => li.firstChild?.textContent)).toEqual(['設定と指示', 'スキル、コマンド、プラグイン', 'メモリと計画', '会話の履歴']);
    expect(within(shared).getByText('projects、history.jsonl ほか 6 項目')).toBeInTheDocument();
    const separate = screen.getByRole('list', { name: '共有しない（アカウントごと）' });
    expect(within(separate).getAllByRole('listitem').map((li) => li.firstChild?.textContent)).toEqual(['ログイン', '組織から配布される設定', 'キャッシュと常駐プロセスの状態']);
  });

  it('場所に同じ名前の実ファイルがあれば、名前を挙げて触らないと言う。無いときは何も添えない', () => {
    const { rerender } = mount();
    expect(document.querySelector('.add-account-note')).toBeNull();
    fireEvent.change(nameField(), { target: { value: 'univ' } });
    rerender({ preview: preview({ name: 'univ', dir: `${HOME}/.claude-univ`, exists: true, conflicts: ['settings.json', 'skills'] }) });
    expect(screen.getByText('~/.claude-univ には settings.json、skills が実ファイルとしてあります。上書きしません。共有するときは、中身を確認してから削除してください。')).toBeInTheDocument();
    rerender({ preview: preview({ name: 'univ', dir: `${HOME}/.claude-univ`, exists: true }) });
    expect(screen.getByText('この設定ディレクトリはすでにあります。足りないリンクだけを追加します。')).toBeInTheDocument();
  });

  it('「選ぶ…」はホームから Finder を開き、選んだフォルダを場所に入れる。殻が無ければ出さない', () => {
    const { onAction, rerender } = mount({ picked: { path: '/old', n: 3 } });
    // 開く前に選んだ結果は使わない。
    expect(dirField()).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '選択…' }));
    expect(sent(onAction, 'account.add.pick')).toEqual([{ type: 'account.add.pick', defaultPath: HOME }]);
    rerender({ picked: { path: `${HOME}/.claude-univ`, n: 4 } });
    expect(dirField()).toHaveValue('~/.claude-univ');
    expect(sent(onAction, 'account.add.preview').at(-1)).toEqual({ type: 'account.add.preview', name: '', dir: '~/.claude-univ' });
  });

  it('殻の外では「選ぶ…」を出さない', () => {
    mount({ desktop: false });
    expect(screen.queryByRole('button', { name: '選択…' })).toBeNull();
  });

  it('断られた理由を出す', () => {
    mount({ error: 'その名前はもう使われています' });
    expect(screen.getByRole('alert')).toHaveTextContent('その名前はもう使われています');
  });
});

describe('AddAccountDialog の Codex', () => {
  const codexBase = { agent: 'codex' as const, primaryDirLabel: '~/.codex' };
  it('題、共有の組、分ける組、注記が Codex のものになる', () => {
    mount(codexBase);
    expect(screen.getByRole('dialog', { name: 'Codex のアカウントを追加' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: /~\/\.codex/ }).querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByText('スキル、プロンプト、プラグイン')).toBeInTheDocument();
    expect(screen.getByText('内部のデータベース')).toBeInTheDocument();
    expect(screen.getByText('次にブラウザが開きます。追加する ChatGPT のアカウントで承認してください。')).toBeInTheDocument();
  });
  it('確かめも追加も agent を付けて送る', () => {
    const { onAction, rerender } = mount(codexBase);
    expect(sent(onAction, 'account.add.preview')).toEqual([{ type: 'account.add.preview', name: '', dir: '', agent: 'codex' }]);
    fireEvent.change(nameField(), { target: { value: '会社用' } });
    rerender({ ...codexBase, preview: preview({ name: '会社用', dir: `${HOME}/.codex-work` }) });
    fireEvent.click(submit());
    expect(sent(onAction, 'account.add')).toEqual([{ type: 'account.add', name: '会社用', dir: `${HOME}/.codex-work`, agent: 'codex' }]);
  });
});
