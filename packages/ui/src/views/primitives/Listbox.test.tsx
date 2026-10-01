import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Listbox } from './Listbox.tsx';
import type { ListboxOption } from './listboxModel.ts';

const few: ListboxOption[] = [{ value: 'a', label: 'alpha', sub: '~/w/alpha' }, { value: 'b', label: 'beta', sub: '~/w/beta' }, { value: 'c', label: 'gamma', sub: '~/x/gamma' }];
const many: ListboxOption[] = Array.from({ length: 9 }, (_, i) => ({ value: `p${i}`, label: `proj-${i}`, sub: i % 2 ? `~/work/p${i}` : `~/home/p${i}` }));

function Harness(props: { options: ListboxOption[]; initial?: string | null; onChange?: (v: string) => void; groups?: { title: string; values: string[] }[]; name?: string }) {
  const [v, setV] = useState<string | null>(props.initial ?? null);
  return <Listbox label="プロジェクト" value={v} options={props.options} groups={props.groups} name={props.name} onChange={(x) => { setV(x); props.onChange?.(x); }} />;
}
const face = () => screen.getByRole('button', { name: 'プロジェクト' });

describe('Listbox の顔', () => {
  it('何も選んでいなければ置き文字、選べば名前を描く', () => {
    const { rerender } = render(<Listbox label="プロジェクト" value={null} options={few} onChange={() => {}} />);
    expect(face()).toHaveTextContent('選んでください');
    expect(face()).toHaveAttribute('aria-haspopup', 'listbox');
    expect(face()).toHaveAttribute('aria-expanded', 'false');
    rerender(<Listbox label="プロジェクト" value="b" options={few} onChange={() => {}} showSubInFace />);
    expect(face()).toHaveTextContent('beta');
    expect(face()).toHaveTextContent('~/w/beta');
  });
  it('faceSub があれば、顔の 2 段目には sub の代わりにそれを描く', () => {
    const opts: ListboxOption[] = [{ value: 'a', label: 'alpha', sub: '説明の文', subKind: 'prose', faceSub: '~/w/alpha/' }];
    render(<Listbox label="プロジェクト" value="a" options={opts} onChange={() => {}} showSubInFace />);
    expect(face()).toHaveTextContent('~/w/alpha/');
    expect(face()).not.toHaveTextContent('説明の文');
  });
  it('name を渡すと、同じ名前の hidden input に値を入れる', () => {
    const { container } = render(<Harness options={few} initial="c" name="projectId" />);
    expect((container.querySelector('input[type="hidden"][name="projectId"]') as HTMLInputElement).value).toBe('c');
  });
});

describe('Listbox の読み上げ', () => {
  it('renderFace の顔でも、選んだ値を説明として読み上げ、隠し要素は顔の外に置く', () => {
    render(<Listbox label="s" value="b" options={few} onChange={() => {}} renderFace={() => <span>custom</span>} />);
    const b = screen.getByRole('button', { name: 's' });
    expect(b).toHaveAccessibleDescription('beta');
    expect([...b.children].map((c) => c.textContent)).toEqual(['custom']);
  });
});

describe('Listbox を開く', () => {
  it('押すと一覧が開き、行は名前で引け、選んだ行に aria-selected が付く', () => {
    render(<Harness options={few} initial="b" />);
    fireEvent.click(face());
    expect(face()).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox', { name: 'プロジェクト' });
    expect(list).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'beta' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'alpha' })).toHaveAttribute('aria-selected', 'false');
  });
  it('行を押すと値を渡して閉じ、フォーカスを顔へ返す', () => {
    const onChange = vi.fn();
    render(<Harness options={few} onChange={onChange} />);
    fireEvent.click(face());
    fireEvent.click(screen.getByRole('option', { name: 'gamma' }));
    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(face()).toHaveFocus();
  });
  it('同じ行を選び直しても値は渡さない', () => {
    const onChange = vi.fn();
    render(<Harness options={few} initial="a" onChange={onChange} />);
    fireEvent.click(face());
    fireEvent.click(screen.getByRole('option', { name: 'alpha' }));
    expect(onChange).not.toHaveBeenCalled();
  });
  it('一覧の外を押すと閉じる', () => {
    render(<Harness options={few} />);
    fireEvent.click(face());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('開いたまま別の一覧の顔を押すと、先の一覧は閉じる', () => {
    render(<><Listbox label="A" value={null} options={few} onChange={() => {}} /><Listbox label="B" value={null} options={few} onChange={() => {}} /></>);
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    const b = screen.getByRole('button', { name: 'B' });
    fireEvent.mouseDown(b);
    fireEvent.click(b);
    expect(screen.getAllByRole('listbox')).toHaveLength(1);
    expect(screen.getByRole('listbox', { name: 'B' })).toBeInTheDocument();
  });
  it('開いたまま顔が消えても、一覧は body に残らない', () => {
    const { unmount } = render(<Harness options={few} />);
    fireEvent.click(face());
    unmount();
    expect(document.querySelector('.listbox-pop')).toBeNull();
  });
});

