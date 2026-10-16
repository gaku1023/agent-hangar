import { aadAnswer, aadLaunch, open, PERMISSION_MODE_VALUES, seal, type MobileFeed, type MobileLaunchAnswer, type MobileLaunchPayload } from '@agent-hangar/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openInbox, type InboxView } from '../inbox.ts';
import { feedOf, inboxOf, liveItem, makeKey, MIN } from '../test/fixtures.ts';
import { json, WORKER } from '../test/pairText.ts';
import { NewSessionScreen } from './NewSessionScreen.tsx';

const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };
let key: CryptoKey;
let fetchMock: ReturnType<typeof vi.fn>;
/** 送られた依頼。GET の答えを作るのに id を使う。 */
let sent: { id: string; targetDevice: string; sealed: string }[];

beforeEach(async () => {
  key = await makeKey();
  sent = [];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function viewOf(feeds: MobileFeed[], opts?: Parameters<typeof inboxOf>[2]): Promise<InboxView> {
  return openInbox(await inboxOf(key, feeds, { now: Date.now(), ...opts }), key, new Date());
}

/** POST は受けて pending、GET は answers を順に返す（最後のものを繰り返す）。 */
function serve(answers: ({ status: 'pending' | 'claimed' | 'started' | 'failed' | 'expired'; answer?: MobileLaunchAnswer } | { http: number; body: unknown })[]): void {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { id: string; targetDevice: string; sealed: string };
      sent.push(body);
      const first = answers[0];
      if (first && 'http' in first) {
        answers.shift();
        return json(first.body, first.http);
      }
      return json({ id: body.id, status: 'pending', sealedAnswer: null }, 201);
    }
    const id = url.split('/').pop()!;
    const a = answers.length > 1 ? answers.shift()! : answers[0]!;
    if ('http' in a) return json(a.body, a.http);
    return json({ id, status: a.status, sealedAnswer: a.answer ? await seal(key, aadAnswer(id), a.answer) : null });
  });
}

const twoPcs = (): MobileFeed[] => [
  feedOf('pc-1', 'Mac', {
    accounts: [{ id: 'acc-1', name: 'アカウント 1', color: '#4a63e8', fiveHour: 32, sevenDay: 10 }],
    projects: [{ id: 'p-a', name: 'project-a', lastUsedAt: Date.now() - 5 * MIN }],
    live: [liveItem({ sessionId: 's-1', status: 'busy' })],
  }),
  feedOf('pc-2', 'Mini', {
    accounts: [
      { id: 'acc-2', name: 'アカウント 2', color: '#3a8f5c', fiveHour: null, sevenDay: null },
      { id: 'acc-3', name: 'アカウント 3', color: '#c77a1a', fiveHour: 5, sevenDay: 1 },
    ],
    projects: [
      { id: 'p-a', name: 'project-a', lastUsedAt: Date.now() - 9 * MIN },
      { id: 'p-b', name: 'project-b', lastUsedAt: Date.now() - MIN },
    ],
  }),
];

const group = (name: string) => screen.getByRole('radiogroup', { name });
const pick = (groupName: string, option: RegExp | string) => fireEvent.click(within(group(groupName)).getByRole('radio', { name: option }));

