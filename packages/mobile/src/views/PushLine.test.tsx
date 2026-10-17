import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as push from '../push.ts';
import { WORKER } from '../test/pairText.ts';
import { PushLine } from './PushLine.tsx';

vi.mock('../push.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../push.ts')>();
  return { ...actual, readPushStatus: vi.fn(), turnOnPush: vi.fn(), turnOffPush: vi.fn() };
});

const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };
const read = vi.mocked(push.readPushStatus);
const on = vi.mocked(push.turnOnPush);
const off = vi.mocked(push.turnOffPush);

beforeEach(() => {
  read.mockResolvedValue({ kind: 'off' });
  on.mockResolvedValue({ kind: 'on' });
  off.mockResolvedValue({ kind: 'off' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('PushLine', () => {
  it('オフなら「通知：オフ」と「通知を受け取る」', async () => {
    render(<PushLine pairing={pairing} />);
    expect(await screen.findByText('通知：オフ')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '通知を受け取る' })).toBeEnabled();
    expect(read).toHaveBeenCalledWith(pairing);
  });

  it('「通知を受け取る」でオンになり、夜は鳴らさない旨と「通知を止める」', async () => {
    render(<PushLine pairing={pairing} />);
    fireEvent.click(await screen.findByRole('button', { name: '通知を受け取る' }));
    expect(on).toHaveBeenCalledWith(pairing);
    expect(await screen.findByText('通知：オン（23:00〜7:00 は鳴らしません）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '通知を止める' }));
    expect(off).toHaveBeenCalledWith(pairing);
    expect(await screen.findByText('通知：オフ')).toBeInTheDocument();
  });

  it('押している間はボタンを押せない', async () => {
    let done!: (s: push.PushStatus) => void;
    on.mockReturnValue(new Promise((r) => (done = r)));
    render(<PushLine pairing={pairing} />);
    const btn = await screen.findByRole('button', { name: '通知を受け取る' });
    fireEvent.click(btn);
    expect(btn).toBeDisabled();
    await act(async () => done({ kind: 'on' }));
    expect(screen.getByRole('button', { name: '通知を止める' })).toBeEnabled();
  });

  it('使えないブラウザでは「このブラウザでは通知を使えません」でボタンを出さない', async () => {
    read.mockResolvedValue({ kind: 'unsupported', ios: false });
    render(<PushLine pairing={pairing} />);
    expect(await screen.findByText('このブラウザでは通知を使えません')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/ホーム画面/)).toBeNull();
  });

  it('iPhone ではホーム画面に追加した hangar で使える旨を添える', async () => {
    read.mockResolvedValue({ kind: 'unsupported', ios: true });
    render(<PushLine pairing={pairing} />);
    expect(await screen.findByText('このブラウザでは通知を使えません')).toBeInTheDocument();
    expect(screen.getByText(/ホーム画面に追加した hangar/)).toBeInTheDocument();
  });

  it('拒否してあれば、設定で許可する旨', async () => {
    read.mockResolvedValue({ kind: 'denied' });
    render(<PushLine pairing={pairing} />);
    expect(await screen.findByText('通知：オフ')).toBeInTheDocument();
    expect(screen.getByText(/通知が許可されていません/)).toBeInTheDocument();
  });

  it('設定できなければ理由を出し、オフのまま', async () => {
    on.mockRejectedValue(new push.PushError('network'));
    render(<PushLine pairing={pairing} />);
    fireEvent.click(await screen.findByRole('button', { name: '通知を受け取る' }));
    expect(await screen.findByText(/通知を設定できませんでした/)).toBeInTheDocument();
    expect(screen.getByText('通知：オフ')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '通知を受け取る' })).toBeEnabled();
  });

  it('見えたときに読み直す', async () => {
    render(<PushLine pairing={pairing} />);
    await screen.findByText('通知：オフ');
    read.mockResolvedValue({ kind: 'on' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByText(/通知：オン/)).toBeInTheDocument();
  });
});
