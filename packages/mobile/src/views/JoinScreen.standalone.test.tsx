import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePairText } from '../test/pairText.ts';
import { JoinScreen } from './JoinScreen.tsx';

const scanQr = vi.hoisted(() => vi.fn());
vi.mock('../scanQr.ts', () => ({ scanQr }));

function standalone(on: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('standalone'), addEventListener() {}, removeEventListener() {} }));
}

beforeEach(() => {
  localStorage.clear();
  scanQr.mockReset();
  scanQr.mockImplementation((_el: HTMLVideoElement, signal: AbortSignal) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new DOMException('abort', 'AbortError')))));
});

afterEach(() => vi.unstubAllGlobals());

describe('JoinScreen のホーム画面のアプリ', () => {
  it('QR の読み取りを先に出し、貼る欄も残す', async () => {
    standalone(true);
    const { container } = render(<JoinScreen pairText={null} onEnter={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'PC の QR を読み取ります' })).toBeInTheDocument();
    expect(screen.getByText('QR は表示してから 5 分有効です。')).toBeInTheDocument();
    expect(screen.queryByText(/枠に合わせて/)).not.toBeInTheDocument();
    await waitFor(() => expect(scanQr).toHaveBeenCalledTimes(1));
    expect(container.querySelector('video')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'カメラで QR を読む' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/接続コード/)).toBeInTheDocument();
  });

  it('読めた文字列で接続の確認に進む', async () => {
    standalone(true);
    const { text } = makePairText({ pcName: 'Mac 7' });
    scanQr.mockResolvedValueOnce(text);
    render(<JoinScreen pairText={null} onEnter={vi.fn()} />);
    expect(await screen.findByText(/QR を表示した PC：Mac 7/)).toBeInTheDocument();
  });

  it('カメラが使えないときは理由を出し、貼る欄と読み直しのボタンが残る', async () => {
    standalone(true);
    scanQr.mockRejectedValueOnce(new Error('denied'));
    render(<JoinScreen pairText={null} onEnter={vi.fn()} />);
    expect(await screen.findByText(/カメラを使えませんでした/)).toBeInTheDocument();
    expect(screen.getByLabelText(/接続コード/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'カメラで QR を読む' })).toBeInTheDocument();
  });

  it('ホーム画面のアプリでなければ、ボタンを押すまでカメラを開かない', () => {
    standalone(false);
    render(<JoinScreen pairText={null} onEnter={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'カメラで QR を読む' })).toBeInTheDocument();
    expect(scanQr).not.toHaveBeenCalled();
  });
});
