import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AttachSheet } from './AttachSheet.tsx';

describe('AttachSheet', () => {
  it('写真ライブラリとカメラ（背面）の 2 つと、上限の説明を出す', () => {
    render(<AttachSheet open onClose={vi.fn()} onFiles={vi.fn()} />);
    const dlg = screen.getByRole('dialog', { name: '画像を添付' });
    const lib = within(dlg).getByLabelText(/写真ライブラリ/) as HTMLInputElement;
    const cam = within(dlg).getByLabelText(/写真を撮る/) as HTMLInputElement;
    expect(lib).toHaveAttribute('type', 'file');
    expect(lib).toHaveAttribute('accept', 'image/*');
    expect(lib.multiple).toBe(true);
    expect(lib).not.toHaveAttribute('capture');
    expect(cam).toHaveAttribute('accept', 'image/*');
    expect(cam).toHaveAttribute('capture', 'environment');
    expect(within(dlg).getByText(/1 枚 5 MB まで、4 枚まで/)).toBeInTheDocument();
  });

  it('選んだら画像を渡して閉じる。何も選ばなければ渡さない', () => {
    const onFiles = vi.fn();
    const onClose = vi.fn();
    render(<AttachSheet open onClose={onClose} onFiles={onFiles} />);
    const cam = screen.getByLabelText(/写真を撮る/);
    fireEvent.change(cam, { target: { files: [] } });
    expect(onFiles).not.toHaveBeenCalled();
    const f = new File([new Uint8Array(3)], 'shot.jpg', { type: 'image/jpeg' });
    fireEvent.change(cam, { target: { files: [f] } });
    expect(onFiles).toHaveBeenCalledWith([f]);
    expect(onClose).toHaveBeenCalled();
  });

  it('キャンセルで閉じる', () => {
    const onClose = vi.fn();
    render(<AttachSheet open onClose={onClose} onFiles={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onClose).toHaveBeenCalled();
  });
});
