import { COMPAT_VERSION, type MobileFeed, type MobileInboxResponse } from '@agent-hangar/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../store.ts';
import { feedOf, inboxOf, liveItem, makeKey, MIN, ring } from '../test/fixtures.ts';
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
  it('見出しが「入力待ち N」', async () => {
    await serveFeeds([
      feedOf('pc-1', 'Mac', {
        live: [
          liveItem({ sessionId: 's-1', status: 'waiting', statusAt: now() - 5 * MIN }),
          liveItem({ sessionId: 's-2', status: 'waiting', statusAt: now() - 9 * MIN }),
          liveItem({ sessionId: 's-3', status: 'busy' }),
        ],
      }),
    ]);
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    expect(await screen.findByRole('heading', { level: 1, name: /入力待ち\s*2/ })).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${WORKER}/m/inbox`);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-1');
    expect(headers['x-hangar-compat']).toBe(String(COMPAT_VERSION));
  });

  it('待っている内容の 1 行と PC 名が出る', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting', waiting: { kind: 'permission', text: 'Bash: npm test' } })] })]);
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    const card = (await screen.findByText('Bash: npm test')).closest('a')!;
    expect(within(card).getByText(/Mac/)).toBeInTheDocument();
    expect(within(card).getByText(/許可/)).toBeInTheDocument();
    expect(within(card).getByText('project-a')).toBeInTheDocument();
    expect(screen.getByText(/^Mac$/, { selector: '.alive-name' })).toBeInTheDocument();
  });

  it('何も待っていなければ「なし」', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac')]);
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    expect(await screen.findByText('なし')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: /入力待ち\s*0/ })).toBeInTheDocument();
  });

  it('本文が空なら本文の行を出さず、種別は下の行の札 1 つだけ', async () => {
    await serveFeeds([
      feedOf('pc-1', 'Mac', {
        live: [
          liveItem({ sessionId: 's-1', status: 'waiting', waiting: { kind: 'permission', text: '' } }),
          liveItem({ sessionId: 's-2', status: 'waiting', waiting: { kind: 'question', text: ' ' } }),
        ],
      }),
    ]);
    const { container } = render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    const perm = (await screen.findByText('許可待ち')).closest('a')!;
    expect(within(perm).getByText('許可待ち')).toHaveClass('wait-kind');
    expect(perm.querySelector('.wait-text')).toBeNull();
    expect(within(container).queryByText('許可が必要です')).not.toBeInTheDocument();
    expect(within(container).queryByText('質問があります')).not.toBeInTheDocument();
    const q = screen.getByText('質問').closest('a')!;
    expect(q.querySelector('.wait-text')).toBeNull();
    expect(within(q).getAllByText(/質問/)).toHaveLength(1);
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
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
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
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
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
    const { container } = render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    expect(await screen.findByText(`待ち${evil}`)).toBeInTheDocument();
    expect(screen.getByText(`意図${evil}`)).toBeInTheDocument();
    expect(screen.getByText(`· 題${evil}`)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('401 なら参加の画面に戻る', async () => {
    serve(() => json({ error: 'revoked' }, 401));
    const onUnpaired = vi.fn();
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={onUnpaired} />);
    await waitFor(() => expect(onUnpaired).toHaveBeenCalled());
    expect(store.clearPairing).toHaveBeenCalled();
  });

  it('全部の feed が開けなければ「接続し直してください」', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac'), feedOf('pc-2', 'Mac 2')], { otherKeyFor: ['pc-1', 'pc-2'] });
    const onUnpaired = vi.fn();
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={onUnpaired} />);
    expect(await screen.findByText(/接続し直してください/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '接続し直す' }));
    expect(store.clearPairing).toHaveBeenCalled();
    expect(onUnpaired).toHaveBeenCalled();
  });

  it('一部の PC だけ開けなければ、その PC 名を添えて残りを出す', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting', waiting: { kind: 'question', text: '質問 1' } })] }), feedOf('pc-2', 'Mac 2')], { otherKeyFor: ['pc-2'] });
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    expect(await screen.findByText('質問 1')).toBeInTheDocument();
    // Worker は PC の名前を持たないので、開けない PC は ID の先頭を添えた表記になる。
    expect(screen.getByText(/PC pc-2 の一覧を開けません/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '接続し直す' })).toBeNull();
  });

  it('3 分見ていない PC は灰色の丸と「不明」', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'busy', intent: '作業 1' })] })], { lastSeen: { 'pc-1': now() - 10 * MIN } });
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    const alive = (await screen.findByText(/^Mac$/, { selector: '.alive-name' })).closest('.alive')!;
    expect(alive).toHaveClass('stale');
    expect(within(alive as HTMLElement).getByText('不明')).toBeInTheDocument();
    expect(screen.getByText('作業 1').closest('a')).toHaveClass('unknown');
  });

  it('見えたとき（visibilitychange）と下に引いたときに読み直す', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac')]);
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    await screen.findByText('なし');
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
    expect(screen.getByText('離すと再読み込み')).toBeInTheDocument();
    await act(async () => {
      fireEvent.touchEnd(scroller, { touches: [] });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it('見えている間は 30 秒ごとに読み直し、隠れている間は読まない', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await serveFeeds([feedOf('pc-1', 'Mac')]);
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    await screen.findByText('なし');
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

  it('実行中の行は、意図があってもプロジェクト名を出し、丸はどれも作業中の橙', async () => {
    await serveFeeds([
      feedOf('pc-1', 'Mac', {
        live: [
          liveItem({ sessionId: 's-1', status: 'busy', projectName: 'project-a', intent: '試験を足す' }),
          liveItem({ sessionId: 's-2', status: 'idle', projectName: 'project-b', title: '会話 2', intent: null }),
        ],
      }),
    ]);
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
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
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    expect(await screen.findByText('今日のリマインダー')).toBeInTheDocument();
    const rows = [...document.querySelectorAll('.thin')].map((r) => `${r.querySelector('.thin-text')!.textContent}${r.querySelector('.thin-meta')!.textContent}`);
    expect(rows).toEqual([`会話 2${past.getMonth() + 1}月${past.getDate()}日`, '会話 118:00']);
  });

  it('待った時間はスマホの時計でなく Worker の時刻に寄せて測る', async () => {
    const workerNow = now() + 60 * MIN;
    await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting', statusAt: workerNow - 10 * MIN, waiting: { kind: 'question', text: '質問 1' } })] })], { now: workerNow, lastSeen: { 'pc-1': workerNow - 2 * MIN } });
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    const card = (await screen.findByText('質問 1')).closest('a')!;
    expect(within(card).getByText('10分')).toBeInTheDocument();
    expect(screen.getByText('2 分前')).toBeInTheDocument();
  });

  it('今日のリマインダーと今日終わったの節が出る', async () => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await serveFeeds([
      feedOf('pc-1', 'Mac', {
        returns: [{ sessionId: 'r-1', projectName: 'project-a', title: '会話 1', accountId: 'acc-1', returnOn: today, returnTime: '18:00' }],
        done: [{ sessionId: 'd-1', projectName: 'project-a', title: '会話 2', oneLiner: '片付けた', doneAt: now() - MIN }],
      }),
    ]);
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    expect(await screen.findByText('今日のリマインダー')).toBeInTheDocument();
    expect(screen.getByText('18:00')).toBeInTheDocument();
    expect(screen.getByText('今日終わった')).toBeInTheDocument();
    expect(screen.getByText('片付けた')).toBeInTheDocument();
  });

  it('「＋ 新しい会話」は読み込めてから押せて、読んだものを渡す', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac')]);
    const onNewSession = vi.fn();
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} onNewSession={onNewSession} />);
    const btn = screen.getByRole('button', { name: '＋ 新しい会話' });
    expect(btn).toBeDisabled();
    await screen.findByText('なし');
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(onNewSession.mock.calls[0]![0].feeds.map((f: MobileFeed) => f.deviceId)).toEqual(['pc-1']);
  });

  it('refresh が変わると読み直す', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac')]);
    const onUnpaired = vi.fn();
    const { rerender } = render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={onUnpaired} refresh={0} />);
    await screen.findByText('なし');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={onUnpaired} refresh={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('StrictMode でも節が出て描き直しが止まる（main.tsx と同じ包み）', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'busy' }), liveItem({ sessionId: 's-2', status: 'waiting' })] })]);
    render(
      <StrictMode>
        <InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />
      </StrictMode>,
    );
    expect(await screen.findByText('実行中')).toBeInTheDocument();
  });

  it('入力待ちの行にアカウントの札が付き、開くボタンは「開く ›」だけ', async () => {
    await serveFeeds([
      feedOf('pc-1', 'Mac', {
        accounts: [
          { id: 'acc-1', name: '大学', color: '#4a63e8', fiveHour: 0, sevenDay: 0 },
          { id: 'acc-2', name: '会社', color: '#3a8f5c', fiveHour: 0, sevenDay: 0 },
        ],
        live: [liveItem({ sessionId: 's-1', status: 'waiting', accountId: 'acc-2', waiting: { kind: 'question', text: '質問 1' } })],
      }),
    ]);
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    const card = (await screen.findByText('質問 1')).closest('a')!;
    const tag = within(card).getByText('会社', { selector: '.acct-tag' });
    expect(tag.querySelector('i')!.getAttribute('style')).toContain('background-color: rgb(58, 143, 92)');
    expect(within(card).getByText('開く ›')).toBeInTheDocument();
    expect(within(card).queryByText(/アカウントで開く/)).not.toBeInTheDocument();
  });

  it('実行中の行にもアカウントの札が付く', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'busy', intent: '試験を足す' })] })]);
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    const row = (await screen.findByText('試験を足す')).closest('a')!;
    expect(within(row).getByText('アカウント 1', { selector: '.acct-tag' })).toBeInTheDocument();
  });

  it('アカウントが受信箱の素に無い行は、札を出さず、文言は「開く ›」', async () => {
    await serveFeeds([
      feedOf('pc-1', 'Mac', {
        live: [
          liveItem({ sessionId: 's-1', status: 'waiting', accountId: 'acc-gone', waiting: { kind: 'question', text: '質問 1' } }),
          liveItem({ sessionId: 's-2', status: 'busy', accountId: 'acc-gone', intent: '試験を足す' }),
        ],
      }),
    ]);
    const { container } = render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
    const card = (await screen.findByText('質問 1')).closest('a')!;
    expect(within(card).getByText('開く ›')).toBeInTheDocument();
    expect(container.querySelector('.acct-tag')).toBeNull();
  });

  it('読めた受信箱を onView で渡す（読み直すたびに）', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'busy' })] })]);
    const onView = vi.fn();
    const { rerender } = render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} onView={onView} refresh={0} />);
    await waitFor(() => expect(onView).toHaveBeenCalledTimes(1));
    expect(onView.mock.calls[0]![0].running.map((r: { sessionId: string }) => r.sessionId)).toEqual(['s-1']);
    rerender(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} onView={onView} refresh={1} />);
    await waitFor(() => expect(onView).toHaveBeenCalledTimes(2));
  });

  it('見出しの行の右に歯車（設定）があり、押すと設定を開く。通知の行は受信箱に出さない', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac')]);
    const onSettings = vi.fn();
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} onSettings={onSettings} />);
    await screen.findByText('Mac');
    const gear = screen.getByRole('button', { name: '設定' });
    expect(gear.closest('.inbox-title-row')).not.toBeNull();
    fireEvent.click(gear);
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('このブラウザでは通知を使えません')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '通知を受け取る' })).not.toBeInTheDocument();
  });

  it('通知から開いた会話の行に印を付けて、見える所まで送る', async () => {
    await serveFeeds([
      feedOf('pc-1', 'Mac', {
        live: [
          liveItem({ sessionId: 's-1', status: 'waiting', waiting: { kind: 'other', text: '待ち 1' } }),
          liveItem({ sessionId: 's-2', status: 'waiting', waiting: { kind: 'other', text: '待ち 2' } }),
        ],
      }),
    ]);
    render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} openSession={{ id: 's-2', n: 1 }} />);
    const card = (await screen.findByText('待ち 2')).closest('a')!;
    await waitFor(() => expect(card).toHaveClass('is-target'));
    expect((await screen.findByText('待ち 1')).closest('a')).not.toHaveClass('is-target');
  });

  it('通知から開いた会話が受信箱に無ければ、印を付けない', async () => {
    await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting', waiting: { kind: 'other', text: '待ち 1' } })] })]);
    const { container } = render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} openSession={{ id: 's-9', n: 1 }} />);
    await screen.findByText('待ち 1');
    expect(container.querySelector('.is-target')).toBeNull();
  });

  describe('opencode の行（F1）', () => {
    const OC_CAPS = { asks: true, images: true, effort: true, agents: ['claude-code' as const, 'opencode' as const] };
    const usage = (ctx: number | null, tokens: number, cost: number | null) => ({ ctx, tokens, cost, model: 'opencode/big-pickle' });

    it('opencode の入力待ちの札はリンクにせず、「開く ›」の代わりに「PC で答えてください」を出す。Claude の札はリンクのまま', async () => {
      await serveFeeds([
        feedOf('pc-1', 'Mac', {
          caps: OC_CAPS,
          live: [
            liveItem({ sessionId: 's-claude', status: 'waiting', waiting: { kind: 'permission', text: 'Bash: npm test' } }),
            liveItem({ sessionId: 's-oc', status: 'waiting', agent: 'opencode', waiting: { kind: 'permission', text: 'shell: git push origin main' }, rcUrl: 'https://claude.ai/code/session_abc' }),
          ],
        }),
      ]);
      render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
      const oc = (await screen.findByText('shell: git push origin main')).closest('.wait-card')!;
      expect(oc.tagName).toBe('DIV');
      expect(oc.closest('a')).toBeNull();
      expect(oc.querySelector('[href]')).toBeNull();
      expect(within(oc as HTMLElement).getByText('PC で答えてください')).toBeInTheDocument();
      expect(within(oc as HTMLElement).queryByText('開く ›')).not.toBeInTheDocument();
      const claude = screen.getByText('Bash: npm test').closest('a')!;
      expect(claude).toHaveAttribute('href', 'https://claude.ai/code');
      expect(within(claude).getByText('開く ›')).toBeInTheDocument();
      expect(screen.getAllByText('PC で答えてください')).toHaveLength(1);
    });

    it('実行中の opencode の行はリンクにせず、右端の 2 段目に使用量、下端にコンテキストの帯を出す。80% を超えると帯が橙', async () => {
      await serveFeeds([
        feedOf('pc-1', 'Mac', {
          caps: OC_CAPS,
          live: [
            liveItem({ sessionId: 's-claude', status: 'busy', intent: 'Claude の作業' }),
            liveItem({ sessionId: 's-oc1', status: 'busy', agent: 'opencode', intent: '見出しの整理', usage: usage(34, 13_600, 0) }),
            liveItem({ sessionId: 's-oc2', status: 'busy', agent: 'opencode', intent: '実験ログの集計', usage: usage(83, 148_000, 0.42) }),
            liveItem({ sessionId: 's-oc3', status: 'busy', agent: 'opencode', intent: '使用量なし' }),
          ],
        }),
      ]);
      const { container } = render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
      const row1 = (await screen.findByText('見出しの整理')).closest('.thin')!;
      expect(row1.tagName).toBe('DIV');
      expect(row1.closest('a')).toBeNull();
      expect(within(row1 as HTMLElement).getByText('13.6k · $0.00')).toHaveClass('thin-usage');
      const band1 = row1.querySelector('.ctx-band > i') as HTMLElement;
      expect(band1.style.width).toBe('34%');
      expect(band1).not.toHaveClass('hot');
      const row2 = screen.getByText('実験ログの集計').closest('.thin')!;
      expect(within(row2 as HTMLElement).getByText('148k · $0.42')).toBeInTheDocument();
      expect(row2.querySelector('.ctx-band > i')).toHaveClass('hot');
      const row3 = screen.getByText('使用量なし').closest('.thin')!;
      expect(row3.tagName).toBe('DIV');
      expect(row3.querySelector('.ctx-band, .thin-usage')).toBeNull();
      // Claude の行はリンクのままで、使用量も帯も出さない。
      const claude = screen.getByText('Claude の作業').closest('a')!;
      expect(claude.querySelector('.ctx-band, .thin-usage')).toBeNull();
      expect(container.querySelectorAll('.ctx-band')).toHaveLength(2);
    });

    it('コンテキストの量が分からない（ctx が null）行は、数字だけ出して帯を出さない', async () => {
      await serveFeeds([feedOf('pc-1', 'Mac', { caps: OC_CAPS, live: [liveItem({ sessionId: 's-oc', status: 'busy', agent: 'opencode', intent: 'ローカル', usage: usage(null, 9_000, null) })] })]);
      render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
      const row = (await screen.findByText('ローカル')).closest('.thin')!;
      expect(within(row as HTMLElement).getByText('9k')).toHaveClass('thin-usage');
      expect(row.querySelector('.ctx-band')).toBeNull();
    });

    it('絵を出す PC では、全部の行の題名の左に絵を置き、入力待ちの札の「·」を絵に置き換える', async () => {
      await serveFeeds([
        feedOf('pc-1', 'Mac', {
          caps: OC_CAPS,
          live: [
            liveItem({ sessionId: 's-claude', status: 'waiting', waiting: { kind: 'question', text: '質問 1' } }),
            liveItem({ sessionId: 's-oc', status: 'busy', agent: 'opencode', intent: '作業 oc' }),
          ],
          done: [{ sessionId: 'd-1', projectName: 'project-a', title: '終わった会話', oneLiner: null, doneAt: Date.now() - MIN }],
        }),
      ]);
      render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
      const card = (await screen.findByText('質問 1')).closest('a')!;
      expect(card.querySelector('.agent-icon')).toHaveAttribute('data-agent', 'claude-code');
      expect(within(card).getByRole('img', { name: 'Claude Code' })).toBeInTheDocument();
      expect(card.querySelector('.wait-title')!.textContent).not.toMatch(/^·/);
      const oc = screen.getByText('作業 oc').closest('.thin')!;
      expect(oc.querySelector('.agent-icon')).toHaveAttribute('data-agent', 'opencode');
      const done = screen.getByText('終わった会話').closest('.thin')!;
      expect(done.querySelector('.agent-icon')).toHaveAttribute('data-agent', 'claude-code');
    });

    it('opencode を有効にしていない PC だけなら絵を出さず、今までと同じ見た目', async () => {
      await serveFeeds([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting', waiting: { kind: 'question', text: '質問 1' } }), liveItem({ sessionId: 's-2', status: 'busy', intent: '作業 2' })] })]);
      const { container } = render(<InboxScreen pairing={pairing} keys={ring(key)} onUnpaired={vi.fn()} />);
      const card = (await screen.findByText('質問 1')).closest('a')!;
      expect(card.querySelector('.wait-title')!.textContent).toMatch(/^· /);
      expect(container.querySelector('.agent-icon')).toBeNull();
    });
  });
});