describe('Listbox のフォーカス', () => {
  // ブラウザは visibility: hidden の要素にフォーカスを当てない。jsdom は見ないので、当てる瞬間の見え方を直接押さえる。
  it.each([['検索欄', many], ['一覧', few]] as const)('%s へのフォーカスは、面が見えてから一度だけ当てる', (_, options) => {
    const seen: string[] = [];
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement) {
      if (this.closest('.listbox-pop')) seen.push((document.querySelector('.listbox-pop') as HTMLElement).style.visibility);
    });
    try {
      render(<Harness options={options} />);
      fireEvent.click(face());
      expect(seen).toEqual(['']);
    } finally { spy.mockRestore(); }
  });
});

describe('Listbox のキーボード', () => {
  it('顔で ↓ を押すと開き、↑ ↓ で移って Enter で決める', () => {
    const onChange = vi.fn();
    render(<Harness options={few} initial="a" onChange={onChange} />);
    fireEvent.keyDown(face(), { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    expect(list).toHaveFocus();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'gamma' }).id);
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('c');
  });
  it('↓ は末尾から先頭へ回り、Home と End で端へ跳ぶ', () => {
    render(<Harness options={few} initial="c" />);
    fireEvent.keyDown(face(), { key: 'Enter' });
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'alpha' }).id);
    fireEvent.keyDown(list, { key: 'End' });
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'gamma' }).id);
    fireEvent.keyDown(list, { key: 'Home' });
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'alpha' }).id);
  });
  it('Esc で閉じて顔へフォーカスを返し、Esc と Enter は親へ伝えない', () => {
    const onParent = vi.fn();
    render(<div onKeyDown={onParent}><Harness options={few} /></div>);
    fireEvent.click(face());
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'Enter' });
    fireEvent.click(face());
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(face()).toHaveFocus();
    expect(onParent).not.toHaveBeenCalled();
  });
  it('顔で押した Enter と ↓ も親へ伝えない（ダイアログを送らない）', () => {
    const onParent = vi.fn();
    render(<div onKeyDown={onParent}><Harness options={few} /></div>);
    fireEvent.keyDown(face(), { key: 'Enter' });
    expect(onParent).not.toHaveBeenCalled();
  });
  it('Tab で閉じる', () => {
    render(<Harness options={few} />);
    fireEvent.click(face());
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('Listbox の検索', () => {
  it('8 件未満では検索欄を出さない', () => {
    render(<Harness options={few} />);
    fireEvent.click(face());
    expect(screen.queryByRole('combobox')).toBeNull();
  });
  it('8 件以上では検索欄に入力が向き、名前と補足で絞れ、一致を塗る', () => {
    render(<Harness options={many} />);
    fireEvent.click(face());
    const box = screen.getByRole('combobox', { name: 'プロジェクトを探す' });
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: 'WORK' } });
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['proj-1', 'proj-3', 'proj-5', 'proj-7']);
    expect(screen.getAllByRole('option')[0]!.querySelector('mark')!.textContent).toBe('work');
  });
  it('一致が無ければ文で知らせ、Enter でも何も選ばない', () => {
    const onChange = vi.fn();
    render(<Harness options={many} onChange={onChange} />);
    fireEvent.click(face());
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('一致するものはありません')).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
  it('変換中の Enter では決めない', () => {
    const onChange = vi.fn();
    render(<Harness options={many} onChange={onChange} />);
    fireEvent.click(face());
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'proj' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('p0');
  });
  it('変換中の Esc は、一覧も外側も閉じない', () => {
    const onParent = vi.fn();
    render(<div onKeyDown={onParent}><Harness options={many} /></div>);
    fireEvent.click(face());
    const box = screen.getByRole('combobox');
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onParent).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
  it('検索欄の aria-activedescendant は選ばれかけの行を指す', () => {
    render(<Harness options={many} />);
    fireEvent.click(face());
    const box = screen.getByRole('combobox');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'proj-1' }).id);
  });
});

