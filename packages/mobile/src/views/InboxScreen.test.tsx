import { COMPAT_VERSION, type MobileFeed, type MobileInboxResponse } from '@agent-hangar/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../store.ts';
import { feedOf, inboxOf, liveItem, makeKey, MIN } from '../test/fixtures.ts';
import { json, WORKER } from '../test/pairText.ts';
import { InboxScreen } from './InboxScreen.tsx';

vi.mock('../store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store.ts')>();
  return { ...actual, clearPairing: vi.fn(actual.clearPairing) };
});

const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };
let key: CryptoKey;
let fetchMock: ReturnType<typeof vi.fn>;

/** fetch が返す受信箱を差し替える。毎回新しい Response を作る（本文は 1 度しか読めない）。 */
function serve(res: MobileInboxResponse | (() => Response)): void {
  fetchMock.mockImplementation(async () => (typeof res === 'function' ? res() : json(res)));
}

async function serveFeeds(feeds: MobileFeed[], opts?: Parameters<typeof inboxOf>[2]): Promise<void> {
  serve(await inboxOf(key, feeds, { now: Date.now(), ...opts }));
}

beforeEach(async () => {
  key = await makeKey();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const now = () => Date.now();

describe('InboxScreen', () => {
  it('見出しが「あなたの番 N」', async () => {
    await serveFeeds([
      feedOf('pc-1', 'Mac', {
        live: [
          liveItem({ sessionId: 's-1', status: 'waiting', statusAt: now() - 5 * MIN }),
          liveItem({ sessionId: 's-2', status: 'waiting', statusAt: now() - 9 * MIN }),
          liveItem({ sessionId: 's-3', status: 'busy' }),
        ],
      }),
    ]);
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    expect(await screen.findByRole('heading', { level: 1, name: /あなたの番\s*2/ })).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${WORKER}/m/inbox`);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-1');
    expect(headers['x-hangar-compat']).toBe(String(COMPAT_VERSION));
  });

  it('待っている内容の 1 行と PC 名が出る', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting', waiting: { kind: 'permission', text: 'Bash: npm test' } })] })]);
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    const card = (await screen.findByText('Bash: npm test')).closest('a')!;
    expect(within(card).getByText(/Mac/)).toBeInTheDocument();
    expect(within(card).getByText(/許可/)).toBeInTheDocument();
    expect(within(card).getByText('project-a')).toBeInTheDocument();
    expect(screen.getByText(/^Mac$/, { selector: '.alive-name' })).toBeInTheDocument();
  });

  it('何も待っていなければ「待っている会話はありません」', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac')]);
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    expect(await screen.findByText('待っている会話はありません')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: /あなたの番\s*0/ })).toBeInTheDocument();
  });

  it('rcUrl の無い行は claude.ai/code へのリンク', async () => {
    await serveFeeds([
      feedOf('pc-1', 'Mac', {
        live: [
          liveItem({ sessionId: 's-1', status: 'waiting', waiting: { kind: 'question', text: '質問 1' } }),
          liveItem({ sessionId: 's-2', status: 'waiting', waiting: { kind: 'question', text: '質問 2' }, rcUrl: 'https://claude.ai/code/session_abc123' }),
          liveItem({ sessionId: 's-3', status: 'busy', intent: '試験を足す' }),
        ],
      }),
    ]);
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    expect((await screen.findByText('質問 1')).closest('a')).toHaveAttribute('href', 'https://claude.ai/code');
    expect(screen.getByText('質問 2').closest('a')).toHaveAttribute('href', 'https://claude.ai/code/session_abc123');
    expect(screen.getByText('試験を足す').closest('a')).toHaveAttribute('href', 'https://claude.ai/code');
  });

  it('rcUrl が javascript: や別のホストなら claude.ai/code へのリンクになる', async () => {
    await serveFeeds([
      feedOf('pc-1', 'Mac', {
        live: [
          liveItem({ sessionId: 's-1', status: 'waiting', waiting: { kind: 'question', text: '質問 1' }, rcUrl: 'javascript:alert(1)' }),
          liveItem({ sessionId: 's-2', status: 'waiting', waiting: { kind: 'question', text: '質問 2' }, rcUrl: 'https://claude.ai.evil.example/code' }),
          liveItem({ sessionId: 's-3', status: 'waiting', waiting: { kind: 'question', text: '質問 3' }, rcUrl: 'https://evil.example/https://claude.ai/' }),
        ],
      }),
    ]);
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    for (const t of ['質問 1', '質問 2', '質問 3']) expect((await screen.findByText(t)).closest('a')).toHaveAttribute('href', 'https://claude.ai/code');
  });

  it('題・待っている内容・意図に <img src=x onerror=...> が入っていても img 要素は作られず文字として出る', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    await serveFeeds([
      feedOf('pc-1', `Mac${evil}`, {
        live: [
          liveItem({ sessionId: 's-1', status: 'waiting', title: `題${evil}`, projectName: `p${evil}`, waiting: { kind: 'question', text: `待ち${evil}` } }),
          liveItem({ sessionId: 's-2', status: 'busy', intent: `意図${evil}` }),
        ],
        done: [{ sessionId: 's-3', projectName: 'project-a', title: '会話 3', oneLiner: `要約${evil}`, doneAt: now() - MIN }],
      }),
    ]);
    const { container } = render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    expect(await screen.findByText(`待ち${evil}`)).toBeInTheDocument();
    expect(screen.getByText(`意図${evil}`)).toBeInTheDocument();
    expect(screen.getByText(`· 題${evil}`)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('401 なら参加の画面に戻る', async () => {
    serve(() => json({ error: 'revoked' }, 401));
    const onUnpaired = vi.fn();
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={onUnpaired} />);
    await waitFor(() => expect(onUnpaired).toHaveBeenCalled());
    expect(store.clearPairing).toHaveBeenCalled();
  });

  it('全部の feed が開けなければ「接続し直してください」', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac'), feedOf('pc-2', 'Mac 2')], { otherKeyFor: ['pc-1', 'pc-2'] });
    const onUnpaired = vi.fn();
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={onUnpaired} />);
    expect(await screen.findByText(/接続し直してください/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '接続し直す' }));
    expect(store.clearPairing).toHaveBeenCalled();
    expect(onUnpaired).toHaveBeenCalled();
  });

  it('一部の PC だけ開けなければ、その PC 名を添えて残りを出す', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting', waiting: { kind: 'question', text: '質問 1' } })] }), feedOf('pc-2', 'Mac 2')], { otherKeyFor: ['pc-2'] });
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    expect(await screen.findByText('質問 1')).toBeInTheDocument();
    expect(screen.getByText(/Mac 2 の一覧を開けません/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '接続し直す' })).toBeNull();
  });

  it('3 分見ていない PC は灰色の丸と「不明」', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'busy', intent: '作業 1' })] })], { lastSeen: { 'pc-1': now() - 10 * MIN } });
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    const alive = (await screen.findByText(/^Mac$/, { selector: '.alive-name' })).closest('.alive')!;
    expect(alive).toHaveClass('stale');
    expect(within(alive as HTMLElement).getByText('不明')).toBeInTheDocument();
    expect(screen.getByText('作業 1').closest('a')).toHaveClass('unknown');
  });

  it('見えたとき（visibilitychange）と下に引いたときに読み直す', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac')]);
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    await screen.findByText('待っている会話はありません');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const scroller = screen.getByTestId('inbox-scroll');
    await act(async () => {
      fireEvent.touchStart(scroller, { touches: [{ clientX: 0, clientY: 10 }] });
      fireEvent.touchMove(scroller, { touches: [{ clientX: 0, clientY: 260 }] });
    });
    expect(screen.getByText('離すと読み直します')).toBeInTheDocument();
    await act(async () => {
      fireEvent.touchEnd(scroller, { touches: [] });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it('見えている間は 30 秒ごとに読み直し、隠れている間は読まない', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await serveFeeds([feedOf('pc-1', 'Mac')]);
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    await screen.findByText('待っている会話はありません');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vis.mockRestore();
  });

  it('動いている行は、意図があってもプロジェクト名を出し、丸はどれも作業中の橙', async () => {
    await serveFeeds([
      feedOf('pc-1', 'Mac', {
        live: [
          liveItem({ sessionId: 's-1', status: 'busy', projectName: 'project-a', intent: '試験を足す' }),
          liveItem({ sessionId: 's-2', status: 'idle', projectName: 'project-b', title: '会話 2', intent: null }),
        ],
      }),
    ]);
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    const a = (await screen.findByText('試験を足す')).closest('a')!;
    expect(a.querySelector('.thin-text')).toHaveTextContent('project-a · 試験を足す');
    expect(within(a).getByText('project-a')).toHaveClass('thin-proj');
    const b = screen.getByText('会話 2').closest('a')!;
    expect(b.querySelector('.thin-text')).toHaveTextContent('project-b · 会話 2');
    expect(a.querySelector('.dot')).toHaveClass('busy');
    expect(b.querySelector('.dot')).toHaveClass('busy');
  });

  it('戻る日を過ぎたものは日付、今日のものは時刻を出す', async () => {
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const past = new Date();
    past.setDate(past.getDate() - 2);
    await serveFeeds([
      feedOf('pc-1', 'Mac', {
        returns: [
          { sessionId: 'r-1', projectName: 'project-a', title: '会話 1', accountId: 'acc-1', returnOn: day(new Date()), returnTime: '18:00' },
          { sessionId: 'r-2', projectName: 'project-a', title: '会話 2', accountId: 'acc-1', returnOn: day(past), returnTime: '09:00' },
        ],
      }),
    ]);
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    expect(await screen.findByText('今日戻る')).toBeInTheDocument();
    const rows = [...document.querySelectorAll('.thin')].map((r) => r.textContent);
    expect(rows).toEqual([`会話 2${past.getMonth() + 1}月${past.getDate()}日`, '会話 118:00']);
  });

  it('待った時間はスマホの時計でなく Worker の時刻に寄せて測る', async () => {
    const workerNow = now() + 60 * MIN;
    await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting', statusAt: workerNow - 10 * MIN, waiting: { kind: 'question', text: '質問 1' } })] })], { now: workerNow, lastSeen: { 'pc-1': workerNow - 2 * MIN } });
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    const card = (await screen.findByText('質問 1')).closest('a')!;
    expect(within(card).getByText('10分')).toBeInTheDocument();
    expect(screen.getByText('2 分前')).toBeInTheDocument();
  });

  it('今日戻ると今日終わったの節が出る', async () => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await serveFeeds([
      feedOf('pc-1', 'Mac', {
        returns: [{ sessionId: 'r-1', projectName: 'project-a', title: '会話 1', accountId: 'acc-1', returnOn: today, returnTime: '18:00' }],
        done: [{ sessionId: 'd-1', projectName: 'project-a', title: '会話 2', oneLiner: '片付けた', doneAt: now() - MIN }],
      }),
    ]);
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />);
    expect(await screen.findByText('今日戻る')).toBeInTheDocument();
    expect(screen.getByText('18:00')).toBeInTheDocument();
    expect(screen.getByText('今日終わった')).toBeInTheDocument();
    expect(screen.getByText('片付けた')).toBeInTheDocument();
  });

  it('「＋ 新しい会話」は読み込めてから押せて、読んだものを渡す', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac')]);
    const onNewSession = vi.fn();
    render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} onNewSession={onNewSession} />);
    const btn = screen.getByRole('button', { name: '＋ 新しい会話' });
    expect(btn).toBeDisabled();
    await screen.findByText('待っている会話はありません');
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(onNewSession.mock.calls[0]![0].feeds.map((f: MobileFeed) => f.deviceId)).toEqual(['pc-1']);
  });

  it('refresh が変わると読み直す', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac')]);
    const onUnpaired = vi.fn();
    const { rerender } = render(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={onUnpaired} refresh={0} />);
    await screen.findByText('待っている会話はありません');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={onUnpaired} refresh={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('StrictMode でも節が出て描き直しが止まる（main.tsx と同じ包み）', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'busy' }), liveItem({ sessionId: 's-2', status: 'waiting' })] })]);
    render(
      <StrictMode>
        <InboxScreen pairing={pairing} cryptoKey={key} onUnpaired={vi.fn()} />
      </StrictMode>,
    );
    expect(await screen.findByText('動いている')).toBeInTheDocument();
  });
});
