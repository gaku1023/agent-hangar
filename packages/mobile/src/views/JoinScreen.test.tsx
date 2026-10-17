import { COMPAT_VERSION, generatePhoneKeyPair, isPhonePub, openPhoneJoinRequest, sealPhoneKeybox, toBase64Url } from '@agent-hangar/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.tsx';
import { takePairFragment } from '../api.ts';
import * as store from '../store.ts';
import { json, makePairText, WORKER } from '../test/pairText.ts';
import { JoinScreen } from './JoinScreen.tsx';

vi.mock('../store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store.ts')>();
  return { ...actual, savePairing: vi.fn(actual.savePairing), savePhonePair: vi.fn(actual.savePhonePair) };
});

const jsQRMock = vi.hoisted(() => vi.fn());
vi.mock('jsqr', () => ({ default: jsQRMock }));

/** 試験の待ちの間隔（本物は 2 秒ごとに 60 秒）。 */
const FAST = { everyMs: 10, giveUpMs: 200 };

let fetchMock: ReturnType<typeof vi.fn>;
/** POST /m/join の本文。 */
let joins: { code: string; deviceId: string; sealed: string }[];
/** PC が keybox を置いたか。 */
let keyboxReady: boolean;
/** 409 device-exists を返す回数。 */
let takenTimes: number;

/** 偽の Worker。keybox は、そのとき手元に置いてある鍵ペアの公開鍵に、最後に接続した ID 宛てで封じる。 */
async function worker(url: string, init?: RequestInit): Promise<Response> {
  if (url.endsWith('/m/join')) {
    const body = JSON.parse(init!.body as string) as { code: string; deviceId: string; sealed: string };
    joins.push(body);
    if (takenTimes > 0) {
      takenTimes--;
      return json({ error: 'device-exists' }, 409);
    }
    return json({ token: 'tok-9', deviceId: body.deviceId }, 201);
  }
  if (url.endsWith('/m/keybox')) {
    if (!keyboxReady) return json({ error: 'not found' }, 404);
    const pair = await store.loadPhonePair();
    const m = globalThis.crypto.getRandomValues(new Uint8Array(32));
    return json({ epoch: 1, sealed: toBase64Url(await sealPhoneKeybox(pair!.pub, joins.at(-1)!.deviceId, 1, m)) });
  }
  return json({ error: 'not found' }, 404);
}

const joinCalls = (): number => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/m/join')).length;

