import { aadFeed, open, seal } from '@agent-hangar/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.tsx';
import { takePairFragment } from '../api.ts';
import * as store from '../store.ts';
import { makeKey } from '../test/fixtures.ts';
import { json, makePairText, WORKER } from '../test/pairText.ts';
import { JoinScreen } from './JoinScreen.tsx';

vi.mock('../store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store.ts')>();
  return { ...actual, savePairing: vi.fn(actual.savePairing), saveKey: vi.fn(actual.saveKey) };
});

const jsQRMock = vi.hoisted(() => vi.fn());
vi.mock('jsqr', () => ({ default: jsQRMock }));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ token: 'tok-9', deviceId: 'phone-9' }, 201));
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  history.replaceState(null, '', '/app/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('JoinScreen', () => {
  it('#pair= で開くと参加の前にフラグメントが消える', async () => {
    const { text } = makePairText();
    history.replaceState(null, '', `/app/#pair=${text}`);
    const got = takePairFragment();
    expect(got).toBe(text);
    expect(location.hash).toBe('');
    expect(location.pathname).toBe('/app/');
    expect(takePairFragment()).toBeNull();
    render(<App pairText={got} />);
    expect(await screen.findByText('このスマホを hangar に接続する')).toBeInTheDocument();
    expect(screen.getByText('hangar.example.workers.dev')).toBeInTheDocument();
    expect(screen.getByText(/QR を出した PC：Mac/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('参加すると savePairing と saveKey が呼ばれ、localStorage に鍵の文字列が残らない', async () => {
    const { text, keyText } = makePairText();
    const onEnter = vi.fn();
    render(<JoinScreen pairText={text} onEnter={onEnter} />);
    fireEvent.change(screen.getByLabelText(/このスマホの名前/), { target: { value: 'スマホ 1' } });
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    expect(await screen.findByText('接続しました')).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${WORKER}/m/join`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-hangar-compat']).toBe('7');
    const body = JSON.parse(init.body as string);
    expect(body.code).toBe('code-1');
    expect(body.device.name).toBe('スマホ 1');
    expect(init.body as string).not.toContain(keyText);

    expect(store.savePairing).toHaveBeenCalledWith({ url: WORKER, token: 'tok-9', deviceId: 'phone-9' });
    expect(store.saveKey).toHaveBeenCalledTimes(1);
    const key = vi.mocked(store.saveKey).mock.calls[0]![0];
    expect(key.extractable).toBe(false);
    for (let i = 0; i < localStorage.length; i++) expect(localStorage.getItem(localStorage.key(i)!)).not.toContain(keyText);
    expect(await store.loadKey()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'あとで（このまま受信箱へ）' }));
    expect(onEnter).toHaveBeenCalledWith({ url: WORKER, token: 'tok-9', deviceId: 'phone-9' }, expect.anything());
  });

  it('つなぐ文字列を貼る欄から参加できる', async () => {
    const { text } = makePairText({ pcName: 'Mac 2' });
    render(<JoinScreen pairText={null} onEnter={vi.fn()} />);
    expect(screen.getByText('このスマホはまだ接続していません')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/接続の文字列/), { target: { value: `  ${WORKER}/app/#pair=${text}\n` } });
    fireEvent.click(screen.getByRole('button', { name: '文字列を読む' }));
    expect(await screen.findByText(/QR を出した PC：Mac 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    expect(await screen.findByText('接続しました')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('読めない文字列は理由を出して留まる', async () => {
    render(<JoinScreen pairText={null} onEnter={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/接続の文字列/), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '文字列を読む' }));
    expect(await screen.findByText(/接続の文字列が読めません/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('使用済み・期限切れの券（401）は「QR を出し直してください」と出す', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'used' }, 401));
    const { text } = makePairText();
    render(<JoinScreen pairText={text} onEnter={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    expect(await screen.findByText('この QR は使えません')).toBeInTheDocument();
    expect(screen.getByText(/QR を出し直してください/)).toBeInTheDocument();
    expect(store.savePairing).not.toHaveBeenCalled();
  });

  it('スマホが 10 台に達していたら（409）外すよう案内する', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'too-many-phones' }, 409));
    const { text } = makePairText();
    render(<JoinScreen pairText={text} onEnter={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    const strip = await screen.findByText(/10 台まで/);
    expect(strip).toHaveClass('m-fade');
  });

  it('鍵は券を使う前（POST /m/join の前）に置く', async () => {
    const { text } = makePairText();
    render(<JoinScreen pairText={text} onEnter={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    await screen.findByText('接続しました');
    expect(vi.mocked(store.saveKey).mock.invocationCallOrder[0]!).toBeLessThan(fetchMock.mock.invocationCallOrder[0]!);
  });

  it('鍵を置けなければ券を使わず、理由を出す', async () => {
    vi.mocked(store.saveKey).mockRejectedValueOnce(new Error('quota'));
    const { text } = makePairText();
    render(<JoinScreen pairText={text} onEnter={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    expect(await screen.findByText(/鍵を置けませんでした/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.savePairing).not.toHaveBeenCalled();
  });

  it('参加に失敗したら、前から置いてあった鍵に戻す', async () => {
    const old = await makeKey();
    await store.saveKey(old);
    const sealed = await seal(old, aadFeed('pc-1'), { n: 1 });
    vi.mocked(store.saveKey).mockClear();
    fetchMock.mockImplementation(async () => json({ error: 'used' }, 401));
    const { text } = makePairText();
    render(<JoinScreen pairText={text} onEnter={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    await screen.findByText('この QR は使えません');
    await waitFor(() => expect(store.saveKey).toHaveBeenCalledTimes(2));
    const back = await store.loadKey();
    expect(await open(back!, aadFeed('pc-1'), sealed)).toEqual({ n: 1 });
  });

  it('カメラで QR を読むと、読めた文字列で参加の流れに入る', async () => {
    const { text } = makePairText({ pcName: 'Mac 3' });
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn(async () => stream) }, configurable: true });
    const origW = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoWidth');
    const origH = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoHeight');
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { get: () => 640, configurable: true });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { get: () => 480, configurable: true });
    const ctx = { drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })) };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    jsQRMock.mockReturnValueOnce({ data: 'https://other.example/no-pair-here' }).mockReturnValue({ data: `${WORKER}/app/#pair=${text}` });
    try {
      render(<JoinScreen pairText={null} onEnter={vi.fn()} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'カメラで QR を読む' }));
      });
      expect(await screen.findByText(/QR を出した PC：Mac 3/, undefined, { timeout: 3000 })).toBeInTheDocument();
      expect(jsQRMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      await waitFor(() => expect(stop).toHaveBeenCalled());
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      play.mockRestore();
      getContext.mockRestore();
      if (origW) Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', origW);
      if (origH) Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', origH);
    }
  });
});
