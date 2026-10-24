import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InfoTip } from './InfoTip.tsx';
import { LanguageRoot } from './language.tsx';
import { liftIn } from './motionKit.ts';
import { SetRow } from './SetRow.tsx';

vi.mock('./motionKit.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('./motionKit.ts')>()), liftIn: vi.fn(() => null) }));
afterEach(() => { vi.mocked(liftIn).mockClear(); });

const mount = () => {
  render(
    <div>
      <h3>言語<InfoTip label="言語">ステータスは英語のままです</InfoTip></h3>
      <input aria-label="ほかの欄" />
    </div>,
  );
  return screen.getByRole('button', { name: '言語の説明' });
};

describe('InfoTip', () => {
  it('閉じて始まり、押すと説明の札が浮かぶ。もう一度押すと閉じる', () => {
    const tip = mount();
    expect(tip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('ステータスは英語のままです')).toBeNull();
    fireEvent.click(tip);
    const pop = screen.getByRole('dialog', { name: '言語の説明' });
    expect(pop).toHaveTextContent('ステータスは英語のままです');
    expect(tip).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(tip);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(tip).toHaveAttribute('aria-expanded', 'false');
  });
  it('ボタンと札を aria-expanded と aria-controls で結ぶ', () => {
    const tip = mount();
    expect(tip).not.toHaveAttribute('aria-controls');
    fireEvent.click(tip);
    const pop = screen.getByRole('dialog');
    expect(pop.id).not.toBe('');
    expect(tip).toHaveAttribute('aria-controls', pop.id);
  });
  it('Esc で閉じ、焦点をボタンへ戻す', () => {
    const tip = mount();
    fireEvent.click(tip);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(tip).toHaveFocus();
  });
  it('外を押すと閉じる。札の中を押しても閉じない', async () => {
    const tip = mount();
    fireEvent.click(tip);
    act(() => { fireEvent.mouseDown(screen.getByText('ステータスは英語のままです')); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => { fireEvent.mouseDown(document.body); });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(tip).toHaveFocus());
  });
  it('開くたびに札を持ち上げる動きを 1 度だけ掛ける', () => {
    const tip = mount();
    fireEvent.click(tip);
    expect(liftIn).toHaveBeenCalledTimes(1);
    expect(liftIn).toHaveBeenCalledWith(screen.getByRole('dialog'));
    fireEvent.click(tip);
    fireEvent.click(tip);
    expect(liftIn).toHaveBeenCalledTimes(2);
  });
  it('札は中身に合わせた幅で、上限を超えない', () => {
    const tip = mount();
    fireEvent.click(tip);
    const pop = screen.getByRole('dialog');
    expect(pop).toHaveClass('info-tip-pop');
    expect(pop.style.width).toBe('max-content');
    expect(pop.style.maxWidth).toBe('440px');
  });
  it('英語では About の名前で読む', () => {
    render(<LanguageRoot language="en"><InfoTip label="Language">Status stays in English.</InfoTip></LanguageRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'About Language' }));
    expect(screen.getByRole('dialog', { name: 'About Language' })).toHaveTextContent('Status stays in English.');
  });
});

describe('SetRow の info', () => {
  it('info を渡すと見出しの横に ⓘ を置き、押すと説明が浮かぶ', () => {
    render(<SetRow title="ターミナル" info="iTerm2 は初回に許可を求めます" control={<button type="button">選ぶ</button>} />);
    const tip = screen.getByRole('button', { name: 'ターミナルの説明' });
    expect(tip.closest('.set-row-t')).toHaveTextContent('ターミナル');
    expect(screen.queryByText('iTerm2 は初回に許可を求めます')).toBeNull();
    fireEvent.click(tip);
    expect(screen.getByRole('dialog', { name: 'ターミナルの説明' })).toHaveTextContent('iTerm2 は初回に許可を求めます');
  });
  it('info が無ければ ⓘ を出さない。desc はそのまま行に出す', () => {
    render(<SetRow title="言語" desc="常に出す文" control={<button type="button">選ぶ</button>} />);
    expect(screen.queryByRole('button', { name: '言語の説明' })).toBeNull();
    expect(document.querySelector('.info-tip')).toBeNull();
    expect(screen.getByText('常に出す文')).toHaveClass('set-row-d');
  });
});
