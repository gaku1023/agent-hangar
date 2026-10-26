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
    expect(chipNames()).toEqual(['web-shop', 'モデル、デフォルト', 'effort レベル、デフォルト', '権限モード、デフォルト', 'worktree、なし', '設定を追加']);
  });
  it('アカウントを渡したときだけ、プロジェクトの次にアカウントの札を出す', () => {
    const { unmount } = render(<Host />);
    expect(screen.queryByRole('button', { name: /^アカウント/ })).toBeNull();
    unmount();
    render(<Host account />);
    expect(chipNames().slice(0, 3)).toEqual(['web-shop', 'アカウント、仕事用', 'モデル、デフォルト']);
  });
  it('既定のままの札は薄く、値のある札は濃く出す', () => {
    render(<Host initial={{ model: 'opus' }} />);
    expect(chip('モデル、opus')).not.toHaveAttribute('data-tone', 'muted');
    expect(chip('effort レベル、デフォルト')).toHaveAttribute('data-tone', 'muted');
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
      const opener = chip('モデル、デフォルト');
      fireEvent.click(opener);
      const pop = screen.getByRole('dialog', { name: 'モデル' });
      expect(opener).toHaveAttribute('aria-expanded', 'true');
      expect(within(pop).getAllByRole('option').map((o) => o.textContent)).toEqual(['デフォルト', 'fable', 'opus', 'sonnet', 'haiku']);
      fireEvent.click(within(pop).getByRole('option', { name: 'sonnet' }));
      expect(onChange).toHaveBeenCalledWith({ model: 'sonnet' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(chip('モデル、sonnet')).toBeInTheDocument();
    });
    it('一覧に無いモデルの名前も打てる。Enter で決めて閉じ、外へは伝えない', () => {
      const onChange = vi.fn();
      const outer = vi.fn();
      render(<Host onChange={onChange} onKeyDown={outer} />);
      fireEvent.click(chip('モデル、デフォルト'));
      const box = screen.getByRole('textbox', { name: 'その他のモデル名' });
      fireEvent.change(box, { target: { value: 'claude-x' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(onChange).toHaveBeenLastCalledWith({ model: 'claude-x' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(outer).not.toHaveBeenCalled();
      expect(chip('モデル、claude-x')).toBeInTheDocument();
    });
    it('一覧に無いモデルの名前は、打つたびに値を渡す。Enter を押さずに閉じても残る', () => {
      const onChange = vi.fn();
      render(<Host onChange={onChange} />);
      fireEvent.click(chip('モデル、デフォルト'));
      fireEvent.change(screen.getByRole('textbox', { name: 'その他のモデル名' }), { target: { value: 'claude-z' } });
      expect(onChange).toHaveBeenLastCalledWith({ model: 'claude-z' });
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'モデル' }), { key: 'Escape' });
      expect(chip('モデル、claude-z')).toBeInTheDocument();
    });
    it('一覧に無い値は、開いたとき欄に入っている', () => {
      render(<Host initial={{ model: 'claude-y' }} />);
      fireEvent.click(chip('モデル、claude-y'));
      expect(screen.getByRole('textbox', { name: 'その他のモデル名' })).toHaveValue('claude-y');
    });
    it('effort レベルは 既定、low、medium、high、xhigh、max', () => {
      const onChange = vi.fn();
      render(<Host onChange={onChange} />);
      fireEvent.click(chip('effort レベル、デフォルト'));
      const pop = screen.getByRole('dialog', { name: 'effort レベル' });
      expect(within(pop).getAllByRole('option').map((o) => o.textContent)).toEqual(['デフォルト', 'low', 'medium', 'high', 'xhigh', 'max']);
      fireEvent.click(within(pop).getByRole('option', { name: 'high' }));
      expect(onChange).toHaveBeenCalledWith({ effort: 'high' });
    });
  });

  describe('権限モード', () => {
    it('札を押すと縦の一覧が開き、選ぶと値を渡して閉じる。一覧に焦点が入る', () => {
      const onChange = vi.fn();
      render(<Host onChange={onChange} previousPermission="acceptEdits" />);
      fireEvent.click(chip('権限モード、デフォルト'));
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
      fireEvent.click(chip('権限モード、デフォルト'));
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
      expect(box).toHaveAttribute('placeholder', '空欄の場合は通常の作業ディレクトリ');
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
      fireEvent.click(chip('設定を追加'));
      expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['名前', '追加ディレクトリ']);
    });
    it('名前を選ぶと名前の札が増え、入力欄が開いて焦点が入る。もう一覧には出ない', () => {
      const onChange = vi.fn();
      render(<Host onChange={onChange} />);
      fireEvent.click(chip('設定を追加'));
      fireEvent.click(screen.getByRole('menuitem', { name: '名前' }));
      expect(chipNames()).toEqual(['web-shop', 'モデル、デフォルト', 'effort レベル、デフォルト', '権限モード、デフォルト', 'worktree、なし', '名前、なし', '設定を追加']);
      const box = screen.getByRole('textbox', { name: '名前' });
      expect(box).toHaveFocus();
      expect(box).toHaveAttribute('placeholder', '一覧での表示名');
      fireEvent.change(box, { target: { value: '決済の検証' } });
      expect(onChange).toHaveBeenLastCalledWith({ name: '決済の検証' });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(chip('名前、決済の検証')).toBeInTheDocument();
      fireEvent.click(chip('設定を追加'));
      expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['追加ディレクトリ']);
    });
    it('両方足したら、「＋」は消える', () => {
      render(<Host />);
      fireEvent.click(chip('設定を追加'));
      fireEvent.click(screen.getByRole('menuitem', { name: '名前' }));
      fireEvent.keyDown(screen.getByRole('textbox', { name: '名前' }), { key: 'Escape' });
      fireEvent.click(chip('設定を追加'));
      fireEvent.click(screen.getByRole('menuitem', { name: '追加ディレクトリ' }));
      expect(screen.queryByRole('button', { name: '設定を追加' })).toBeNull();
      expect(chipNames().slice(-2)).toEqual(['名前、なし', '追加ディレクトリ、なし']);
    });
    it('値が入っているとき（下書き、前回の値）は、はじめから札を出し、「＋」の一覧には出さない', () => {
      render(<Host initial={{ name: '決済の検証', addDirs: '/work/shared\n/work/docs' }} />);
      expect(chipNames().slice(-2)).toEqual(['名前、決済の検証', '追加ディレクトリ、2 件']);
      expect(screen.queryByRole('button', { name: '設定を追加' })).toBeNull();
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
      fireEvent.click(chip('設定を追加'));
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
    it('札と一覧の行に色の点を添える', () => {
      const options = [{ value: 'work', label: '仕事用', color: '#3b6ef5' }, { value: 'home', label: '個人用', color: '#c2410c' }];
      render(<LaunchChips values={BASE} onChange={() => {}} account={{ value: 'work', options, onChange: () => {} }} />);
      const opener = screen.getByRole('button', { name: 'アカウント、仕事用' });
      expect((opener.querySelector('.st-dot') as HTMLElement).style.color).toBe('rgb(59, 110, 245)');
      fireEvent.click(opener);
      const dots = within(screen.getByRole('listbox', { name: 'アカウント' })).getAllByRole('option').map((o) => (o.querySelector('.st-dot') as HTMLElement).style.color);
      expect(dots).toEqual(['rgb(59, 110, 245)', 'rgb(194, 65, 12)']);
    });
    it('選べないアカウントは理由を添え、押しても選べない', () => {
      const onAccount = vi.fn();
      const options = [{ value: 'work', label: '仕事用' }, { value: 'home', label: '個人用', disabled: true, tag: '未ログイン' }];
      render(<LaunchChips values={BASE} onChange={() => {}} account={{ value: 'work', options, onChange: onAccount }} />);
      fireEvent.click(screen.getByRole('button', { name: 'アカウント、仕事用' }));
      const row = screen.getByRole('option', { name: /個人用/ });
      expect(row).toHaveAttribute('aria-disabled', 'true');
      expect(row).toHaveTextContent('未ログイン');
      fireEvent.click(row);
      expect(onAccount).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'アカウント' })).toBeInTheDocument();
    });
  });
});

