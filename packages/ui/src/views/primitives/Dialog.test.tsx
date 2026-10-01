import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog.tsx';

const foot = (
  <>
    <button type="button" className="btn">やめる</button>
    <span className="spacer" />
    <button type="button" className="btn btn-primary">進める</button>
  </>
);

describe('Dialog の殻', () => {
  it('器（覆いではなくパネル）が modal なダイアログで、見出しを名前にする', () => {
    const { container } = render(<Dialog title="取り込みますか" footer={foot}>本文</Dialog>);
    const dialog = screen.getByRole('dialog', { name: '取り込みますか' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.classList.contains('dialog')).toBe(true);
    // 見出しを指すので、見える文と読み上げの名前が一致する。
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)).toHaveTextContent('取り込みますか');
    expect(container.querySelector('.overlay')).not.toHaveAttribute('role');
    // 見出し、中身、下端の 3 段で組む。
    expect([...dialog.children].map((c) => c.className)).toEqual(['dialog-head', 'dialog-body', 'dialog-foot']);
  });

  describe('開いたときのフォーカス', () => {
    it('印を付けた要素があればそこへ当てる', () => {
      render(<Dialog title="t" footer={foot}><input aria-label="a" /><input aria-label="b" data-autofocus /></Dialog>);
      expect(screen.getByLabelText('b')).toHaveFocus();
    });
    it('入力のあるダイアログは最初の欄へ当てる', () => {
      render(<Dialog title="t" onClose={() => {}} footer={foot}><button type="button">選ぶ</button><input aria-label="名前" /></Dialog>);
      expect(screen.getByLabelText('名前')).toHaveFocus();
    });
    it('欄が無ければ、下端の最初の安全な操作（主ボタンと危険なボタンではないもの）へ当てる', () => {
      render(<Dialog title="t" footer={<><button type="button" className="btn btn-primary">書き込む</button><button type="button" className="btn">やめる</button></>}>本文</Dialog>);
      expect(screen.getByRole('button', { name: 'やめる' })).toHaveFocus();
    });
    it('操作が何も無ければ器そのものへ当てる', () => {
      render(<Dialog title="キーの一覧">読むだけ</Dialog>);
      expect(screen.getByRole('dialog')).toHaveFocus();
    });
  });

  describe('閉じたときのフォーカス', () => {
    function Harness(props: { onOpenFocus?: () => void }) {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>開く</button>
          <button type="button">ほか</button>
          {open && <Dialog title="t" onClose={() => { props.onOpenFocus?.(); setOpen(false); }} footer={<button type="button" className="btn" onClick={() => setOpen(false)}>やめる</button>}>本文</Dialog>}
        </>
      );
    }
    it('開いた元へ返す', () => {
      render(<Harness />);
      const opener = screen.getByRole('button', { name: '開く' });
      opener.focus();
      fireEvent.click(opener);
      expect(screen.getByRole('button', { name: 'やめる' })).toHaveFocus();
      fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(opener).toHaveFocus();
    });
    it('閉じる前にフォーカスがダイアログの外へ移っていたら、それを奪わない', () => {
      render(<Harness onOpenFocus={() => screen.getByRole('button', { name: 'ほか' }).focus()} />);
      const opener = screen.getByRole('button', { name: '開く' });
      opener.focus();
      fireEvent.click(opener);
      fireEvent.keyDown(screen.getByRole('button', { name: 'やめる' }), { key: 'Escape' });
      expect(screen.getByRole('button', { name: 'ほか' })).toHaveFocus();
    });
  });

  describe('Tab の閉じ込め', () => {
    const body = (
      <>
        <input aria-label="一" />
        <button type="button" tabIndex={-1}>飛ばす</button>
        <details><summary>詳細</summary><input aria-label="畳んだ中" /></details>
      </>
    );
    it('末尾の Tab は先頭へ、先頭の ⇧Tab は末尾へ回る', () => {
      render(<Dialog title="t" onClose={() => {}} footer={foot}>{body}</Dialog>);
      const close = screen.getByRole('button', { name: '閉じる' });
      const last = screen.getByRole('button', { name: '進める' });
      last.focus();
      fireEvent.keyDown(last, { key: 'Tab' });
      expect(close).toHaveFocus();
      fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
      expect(last).toHaveFocus();
    });
    it('途中の Tab はブラウザに任せる', () => {
      render(<Dialog title="t" onClose={() => {}} footer={foot}>{body}</Dialog>);
      const first = screen.getByLabelText('一');
      expect(fireEvent.keyDown(first, { key: 'Tab' })).toBe(true);
    });
    // 畳んだ詳細が器の末尾にあると、中の欄を数えたら最後の止まり先を見誤り、Tab が器の外へ出ていく。
    it('末尾の畳んだ詳細の中は数えず、見出しから先頭へ回る。開けば中を数える', () => {
      render(<Dialog title="t"><input aria-label="一" /><details><summary>詳細</summary><input aria-label="畳んだ中" /></details></Dialog>);
      const summary = screen.getByText('詳細');
      summary.focus();
      fireEvent.keyDown(summary, { key: 'Tab' });
      expect(screen.getByLabelText('一')).toHaveFocus();
      fireEvent.keyDown(screen.getByLabelText('一'), { key: 'Tab', shiftKey: true });
      expect(summary).toHaveFocus();
      (summary.parentElement as HTMLDetailsElement).open = true;
      summary.focus();
      expect(fireEvent.keyDown(summary, { key: 'Tab' })).toBe(true);
    });
    it('畳んだ詳細の中と tabindex=-1 は数えない', () => {
      render(<Dialog title="t" footer={<button type="button" className="btn">最後</button>}>{body}<button type="button" tabIndex={-1}>後ろ</button></Dialog>);
      const last = screen.getByRole('button', { name: '最後' });
      last.focus();
      fireEvent.keyDown(last, { key: 'Tab' });
      expect(screen.getByLabelText('一')).toHaveFocus();
      fireEvent.keyDown(screen.getByLabelText('一'), { key: 'Tab', shiftKey: true });
      expect(last).toHaveFocus();
    });
  });

  describe('Esc', () => {
    it('閉じる手があれば閉じ、既定を止めて Root の Esc と重ねない', () => {
      const onClose = vi.fn();
      render(<Dialog title="t" onClose={onClose} footer={foot}><input aria-label="名前" /></Dialog>);
      const notPrevented = fireEvent.keyDown(screen.getByLabelText('名前'), { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(notPrevented).toBe(false);
    });
    it('閉じる手が無いダイアログは Esc で閉じない', () => {
      render(<Dialog title="決めてください" footer={foot}>本文</Dialog>);
      expect(fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).toBe(true);
    });
    it('変換中の Esc と、中の部品が先に受けた Esc では閉じない', () => {
      const onClose = vi.fn();
      render(<Dialog title="t" onClose={onClose}><input aria-label="名前" onKeyDown={(e) => { if (e.key === 'Escape' && e.shiftKey) e.preventDefault(); }} /></Dialog>);
      fireEvent.keyDown(screen.getByLabelText('名前'), { key: 'Escape', keyCode: 229 });
      fireEvent.keyDown(screen.getByLabelText('名前'), { key: 'Escape', shiftKey: true });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('背景と閉じるボタン', () => {
    it('既定では背景を押すと閉じ、器の中を押しても閉じない', () => {
      const onClose = vi.fn();
      const { container } = render(<Dialog title="t" onClose={onClose}>本文</Dialog>);
      fireEvent.click(screen.getByRole('dialog'));
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(container.querySelector('.overlay')!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    it('入力のあるダイアログは背景を押しても閉じない', () => {
      const onClose = vi.fn();
      const { container } = render(<Dialog title="t" onClose={onClose} closeOnBackdrop={false}><input aria-label="名前" /></Dialog>);
      fireEvent.click(container.querySelector('.overlay')!);
      expect(onClose).not.toHaveBeenCalled();
    });
    it('背景を押してもフォーカスは器の中に残す', () => {
      const { container } = render(<Dialog title="t" onClose={() => {}} closeOnBackdrop={false}><input aria-label="名前" /></Dialog>);
      expect(fireEvent.mouseDown(container.querySelector('.overlay')!)).toBe(false);
    });
    it('閉じる手があれば見出しの右に × を置き、押すと閉じる', () => {
      const onClose = vi.fn();
      render(<Dialog title="t" onClose={onClose}>本文</Dialog>);
      fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    it('下端に「閉じる」があるダイアログは × を外せる', () => {
      render(<Dialog title="t" onClose={() => {}} closeButton={false} footer={<button type="button" className="btn">閉じる</button>}>本文</Dialog>);
      expect(screen.getAllByRole('button', { name: '閉じる' })).toHaveLength(1);
    });
    it('閉じる手が無ければ × を置かない', () => {
      render(<Dialog title="t">本文</Dialog>);
      expect(screen.queryByRole('button', { name: '閉じる' })).toBeNull();
    });
  });

  describe('中身のスクロールの影', () => {
    function scrollable(el: HTMLElement, top: number, client: number, height: number) {
      Object.defineProperty(el, 'scrollTop', { configurable: true, value: top });
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: client });
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: height });
    }
    it('中身が見出しの下をくぐると data-top、続きがあると data-bottom を付ける', () => {
      render(<Dialog title="t" footer={foot}>本文</Dialog>);
      const dialog = screen.getByRole('dialog');
      const body = dialog.querySelector<HTMLElement>('.dialog-body')!;
      expect(dialog).not.toHaveAttribute('data-top');
      scrollable(body, 0, 100, 300);
      fireEvent.scroll(body);
      expect(dialog).not.toHaveAttribute('data-top');
      expect(dialog).toHaveAttribute('data-bottom', 'true');
      scrollable(body, 120, 100, 300);
      fireEvent.scroll(body);
      expect(dialog).toHaveAttribute('data-top', 'true');
      expect(dialog).toHaveAttribute('data-bottom', 'true');
      scrollable(body, 200, 100, 300);
      fireEvent.scroll(body);
      expect(dialog).toHaveAttribute('data-top', 'true');
      expect(dialog).not.toHaveAttribute('data-bottom');
    });
  });

  describe('危険な操作の確認（E1）', () => {
    it('見出しの前に赤い丸のアイコンを置き、説明を見出しの下に添える', () => {
      render(<Dialog title="停止しますか" danger icon="stop" lead="作業中です。" footer={foot}>本文</Dialog>);
      const dialog = screen.getByRole('dialog', { name: '停止しますか' });
      expect(dialog.classList.contains('dialog-danger')).toBe(true);
      expect(dialog.querySelector('.dialog-disc [data-icon="stop"]')).not.toBeNull();
      expect(dialog.querySelector('.dialog-head')).toHaveTextContent('作業中です。');
    });
  });
});
