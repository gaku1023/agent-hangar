import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LaunchChips, type LaunchChipValues } from './LaunchChips.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const BASE: LaunchChipValues = { model: '', effort: '', permissionMode: '', worktree: '', name: '', addDirs: '' };
const ACCOUNTS = [{ value: 'work', label: '仕事用' }, { value: 'home', label: '個人用' }];

function Host(props: { initial?: Partial<LaunchChipValues>; onChange?: (patch: Partial<LaunchChipValues>) => void; previousPermission?: string; account?: boolean; onKeyDown?: () => void }) {
  const [values, setValues] = useState<LaunchChipValues>({ ...BASE, ...props.initial });
  const [account, setAccount] = useState('work');
  return (
    <div onKeyDown={props.onKeyDown}>
      <LaunchChips
        lead={<button type="button">web-shop</button>}
        account={props.account ? { value: account, options: ACCOUNTS, onChange: setAccount } : undefined}
        values={values}
        previousPermission={props.previousPermission}
        onChange={(patch) => { props.onChange?.(patch); setValues((v) => ({ ...v, ...patch })); }}
      />
    </div>
  );
}

const group = () => screen.getByRole('group', { name: '起動の設定' });
const chip = (name: string) => within(group()).getByRole('button', { name });
const chipNames = () => within(group()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.getAttribute('title') ?? b.textContent);