beforeEach(async () => {
  joins = [];
  keyboxReady = true;
  takenTimes = 0;
  fetchMock = vi.fn(worker);
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  await store.clearPairing();
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
    expect(screen.getByText(/QR を表示した PC：Mac/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('参加すると、公開鍵と名前を券で封じて送り、keybox を開いて M を置く。秘密鍵は取り出せない', async () => {
    const { text } = makePairText();
    const onEnter = vi.fn();
    render(<JoinScreen pairText={text} onEnter={onEnter} wait={FAST} />);
    fireEvent.change(screen.getByLabelText(/このスマホの名前/), { target: { value: 'スマホ 1' } });
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    expect(await screen.findByText('接続しました')).toBeInTheDocument();

    expect(joinCalls()).toBe(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${WORKER}/m/join`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-hangar-compat']).toBe(String(COMPAT_VERSION));
    const body = joins[0]!;
    expect(Object.keys(body).sort()).toEqual(['code', 'deviceId', 'sealed']);
    expect(body.code).toBe('code-1');
    expect(body.deviceId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    const pair = await store.loadPhonePair();
    expect(await openPhoneJoinRequest('code-1', body.deviceId, body.sealed)).toEqual({ pub: pair!.pub, name: 'スマホ 1' });
    // 名前は封の中だけにある。
    expect(init.body as string).not.toContain('スマホ 1');

    expect(pair!.key.extractable).toBe(false);
    expect(pair!.key.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' });
    expect(isPhonePub(pair!.pub)).toBe(true);
    await expect(globalThis.crypto.subtle.exportKey('pkcs8', pair!.key)).rejects.toThrow();
    const keys = await store.loadPhoneKeys();
    expect([...keys.keys()]).toEqual([1]);
    expect(keys.get(1)!.extractable).toBe(false);

    const pairing = { url: WORKER, token: 'tok-9', deviceId: body.deviceId };
    expect(store.savePairing).toHaveBeenCalledWith(pairing);
    fireEvent.click(screen.getByRole('button', { name: 'あとで（このまま受信箱へ）' }));
    expect(onEnter).toHaveBeenCalledWith(pairing, expect.objectContaining({ pub: pair!.pub }), expect.any(Map));
  });

  it('PC が keybox を置くまで待ちの画面を出し、置かれたら接続を終える', async () => {
    keyboxReady = false;
    const { text } = makePairText({ pcName: 'Mac 5' });
    render(<JoinScreen pairText={text} onEnter={vi.fn()} wait={{ everyMs: 10, giveUpMs: 60_000 }} />);
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    expect(await screen.findByRole('heading', { name: 'PC の応答を待っています' })).toBeInTheDocument();
    expect(screen.getByText(/Mac 5/)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/m/keybox')).length).toBeGreaterThan(1));
    keyboxReady = true;
    expect(await screen.findByText('接続しました')).toBeInTheDocument();
    expect(joinCalls()).toBe(1);
  });

  it('待っても keybox が置かれなければ理由を出し、「もう一度待つ」で券を使わずに待ち直す', async () => {
    keyboxReady = false;
    const { text } = makePairText();
    render(<JoinScreen pairText={text} onEnter={vi.fn()} wait={FAST} />);
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    expect(await screen.findByText('受信中…（最大 1 分）')).toBeInTheDocument();
    expect(await screen.findByText(/PC から応答がありません/)).toBeInTheDocument();
    // 別の QR で接続し直しても、今の接続は PC の一覧から消えない。
    expect(screen.getByText('別の QR で接続しても、今の接続は PC の設定 › クラウド で解除するまで削除されません。')).toBeInTheDocument();
    keyboxReady = true;
    fireEvent.click(screen.getByRole('button', { name: 'もう一度待つ' }));
    expect(await screen.findByText('接続しました')).toBeInTheDocument();
    expect(joinCalls()).toBe(1);
  });

  it('同じ ID のスマホが既にある（409 device-exists）ときは、別の ID で同じ券を出し直す', async () => {
    takenTimes = 1;
    const { text } = makePairText();
    render(<JoinScreen pairText={text} onEnter={vi.fn()} wait={FAST} />);
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    expect(await screen.findByText('接続しました')).toBeInTheDocument();
    expect(joins).toHaveLength(2);
    expect(joins[1]!.code).toBe(joins[0]!.code);
    expect(joins[1]!.deviceId).not.toBe(joins[0]!.deviceId);
    // 封は出し直す ID で封じ直す（AAD に ID が入る）。
    expect((await openPhoneJoinRequest('code-1', joins[1]!.deviceId, joins[1]!.sealed)).pub).toBe((await store.loadPhonePair())!.pub);
    await expect(openPhoneJoinRequest('code-1', joins[1]!.deviceId, joins[0]!.sealed)).rejects.toThrow();
  });

  it('接続コードを貼り付ける欄から参加できる', async () => {
    const { text } = makePairText({ pcName: 'Mac 2' });
    render(<JoinScreen pairText={null} onEnter={vi.fn()} wait={FAST} />);
    expect(screen.getByText('このスマホはまだ接続していません')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/接続コード/), { target: { value: `  ${WORKER}/app/#pair=${text}\n` } });
    fireEvent.click(screen.getByRole('button', { name: 'コードを読み取る' }));
    expect(await screen.findByText(/QR を表示した PC：Mac 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    expect(await screen.findByText('接続しました')).toBeInTheDocument();
    expect(joinCalls()).toBe(1);
  });

  it('読み取れない接続コードは理由を出して留まる', async () => {
    render(<JoinScreen pairText={null} onEnter={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/接続コード/), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'コードを読み取る' }));
    expect(await screen.findByText(/接続コードを読み取れません/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('使用済み・期限切れの券（401）は「QR を表示し直してください」と表示する', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'used' }, 401));
    const { text } = makePairText();
    render(<JoinScreen pairText={text} onEnter={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    expect(await screen.findByText('この QR は使えません')).toBeInTheDocument();
    expect(screen.getByText(/QR を表示し直してください/)).toBeInTheDocument();
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

  it('鍵ペアは券を使う前（POST /m/join の前）に置く', async () => {
    const { text } = makePairText();
    render(<JoinScreen pairText={text} onEnter={vi.fn()} wait={FAST} />);
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    await screen.findByText('接続しました');
    expect(vi.mocked(store.savePhonePair).mock.invocationCallOrder[0]!).toBeLessThan(fetchMock.mock.invocationCallOrder[0]!);
  });

  it('キーを保存できなければ券を使わず、理由を出す', async () => {
    vi.mocked(store.savePhonePair).mockRejectedValueOnce(new Error('quota'));
    const { text } = makePairText();
    render(<JoinScreen pairText={text} onEnter={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    expect(await screen.findByText(/キーを保存できませんでした/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.savePairing).not.toHaveBeenCalled();
  });

  it('参加に失敗したら、前から置いてあった鍵ペアに戻す', async () => {
    const old = await generatePhoneKeyPair();
    await store.savePhonePair(old);
    vi.mocked(store.savePhonePair).mockClear();
    fetchMock.mockImplementation(async () => json({ error: 'used' }, 401));
    const { text } = makePairText();
    render(<JoinScreen pairText={text} onEnter={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '接続する' }));
    await screen.findByText('この QR は使えません');
    await waitFor(() => expect(store.savePhonePair).toHaveBeenCalledTimes(2));
    expect((await store.loadPhonePair())!.pub).toBe(old.pub);
  });

  it('接続の期限が切れて戻ったときは、その旨と次の手順を出す', () => {
    render(<JoinScreen pairText={null} onEnter={vi.fn()} notice="expired" />);
    expect(screen.getByText('接続の期限が切れました。PC で QR を出して接続し直してください。')).toBeInTheDocument();
    expect(screen.queryByText('このスマホはまだ接続していません')).not.toBeInTheDocument();
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
      expect(await screen.findByText(/QR を表示した PC：Mac 3/, undefined, { timeout: 3000 })).toBeInTheDocument();
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