describe('LaunchChips のエージェント（opencode、ベータ）', () => {
  const OC = { mode: 'build', modes: [{ id: 'build', description: null }], onMode: vi.fn(), model: '', models: [], defaultModel: null, modelReset: false, onModel: vi.fn(), providers: [], pricesAt: null, fetchedAt: 0, reloading: false, onReload: vi.fn(), onManage: vi.fn(), autoApprove: false, onAutoApprove: vi.fn() };
  const agentOf = (b: HTMLElement) => b.getAttribute('data-agent-only');
  it('片方のエージェントだけの札は data-agent-only を持ち、エージェント、プロジェクト、名前、「＋」の札は持たない（切り替えの動きが見分ける）', () => {
    const agent = { value: 'claude-code' as const, onChange: vi.fn(), opencodeNote: null };
    const { unmount } = render(<LaunchChips lead={<button type="button">web-shop</button>} agent={agent} account={{ value: 'work', options: ACCOUNTS, onChange: vi.fn() }} values={{ ...BASE, name: 'n' }} onChange={vi.fn()} />);
    expect(within(group()).getAllByRole('button').map(agentOf)).toEqual([null, null, 'claude-code', 'claude-code', 'claude-code', 'claude-code', 'claude-code', null, null]);
    unmount();
    render(<LaunchChips lead={<button type="button">web-shop</button>} agent={{ ...agent, value: 'opencode' }} opencode={OC} values={{ ...BASE, name: 'n' }} onChange={vi.fn()} />);
    expect(within(group()).getAllByRole('button').map(agentOf)).toEqual([null, null, 'opencode', 'opencode', 'opencode', null]);
  });

  it('一覧の行の頭にエージェントの絵を出す。絵は隣の名前と重ねて読み上げない', () => {
    render(<LaunchChips agent={{ value: 'claude-code', onChange: vi.fn(), opencodeNote: null }} values={BASE} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'エージェント、Claude Code' }));
    const options = within(screen.getByRole('listbox', { name: 'エージェント' })).getAllByRole('option');
    expect(options.map((o) => o.querySelector('.agent-icon')?.getAttribute('data-agent'))).toEqual(['claude-code', 'opencode']);
    expect(options.map((o) => o.querySelector('.agent-icon')?.getAttribute('aria-hidden'))).toEqual(['true', 'true']);
  });

  it('札にも、選んでいるエージェントの絵を名前の左に出す', () => {
    const { rerender } = render(<LaunchChips agent={{ value: 'claude-code', onChange: vi.fn(), opencodeNote: null }} values={BASE} onChange={vi.fn()} />);
    const face = () => screen.getByRole('button', { name: /^エージェント、/ });
    expect(face().querySelector('.agent-icon')?.getAttribute('data-agent')).toBe('claude-code');
    expect(face().querySelector('.agent-icon + .set-chip-value')).toHaveTextContent('Claude Code');
    rerender(<LaunchChips agent={{ value: 'opencode', onChange: vi.fn(), opencodeNote: null }} opencode={OC} values={BASE} onChange={vi.fn()} />);
    expect(face().querySelector('.agent-icon')?.getAttribute('data-agent')).toBe('opencode');
  });
});