describe('NewSessionScreen', () => {
  it('4 つを選んで始めると「受け取るのを待っています」→「始まりました」', async () => {
    serve([{ status: 'pending' }, { status: 'claimed' }, { status: 'started', answer: { ok: true, sessionId: 's-9', title: '会話 9' } }]);
    const onClose = vi.fn();
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={onClose} onUnpaired={vi.fn()} everyMs={10} />);
    pick('プロジェクト', /project-a/);
    pick('PC', /Mini/);
    pick('アカウント', /アカウント 3/);
    pick('権限モード', 'Plan');
    pick('モデル', 'opus');
    fireEvent.change(screen.getByRole('textbox', { name: '最初の指示' }), { target: { value: 'テストを足して' } });
    const start = screen.getByRole('button', { name: 'Mini で始める' });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(await screen.findByText('Mini が受け取るのを待っています（最大 30 秒ほど）')).toBeInTheDocument();
    expect(await screen.findByText(/始まりました/)).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.targetDevice).toBe('pc-2');
    const payload = await open<MobileLaunchPayload>(key, aadLaunch(sent[0]!.id, 'pc-2'), sent[0]!.sealed);
    expect(payload).toMatchObject({ projectId: 'p-a', scratch: false, accountId: 'acc-3', permissionMode: 'plan', model: 'opus', prompt: 'テストを足して' });
    fireEvent.click(screen.getByRole('button', { name: /受信箱へ/ }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('最初の指示が空なら始められない', async () => {
    serve([{ status: 'pending' }]);
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={vi.fn()} onUnpaired={vi.fn()} everyMs={10} />);
    pick('プロジェクト', /project-b/);
    // PC と アカウントが 1 つずつなら、それが選ばれている。
    expect(within(group('PC')).getByRole('radio', { name: /Mini/ })).toHaveAttribute('aria-checked', 'true');
    pick('アカウント', /アカウント 2/);
    const start = screen.getByRole('button', { name: 'Mini で始める' });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '最初の指示' }), { target: { value: '   ' } });
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect(sent).toHaveLength(0);
    fireEvent.change(screen.getByRole('textbox', { name: '最初の指示' }), { target: { value: 'はじめて' } });
    expect(start).toBeEnabled();
  });

  it('最初の指示は 8,000 字まで。近づくまで何も出さず、超えたら始められない', async () => {
    serve([{ status: 'pending' }]);
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={vi.fn()} onUnpaired={vi.fn()} everyMs={10} />);
    pick('プロジェクト', /project-b/);
    pick('アカウント', /アカウント 2/);
    const box = screen.getByRole('textbox', { name: '最初の指示' });
    const start = screen.getByRole('button', { name: 'Mini で始める' });
    fireEvent.change(box, { target: { value: 'あ'.repeat(7000) } });
    expect(screen.queryByText(/字/)).not.toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'あ'.repeat(7900) } });
    expect(screen.getByText('あと 100 字')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'あ'.repeat(8000) } });
    expect(start).toBeEnabled();
    fireEvent.change(box, { target: { value: 'あ'.repeat(8001) } });
    expect(start).toBeDisabled();
    expect(screen.getByText(/8,000 字まで/)).toBeInTheDocument();
  });

  it('project-missing の答えは「その PC にプロジェクトの場所がありません」と出る', async () => {
    serve([{ status: 'failed', answer: { ok: false, reason: 'project-missing' } }]);
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={vi.fn()} onUnpaired={vi.fn()} everyMs={10} />);
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    fireEvent.change(screen.getByRole('textbox', { name: '最初の指示' }), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(await screen.findByText(/その PC にプロジェクトの場所がありません/)).toBeInTheDocument();
    // もう一度送れる（選んだものは残る）。
    fireEvent.click(screen.getByRole('button', { name: 'もう一度' }));
    expect(screen.getByRole('button', { name: 'Mac で始める' })).toBeEnabled();
  });

  it('launch-failed の detail は文として出る', async () => {
    serve([{ status: 'failed', answer: { ok: false, reason: 'launch-failed', detail: '<b>tmux</b> が無い' } }]);
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={vi.fn()} onUnpaired={vi.fn()} everyMs={10} />);
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    fireEvent.change(screen.getByRole('textbox', { name: '最初の指示' }), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(await screen.findByText('<b>tmux</b> が無い')).toBeInTheDocument();
  });

  it('送りすぎ（429）は回数の上限を言う', async () => {
    serve([{ http: 429, body: { error: 'rate limited' } }]);
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={vi.fn()} onUnpaired={vi.fn()} everyMs={10} />);
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    fireEvent.change(screen.getByRole('textbox', { name: '最初の指示' }), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(await screen.findByText(/10 分に 10 件まで/)).toBeInTheDocument();
  });

  it('権限モードの選択肢が PC のダイアログと同じ 7 つ', async () => {
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={vi.fn()} onUnpaired={vi.fn()} />);
    const radios = within(group('権限モード')).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('data-value'))).toEqual([...PERMISSION_MODE_VALUES]);
    expect(radios.map((r) => r.textContent)).toEqual(['デフォルト', 'Plan', 'Manual', 'Accept edits', 'Auto', "Don't ask", 'Bypass permissions']);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    const models = within(group('モデル')).getAllByRole('radio');
    expect(models.map((r) => r.textContent)).toEqual(['デフォルト', 'fable', 'opus', 'sonnet', 'haiku']);
    expect(models[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('すぐ始めるが先頭で、選ぶと生きている PC が全部出て、依頼は projectId null・scratch true', async () => {
    serve([{ status: 'pending' }]);
    const feeds = [...twoPcs(), feedOf('pc-3', 'Old')];
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(feeds, { lastSeen: { 'pc-3': Date.now() - 4 * MIN } })} onClose={vi.fn()} onUnpaired={vi.fn()} everyMs={10} />);
    const projects = within(group('プロジェクト')).getAllByRole('radio');
    expect(projects[0]).toHaveTextContent('すぐ始める（フォルダなし）');
    expect(projects.map((r) => r.textContent)).toEqual([expect.stringContaining('すぐ始める'), expect.stringContaining('project-b'), expect.stringContaining('project-a')]);
    pick('プロジェクト', /すぐ始める/);
    const pcs = within(group('PC')).getAllByRole('radio');
    expect(pcs.map((r) => r.textContent)).toEqual([expect.stringContaining('Mac'), expect.stringContaining('Mini')]);
    expect(pcs[0]).toHaveTextContent('動いている 1');
    expect(pcs[1]).toHaveTextContent('空いている');
    pick('PC', /Mac/);
    expect(within(group('アカウント')).getByRole('radio', { name: /アカウント 1/ })).toHaveTextContent('5時間 32%');
    fireEvent.change(screen.getByRole('textbox', { name: '最初の指示' }), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    await screen.findByText(/受け取るのを待っています/);
    const payload = await open<MobileLaunchPayload>(key, aadLaunch(sent[0]!.id, 'pc-1'), sent[0]!.sealed);
    expect(payload).toMatchObject({ projectId: null, scratch: true, accountId: 'acc-1', permissionMode: '', model: '' });
  });

  it('動きの長さがあっても（実機の CSS）StrictMode で開いて選べる', async () => {
    document.documentElement.style.setProperty('--dur-exit', '250ms');
    document.documentElement.style.setProperty('--dur-fast', '200ms');
    try {
      const view = await viewOf(twoPcs());
      render(
        <StrictMode>
          <NewSessionScreen pairing={pairing} cryptoKey={key} view={view} onClose={vi.fn()} onUnpaired={vi.fn()} />
        </StrictMode>,
      );
      pick('プロジェクト', /project-a/);
      pick('PC', /Mac/);
      pick('プロジェクト', /project-b/);
      expect(within(group('PC')).getByRole('radio', { name: /Mini/ })).toHaveAttribute('aria-checked', 'true');
    } finally {
      document.documentElement.style.removeProperty('--dur-exit');
      document.documentElement.style.removeProperty('--dur-fast');
    }
  });

  it('閉じるで受信箱へ戻る', async () => {
    const onClose = vi.fn();
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={onClose} onUnpaired={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('届いたか分からない失敗の後の「もう一度」は同じ id で送り、中身を変えたら新しい id', async () => {
    let failPosts = 2;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as { id: string; targetDevice: string; sealed: string };
        sent.push(body);
        if (failPosts > 0) {
          failPosts--;
          throw new TypeError('Failed to fetch');
        }
        return json({ id: body.id, status: 'pending', sealedAnswer: null }, 201);
      }
      return json({ id: url.split('/').pop(), status: 'pending', sealedAnswer: null });
    });
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={vi.fn()} onUnpaired={vi.fn()} everyMs={10} />);
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    const box = screen.getByRole('textbox', { name: '最初の指示' });
    fireEvent.change(box, { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(await screen.findByText(/通信を確かめて/)).toBeInTheDocument();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.id).toBe(sent[0]!.id);

    // 同じ中身で送り直す：同じ id（前のが置けていれば Worker は行を増やさない）。
    failPosts = 2;
    fireEvent.click(screen.getByRole('button', { name: 'もう一度' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    await waitFor(() => expect(sent).toHaveLength(4));
    expect(await screen.findByText(/通信を確かめて/)).toBeInTheDocument();
    expect(sent.map((b) => b.id)).toEqual([sent[0]!.id, sent[0]!.id, sent[0]!.id, sent[0]!.id]);

    // 中身を変えたら別の依頼：新しい id。
    fireEvent.click(screen.getByRole('button', { name: 'もう一度' }));
    fireEvent.change(box, { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(await screen.findByText(/受け取るのを待っています/)).toBeInTheDocument();
    expect(sent).toHaveLength(5);
    expect(sent[4]!.id).not.toBe(sent[0]!.id);
    const payload = await open<MobileLaunchPayload>(key, aadLaunch(sent[4]!.id, 'pc-1'), sent[4]!.sealed);
    expect(payload.prompt).toBe('b');
  });

  it('始まったと言えない答え（開けない）は「返事を読めませんでした」と出し、接続し直しを勧めない', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as { id: string; targetDevice: string; sealed: string };
        sent.push(body);
        return json({ id: body.id, status: 'pending', sealedAnswer: null }, 201);
      }
      return json({ id: url.split('/').pop(), status: 'started', sealedAnswer: 'not-a-sealed-value' });
    });
    const onClose = vi.fn();
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={onClose} onUnpaired={vi.fn()} everyMs={10} />);
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    fireEvent.change(screen.getByRole('textbox', { name: '最初の指示' }), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(await screen.findByText(/返事を読めませんでした/)).toBeInTheDocument();
    expect(screen.queryByText(/始まりました/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '接続し直す' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /受信箱へ/ }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('PC が受け取った後に答えが届かないまま時間切れなら「受け取りましたが、結果がまだ届いていません」と出し、もう一度を出さない', async () => {
    serve([{ status: 'pending' }, { status: 'claimed' }]);
    const onClose = vi.fn();
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={onClose} onUnpaired={vi.fn()} everyMs={10} giveUpMs={200} />);
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    fireEvent.change(screen.getByRole('textbox', { name: '最初の指示' }), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(await screen.findByText('Mac は受け取りましたが、結果がまだ届いていません。受信箱で確かめてから送り直してください。')).toBeInTheDocument();
    expect(screen.queryByText(/受け取りませんでした/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'もう一度' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mac で始める' })).not.toBeInTheDocument();
    expect(sent).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /受信箱へ/ }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('PC が受け取らないまま時間切れなら「受け取りませんでした」と出す', async () => {
    serve([{ status: 'pending' }]);
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={vi.fn()} onUnpaired={vi.fn()} everyMs={10} giveUpMs={200} />);
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    fireEvent.change(screen.getByRole('textbox', { name: '最初の指示' }), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(await screen.findByText(/Mac が受け取りませんでした/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'もう一度' })).toBeInTheDocument();
  });

  it('待っている間に 401 なら接続し直しの画面へ', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as { id: string };
        return json({ id: body.id, status: 'pending', sealedAnswer: null }, 201);
      }
      return json({ error: 'unauthorized' }, 401);
    });
    const onUnpaired = vi.fn();
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={vi.fn()} onUnpaired={onUnpaired} everyMs={10} />);
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    fireEvent.change(screen.getByRole('textbox', { name: '最初の指示' }), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    await waitFor(() => expect(onUnpaired).toHaveBeenCalledTimes(1));
  });

  it('送っている間も始めるボタンは同じ要素のまま（フォーカスを落とさない）', async () => {
    let release: (() => void) | null = null;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as { id: string };
        await new Promise<void>((r) => (release = r));
        return json({ id: body.id, status: 'pending', sealedAnswer: null }, 201);
      }
      return json({ status: 'pending', sealedAnswer: null });
    });
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={vi.fn()} onUnpaired={vi.fn()} everyMs={10} />);
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    fireEvent.change(screen.getByRole('textbox', { name: '最初の指示' }), { target: { value: 'a' } });
    const btn = screen.getByRole('button', { name: 'Mac で始める' });
    btn.focus();
    fireEvent.click(btn);
    const sending = await screen.findByRole('button', { name: '送っています…' });
    expect(sending).toBe(btn);
    await waitFor(() => expect(release).not.toBeNull());
    release!();
    expect(await screen.findByText(/受け取るのを待っています/)).toBeInTheDocument();
  });

  it('待っている間に閉じても、受信箱を読み直す', async () => {
    serve([{ status: 'pending' }]);
    const onClose = vi.fn();
    render(<NewSessionScreen pairing={pairing} cryptoKey={key} view={await viewOf(twoPcs())} onClose={onClose} onUnpaired={vi.fn()} everyMs={10} />);
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    fireEvent.change(screen.getByRole('textbox', { name: '最初の指示' }), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    await screen.findByText(/受け取るのを待っています/);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledWith(true);
  });
});