describe('Listbox の群', () => {
  it('群の見出しで行を分け、検索で絞る間は見出しを消す', () => {
    const groups = [{ title: '最近', values: ['p3', 'p1'] }, { title: 'すべて', values: ['p0', 'p2', 'p4', 'p5', 'p6', 'p7', 'p8'] }];
    render(<Harness options={many} groups={groups} />);
    fireEvent.click(face());
    const recent = screen.getByRole('group', { name: '最近' });
    expect([...recent.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('aria-label'))).toEqual(['proj-3', 'proj-1']);
    expect(screen.getByRole('group', { name: 'すべて' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'proj-3' } });
    expect(screen.queryByRole('group')).toBeNull();
  });
});

describe('Listbox の変化への追従', () => {
  it('開いている間に選択肢が減っても、Enter で落ちずに残った行を選ぶ', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Listbox label="プロジェクト" value={null} options={few} onChange={onChange} />);
    fireEvent.click(face());
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'End' });
    rerender(<Listbox label="プロジェクト" value={null} options={few.slice(0, 1)} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('a');
  });
  it('窓の大きさが変わると、顔に合わせて置き直す', () => {
    render(<Harness options={few} />);
    const f = face();
    let top = 100;
    f.getBoundingClientRect = () => ({ top, bottom: top + 34, left: 20, width: 300, right: 320, height: 34, x: 20, y: top, toJSON: () => ({}) });
    fireEvent.click(f);
    const pop = document.querySelector('.listbox-pop') as HTMLElement;
    expect(pop.style.top).toBe('140px');
    top = 200;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(pop.style.top).toBe('240px');
  });
});

describe('Listbox の操作', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ value: `p${i}`, label: `proj${i}` }));
  const setup = () => {
    const onChange = vi.fn();
    const onAction = vi.fn();
    render(<Listbox label="場所" value={null} options={[...rows, { value: 'u', label: 'url-short', searchOnly: true, tag: '未登録' }]} onChange={onChange}
      actions={(q) => [{ value: 'new', label: q ? `「${q}」を新しいフォルダとして作る` : '新しいフォルダを作る…', icon: 'folderPlus' }]} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: '場所' }));
    return { onChange, onAction };
  };
  it('下端に操作を出し、語に合わせて名前を変える', () => {
    setup();
    expect(screen.getByRole('option', { name: '新しいフォルダを作る…' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });
    expect(screen.getByRole('option', { name: '「zzz」を新しいフォルダとして作る' })).toHaveAttribute('data-active', 'true');
  });
  it('一致する行が無ければ Enter で最初の操作を選び、onChange は呼ばない', () => {
    const { onChange, onAction } = setup();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith('new', 'zzz');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('矢印キーで行の続きとして操作へ進める', () => {
    const { onAction } = setup();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'url' } });
    expect(screen.getByRole('option', { name: 'url-short' })).toHaveTextContent('未登録');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith('new', 'url');
  });
  it('searchOnly の行は語が無いと出ない', () => {
    setup();
    expect(screen.queryByRole('option', { name: 'url-short' })).toBeNull();
  });
  it('操作は listbox の中にあり、操作に印があるときは combobox の aria-activedescendant が指す', () => {
    setup();
    expect(within(screen.getByRole('listbox')).getByRole('option', { name: '新しいフォルダを作る…' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });
    const active = within(screen.getByRole('listbox')).getByRole('option', { name: '「zzz」を新しいフォルダとして作る' });
    expect(active).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', active.id);
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
  });
  it('操作をクリックすると onAction を呼んで閉じる', () => {
    const { onChange, onAction } = setup();
    fireEvent.click(screen.getByRole('option', { name: '新しいフォルダを作る…' }));
    expect(onAction).toHaveBeenCalledWith('new', '');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