describe('LaunchChips の Codex のモデル', () => {
  const model = (id: string, label: string) => ({ id, label, description: `${label} の説明`, efforts: [], defaultEffort: null });
  const MODELS = [model('gpt-6.1-sol', 'GPT-6.1-Sol'), model('gpt-6-luna', 'GPT-6-Luna'), model('gpt-5.6-sol', 'GPT-5.6-Sol'), model('gpt-5.6-luna', 'GPT-5.6-Luna')];
  const mount = (value = '') => render(
    <LanguageRoot language="ja">
      <LaunchChips values={BASE} onChange={() => {}}
        codex={{ model: value, models: MODELS, onModel: () => {}, effort: 'medium', efforts: [], onEffort: () => {}, permission: 'auto', onPermission: () => {} }} />
    </LanguageRoot>,
  );
  it('古い世代を「過去のモデル」に畳み、面は見出しを残して中身を送る', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^モデル、/ }));
    const pop = screen.getByRole('dialog', { name: 'モデル' });
    expect(within(pop).getAllByRole('option').map((o) => o.querySelector('.pick-label')?.textContent)).toEqual(['デフォルト', 'GPT-6.1-Sol', 'GPT-6-Luna']);
    expect(pop.querySelector('.pick-scroll')).toContainElement(within(pop).getByRole('listbox'));
    fireEvent.click(within(pop).getByRole('button', { name: '過去のモデル' }));
    expect(within(pop).getByRole('option', { name: /GPT-5\.6-Luna/ })).toBeInTheDocument();
  });
});