describe('LaunchChips（札の列）', () => {
  it('プロジェクトの札、モデル、effort レベル、権限モード、worktree、「＋」の順に並べる', () => {
    render(<Host />);
    expect(chipNames()).toEqual(['web-shop', 'モデル、既定', 'effort レベル、既定', '権限モード、既定', 'worktree、なし', '札を足す']);
  });
  it('アカウントを渡したときだけ、プロジェクトの次にアカウントの札を出す', () => {
    const { unmount } = render(<Host />);
    expect(screen.queryByRole('button', { name: /^アカウント/ })).toBeNull();
    unmount();
    render(<Host account />);
    expect(chipNames().slice(0, 3)).toEqual(['web-shop', 'アカウント、仕事用', 'モデル、既定']);
  });
  it('既定のままの札は薄く、値のある札は濃く出す', () => {
    render(<Host initial={{ model: 'opus' }} />);
    expect(chip('モデル、opus')).not.toHaveAttribute('data-tone', 'muted');
    expect(chip('effort レベル、既定')).toHaveAttribute('data-tone', 'muted');
    expect(chip('worktree、なし')).toHaveAttribute('data-tone', 'muted');
  });
  it('名前を札に見せる（モデル opus、権限モード Accept edits）', () => {
    render(<Host initial={{ model: 'opus', permissionMode: 'acceptEdits' }} />);
    expect(chip('モデル、opus')).toHaveTextContent('モデルopus');
    expect(chip('権限モード、Accept edits')).toHaveTextContent('権限モードAccept edits');
  });
  it('English では札の名前と既定が替わり、権限モードの名前は替わらない', () => {
    render(<LanguageRoot language="en"><Host initial={{ permissionMode: 'plan' }} /></LanguageRoot>);
    expect(within(screen.getByRole('group', { name: 'Launch settings' })).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.getAttribute('title') ?? b.textContent))
      .toEqual(['web-shop', 'Model: Default', 'Effort level: Default', 'Permission mode: Plan', 'worktree: None', 'Add a setting']);
  });

  describe('モデルと effort レベル', () => {
    it('モデルの札を押すと一覧が開き、選ぶと値を渡して閉じる', () => {
      const onChange = vi.fn();
      render(<Host onChange={onChange} />);
      const opener = chip('モデル、既定');
      fireEvent.click(opener);
      const pop = screen.getByRole('dialog', { name: 'モデル' });
      expect(opener).toHaveAttribute('aria-expanded', 'true');
      expect(within(pop).getAllByRole('option').map((o) => o.textContent)).toEqual(['既定', 'fable', 'opus', 'sonnet', 'haiku']);
      fireEvent.click(within(pop).getByRole('option', { name: 'sonnet' }));
      expect(onChange).toHaveBeenCalledWith({ model: 'sonnet' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(chip('モデル、sonnet')).toBeInTheDocument();
    });
    it('一覧に無いモデルの名前も打てる。Enter で決めて閉じ、外へは伝えない', () => {
      const onChange = vi.fn();
      const outer = vi.fn();
      render(<Host onChange={onChange} onKeyDown={outer} />);
      fireEvent.click(chip('モデル、既定'));
      const box = screen.getByRole('textbox', { name: 'ほかのモデルの名前' });
      fireEvent.change(box, { target: { value: 'claude-x' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(onChange).toHaveBeenLastCalledWith({ model: 'claude-x' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(outer).not.toHaveBeenCalled();
      expect(chip('モデル、claude-x')).toBeInTheDocument();
    });
    it('一覧に無い値は、開いたとき欄に入っている', () => {
      render(<Host initial={{ model: 'claude-y' }} />);
      fireEvent.click(chip('モデル、claude-y'));
      expect(screen.getByRole('textbox', { name: 'ほかのモデルの名前' })).toHaveValue('claude-y');
    });
    it('effort レベルは 既定、low、medium、high、xhigh、max', () => {
      const onChange = vi.fn();
      render(<Host onChange={onChange} />);
      fireEvent.click(chip('effort レベル、既定'));
      const pop = screen.getByRole('dialog', { name: 'effort レベル' });
      expect(within(pop).getAllByRole('option').map((o) => o.textContent)).toEqual(['既定', 'low', 'medium', 'high', 'xhigh', 'max']);
      fireEvent.click(within(pop).getByRole('option', { name: 'high' }));
      expect(onChange).toHaveBeenCalledWith({ effort: 'high' });
    });
  });

  describe('権限モード', () => {
    it('札を押すと縦の一覧が開き、選ぶと値を渡して閉じる。一覧に焦点が入る', () => {
      const onChange = vi.fn();
      render(<Host onChange={onChange} previousPermission="acceptEdits" />);
      fireEvent.click(chip('権限モード、既定'));
      const pop = screen.getByRole('dialog', { name: '権限モード' });
      const list = within(pop).getByRole('listbox', { name: '権限モード' });
      expect(list).toHaveFocus();
      expect(within(list).getByRole('option', { name: /Accept edits/ })).toHaveTextContent('前回');
      fireEvent.keyDown(list, { key: 'ArrowDown' });
      fireEvent.keyDown(list, { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith({ permissionMode: 'plan' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(chip('権限モード、Plan')).toHaveFocus();
    });
    it('Bypass permissions を選ぶと、札が赤い縁と警告の印になる。確認のダイアログは出さない', () => {
      render(<Host />);
      fireEvent.click(chip('権限モード、既定'));
      fireEvent.click(screen.getByRole('option', { name: /Bypass permissions/ }));
      const c = chip('権限モード、Bypass permissions');
      expect(c).toHaveAttribute('data-tone', 'danger');
      expect(c.querySelector('[data-icon="warning"]')).not.toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    it('Bypass permissions から別の値へ戻すと、赤い印は外れる', () => {
      render(<Host initial={{ permissionMode: 'bypassPermissions' }} />);
      fireEvent.click(chip('権限モード、Bypass permissions'));
      fireEvent.click(screen.getByRole('option', { name: 'Plan' }));
      expect(chip('権限モード、Plan')).not.toHaveAttribute('data-tone', 'danger');
    });
  });

  describe('worktree', () => {
    it('札を押すと入力欄が開き、打つたびに値を渡す。Enter で閉じる', () => {
      const onChange = vi.fn();
      const outer = vi.fn();
      render(<Host onChange={onChange} onKeyDown={outer} />);
      fireEvent.click(chip('worktree、なし'));
      const box = screen.getByRole('textbox', { name: 'worktree' });
      expect(box).toHaveFocus();
      expect(box).toHaveAttribute('placeholder', '空なら通常の作業ディレクトリ');
      fireEvent.change(box, { target: { value: 'fix-login' } });
      expect(onChange).toHaveBeenLastCalledWith({ worktree: 'fix-login' });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(outer).not.toHaveBeenCalled();
      expect(chip('worktree、fix-login')).toBeInTheDocument();
    });
    it('日本語入力の変換を確定する Enter では閉じない', () => {
      render(<Host />);
      fireEvent.click(chip('worktree、なし'));
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'worktree' }), { key: 'Enter', keyCode: 229 });
      expect(screen.getByRole('dialog', { name: 'worktree' })).toBeInTheDocument();
    });
  });

  describe('「＋」で足せる札（名前、追加ディレクトリ）', () => {
    it('「＋」を押すと、まだ出ていない札が一覧に並ぶ', () => {
      render(<Host />);
      fireEvent.click(chip('札を足す'));
      expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['名前', '追加ディレクトリ']);
    });
    it('名前を選ぶと名前の札が増え、入力欄が開いて焦点が入る。もう一覧には出ない', () => {
      const onChange = vi.fn();
      render(<Host onChange={onChange} />);
      fireEvent.click(chip('札を足す'));
      fireEvent.click(screen.getByRole('menuitem', { name: '名前' }));
      expect(chipNames()).toEqual(['web-shop', 'モデル、既定', 'effort レベル、既定', '権限モード、既定', 'worktree、なし', '名前、なし', '札を足す']);
      const box = screen.getByRole('textbox', { name: '名前' });
      expect(box).toHaveFocus();
      expect(box).toHaveAttribute('placeholder', '一覧での表示名');
      fireEvent.change(box, { target: { value: '決済の検証' } });
      expect(onChange).toHaveBeenLastCalledWith({ name: '決済の検証' });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(chip('名前、決済の検証')).toBeInTheDocument();
      fireEvent.click(chip('札を足す'));
      expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['追加ディレクトリ']);
    });
    it('両方足したら、「＋」は消える', () => {
      render(<Host />);
      fireEvent.click(chip('札を足す'));
      fireEvent.click(screen.getByRole('menuitem', { name: '名前' }));
      fireEvent.keyDown(screen.getByRole('textbox', { name: '名前' }), { key: 'Escape' });
      fireEvent.click(chip('札を足す'));
      fireEvent.click(screen.getByRole('menuitem', { name: '追加ディレクトリ' }));
      expect(screen.queryByRole('button', { name: '札を足す' })).toBeNull();
      expect(chipNames().slice(-2)).toEqual(['名前、なし', '追加ディレクトリ、なし']);
    });
    it('値が入っているとき（下書き、前回の値）は、はじめから札を出し、「＋」の一覧には出さない', () => {
      render(<Host initial={{ name: '決済の検証', addDirs: '/work/shared\n/work/docs' }} />);
      expect(chipNames().slice(-2)).toEqual(['名前、決済の検証', '追加ディレクトリ、2 件']);
      expect(screen.queryByRole('button', { name: '札を足す' })).toBeNull();
    });
    it('あとから値が入った（下書きを戻した、前回の値に入れ替えた）ときも、札が出る', () => {
      function Late() {
        const [values, setValues] = useState(BASE);
        return (
          <>
            <button type="button" onClick={() => setValues({ ...BASE, addDirs: '/work/shared' })}>入れ替える</button>
            <LaunchChips values={values} onChange={() => {}} />
          </>
        );
      }
      render(<Late />);
      expect(screen.queryByRole('button', { name: /^追加ディレクトリ/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '入れ替える' }));
      expect(chip('追加ディレクトリ、1 件')).toBeInTheDocument();
      // 値が空に戻っても、札は消さない（打っている途中で札が消えないため）。
    });
    it('値を消しても札は残る', () => {
      render(<Host initial={{ name: 'a' }} />);
      fireEvent.click(chip('名前、a'));
      fireEvent.change(screen.getByRole('textbox', { name: '名前' }), { target: { value: '' } });
      expect(chip('名前、なし')).toBeInTheDocument();
    });
    it('追加ディレクトリの欄は 1 行に 1 つで、打つたびに値を渡す。札には件数を出す', () => {
      const onChange = vi.fn();
      render(<Host onChange={onChange} />);
      fireEvent.click(chip('札を足す'));
      fireEvent.click(screen.getByRole('menuitem', { name: '追加ディレクトリ' }));
      const box = screen.getByRole('textbox', { name: '追加ディレクトリ' });
      expect(box).toHaveFocus();
      expect(screen.getByText('1 行に 1 つ')).toBeInTheDocument();
      fireEvent.change(box, { target: { value: '/work/a\n/work/b\n' } });
      expect(onChange).toHaveBeenLastCalledWith({ addDirs: '/work/a\n/work/b\n' });
      // 空行は数えない。
      expect(chip('追加ディレクトリ、2 件')).toBeInTheDocument();
    });
    it('追加ディレクトリの欄では Enter は改行で、閉じも起動もしない', () => {
      const outer = vi.fn();
      render(<Host initial={{ addDirs: '/work/a' }} onKeyDown={outer} />);
      fireEvent.click(chip('追加ディレクトリ、1 件'));
      const box = screen.getByRole('textbox', { name: '追加ディレクトリ' });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(screen.getByRole('dialog', { name: '追加ディレクトリ' })).toBeInTheDocument();
      // 起動のダイアログは textarea の Enter を見送るので、ここで止める必要は無い。伝わってよい。
      expect(outer).toHaveBeenCalled();
    });
  });

  describe('アカウント', () => {
    it('札を押すと一覧が開き、選ぶと値を渡す', () => {
      const onAccount = vi.fn();
      render(<LaunchChips values={BASE} onChange={() => {}} account={{ value: 'work', options: ACCOUNTS, onChange: onAccount }} />);
      fireEvent.click(screen.getByRole('button', { name: 'アカウント、仕事用' }));
      const pop = screen.getByRole('dialog', { name: 'アカウント' });
      expect(within(pop).getByRole('option', { name: '仕事用' })).toHaveAttribute('aria-selected', 'true');
      fireEvent.click(within(pop).getByRole('option', { name: '個人用' }));
      expect(onAccount).toHaveBeenCalledWith('home');
    });
  });
});
