import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LanguageRoot } from './language.tsx';
import { InfoPopover, Popover, PopoverRows } from './Popover.tsx';

const face = (p: Record<string, unknown>) => <button type="button" {...p}>開く</button>;
const mount = (props: { onOpenChange?: (open: boolean) => void; children?: React.ReactNode } = {}) => {
  const onKeyDown = vi.fn();
  render(
    <div onKeyDown={onKeyDown}>
      <Popover label="属性" face={face} onOpenChange={props.onOpenChange}>{props.children ?? <p>中身</p>}</Popover>
      <input aria-label="ほかの欄" />
    </div>,
  );
  return { opener: screen.getByRole('button', { name: '開く' }), onKeyDown };
};

describe('Popover', () => {
  it('閉じて始まり、開く元を押すと dialog が開く', () => {
    const { opener } = mount();
    expect(opener).toHaveAttribute('aria-haspopup', 'dialog');
    expect(opener).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(opener);
    const pop = screen.getByRole('dialog', { name: '属性' });
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    expect(opener).toHaveAttribute('aria-controls', pop.id);
    expect(pop).toHaveTextContent('中身');
    // 閉じているときは aria-controls を付けない（相手が無い）。
    fireEvent.keyDown(pop, { key: 'Escape' });
    expect(opener).not.toHaveAttribute('aria-controls');
  });
  it('開くと面に焦点が入る。中に data-autofocus の要素があればそこへ入る', () => {
    const { opener } = mount();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toHaveFocus();
    fireEvent.click(opener);
    expect(screen.queryByRole('dialog')).toBeNull();
    render(<Popover label="ノート" face={(p) => <button type="button" {...p}>ノートを開く</button>}><textarea aria-label="本文" data-autofocus /></Popover>);
    fireEvent.click(screen.getByRole('button', { name: 'ノートを開く' }));
    expect(screen.getByRole('textbox', { name: '本文' })).toHaveFocus();
  });
  it('Esc で閉じ、焦点を開いた元へ戻し、外へは伝えない', () => {
    const onOpenChange = vi.fn();
    const { opener, onKeyDown } = mount({ onOpenChange });
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });
  it('焦点が開く元に戻っていても、開いている間は Esc で閉じる', () => {
    const { opener } = mount();
    fireEvent.click(opener);
    opener.focus();
    fireEvent.keyDown(opener, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
  it('外側を押すと閉じ、焦点が行き場を失ったときは開いた元へ戻す', async () => {
    const { opener } = mount();
    fireEvent.click(opener);
    act(() => { fireEvent.mouseDown(document.body); });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
  });
  it('外側で別の欄を押したときは、その欄の焦点を奪わない', async () => {
    const { opener } = mount();
    fireEvent.click(opener);
    const other = screen.getByRole('textbox', { name: 'ほかの欄' });
    act(() => { fireEvent.mouseDown(other); other.focus(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(other).toHaveFocus();
  });
  it('中を押しても閉じない。開く元をもう一度押すと閉じる', () => {
    const { opener } = mount();
    fireEvent.click(opener);
    act(() => { fireEvent.mouseDown(screen.getByText('中身')); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => { fireEvent.mouseDown(opener); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(opener);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('Tab で中の最後を越えたら閉じ、焦点は開く元へ戻して次へ進ませる。途中の Tab では閉じない', () => {
    render(
      <Popover label="2 つ" face={(p) => <button type="button" {...p}>開く</button>}>
        <button type="button">一つ目</button>
        <button type="button">二つ目</button>
      </Popover>,
    );
    const opener = screen.getByRole('button', { name: '開く' });
    fireEvent.click(opener);
    const [a, b] = within(screen.getByRole('dialog')).getAllByRole('button');
    a!.focus();
    fireEvent.keyDown(a!, { key: 'Tab' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    b!.focus();
    fireEvent.keyDown(b!, { key: 'Tab' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
  it('Shift+Tab で中の最初より前へ出たときも閉じる', () => {
    render(<Popover label="1 つ" face={(p) => <button type="button" {...p}>開く</button>}><button type="button">一つ目</button></Popover>);
    const opener = screen.getByRole('button', { name: '開く' });
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
  it('中身は close を受け取れる。押すと閉じて焦点が戻る', () => {
    render(<Popover label="操作" face={(p) => <button type="button" {...p}>開く</button>}>{({ close }) => <button type="button" onClick={close}>閉じる</button>}</Popover>);
    const opener = screen.getByRole('button', { name: '開く' });
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
  it('defaultOpen なら開いて始まる', () => {
    render(<Popover label="最初から" defaultOpen face={(p) => <button type="button" {...p}>開く</button>}><p>中身</p></Popover>);
    expect(screen.getByRole('dialog', { name: '最初から' })).toBeInTheDocument();
  });
});

describe('PopoverRows と InfoPopover', () => {
  it('行を、名前と値の組の一覧で読ませる', () => {
    render(<PopoverRows rows={[{ name: 'モデル', value: 'opus' }, { name: '開始', value: '08:52', mono: true }]} />);
    const term = screen.getByText('モデル');
    expect(term.tagName).toBe('DT');
    expect(term.nextElementSibling).toHaveTextContent('opus');
    expect(screen.getByText('08:52')).toHaveAttribute('data-mono', 'true');
  });
  it('(i) の顔は「詳細」の名前で開き、見出しと行を出す', () => {
    render(<InfoPopover rows={[{ name: 'モデル', value: 'opus' }]} />);
    const opener = screen.getByRole('button', { name: '詳細' });
    expect(opener).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(opener);
    const pop = screen.getByRole('dialog', { name: '詳細' });
    expect(within(pop).getByRole('heading', { name: '詳細' })).toBeInTheDocument();
    expect(pop).toHaveTextContent('opus');
    fireEvent.keyDown(pop, { key: 'Escape' });
    expect(opener).toHaveFocus();
  });
  it('名前は辞書から引く。English では Details', () => {
    render(<LanguageRoot language="en"><InfoPopover rows={[]} /></LanguageRoot>);
    expect(screen.getByRole('button', { name: 'Details' })).toBeInTheDocument();
  });
  it('行のあとに任意の中身（操作の行など）を置ける', () => {
    render(<InfoPopover rows={[{ name: '場所', value: '~/code/web-shop' }]}><button type="button">パスをコピー</button></InfoPopover>);
    fireEvent.click(screen.getByRole('button', { name: '詳細' }));
    expect(screen.getByRole('button', { name: 'パスをコピー' })).toBeInTheDocument();
  });
});
