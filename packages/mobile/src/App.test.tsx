import { aadAnswer, aadLaunch, open, seal, type MobileFeed, type MobileLaunchAnswer, type MobileLaunchPayload } from '@agent-hangar/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import * as store from './store.ts';
import { feedOf, inboxOf, liveItem, makeKey } from './test/fixtures.ts';
import { json, WORKER } from './test/pairText.ts';

let key: CryptoKey;
let fetchMock: ReturnType<typeof vi.fn>;
/** 受信箱の feed。試験の途中で差し替える。 */
let feeds: MobileFeed[];
let launches: { id: string; targetDevice: string; sealed: string }[];
/** GET /m/launches/:id の答え。 */
let status: 'pending' | 'claimed' | 'started' | 'failed';
let answer: MobileLaunchAnswer | undefined;
let inboxReads: number;

beforeEach(async () => {
  key = await makeKey();
  store.savePairing({ url: WORKER, token: 'tok-1', deviceId: 'phone-1' });
  await store.saveKey(key);
  feeds = [feedOf('pc-1', 'Mac')];
  launches = [];
  status = 'pending';
  answer = undefined;
  inboxReads = 0;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/m/inbox')) {
      inboxReads++;
      return json(await inboxOf(key, feeds, { now: Date.now() }));
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { id: string; targetDevice: string; sealed: string };
      launches.push(body);
      return json({ id: body.id, status: 'pending', sealedAnswer: null }, 201);
    }
    const id = url.split('/').pop()!;
    return json({ id, status, sealedAnswer: answer ? await seal(key, aadAnswer(id), answer) : null });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    // 消せなくても次の試験が上書きする。
  }
});

const openNew = async () => {
  const plus = await screen.findByRole('button', { name: '＋ 新しい会話' });
  await waitFor(() => expect(plus).toBeEnabled());
  fireEvent.click(plus);
};
const fillAndStart = () => {
  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'プロジェクト' })).getByRole('radio', { name: /project-a/ }));
  fireEvent.change(screen.getByRole('textbox', { name: '初期プロンプト' }), { target: { value: 'テストを足して' } });
  fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
};
const steps = () => within(screen.getByRole('list', { name: '進み' })).getAllByRole('listitem').map((li) => li.getAttribute('data-state'));

describe('App', () => {
  it('閉じる動きの間に「＋ 新しい会話」を押し直すと、選んだものの残らない新しい画面で開く', async () => {
    const root = document.documentElement.style;
    root.setProperty('--dur-exit', '250ms');
    root.setProperty('--dur-fast', '200ms');
    try {
      render(<App pairText={null} />);
      await openNew();
      const projects = () => within(screen.getByRole('radiogroup', { name: 'プロジェクト' }));
      fireEvent.click(projects().getByRole('radio', { name: /project-a/ }));
      expect(projects().getByRole('radio', { name: /project-a/ })).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
      // まだ畳んでいる間に開き直す。
      fireEvent.click(screen.getByRole('button', { name: '＋ 新しい会話' }));
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(projects().getByRole('radio', { name: /project-a/ })).toHaveAttribute('aria-checked', 'false');
    } finally {
      root.removeProperty('--dur-exit');
      root.removeProperty('--dur-fast');
    }
  });

  it('「始める」で受信箱に戻り、起動のシートが出て、送信、受信、開始と進み、始まったら会話の URL で開くリンクが出る', async () => {
    render(<App pairText={null} launchEveryMs={20} />);
    await openNew();
    fillAndStart();
    // フォームは閉じ、受信箱の上にシートが出る。
    const dlg = await screen.findByRole('dialog', { name: /会話を開始中…/ });
    expect(screen.queryByRole('radiogroup', { name: 'プロジェクト' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: /入力待ち/ })).toBeInTheDocument();
    await waitFor(() => expect(launches).toHaveLength(1));
    const payload = await open<MobileLaunchPayload>(key, aadLaunch(launches[0]!.id, 'pc-1'), launches[0]!.sealed);
    expect(payload).toMatchObject({ projectId: 'p-a', accountId: 'acc-1', prompt: 'テストを足して' });
    await waitFor(() => expect(steps()).toEqual(['done', 'act', 'todo']));

    status = 'claimed';
    await waitFor(() => expect(steps()).toEqual(['done', 'done', 'act']));

    // PC が始めた。受信箱の素にその会話が URL つきで載る。
    answer = { ok: true, sessionId: 's-new', title: '導入を直す' };
    status = 'started';
    feeds = [feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-new', title: '導入を直す', status: 'busy', intent: 'README を読んでいます', rcUrl: 'https://claude.ai/code/session_new' })] })];
    await waitFor(() => expect(steps()).toEqual(['done', 'done', 'done']));
    expect(within(dlg).getByRole('region', { name: '開始した会話' })).toHaveTextContent('導入を直す');
    const link = await within(dlg).findByRole('link', { name: 'アカウント 1のアカウントで開く ›' });
    expect(link).toHaveAttribute('href', 'https://claude.ai/code/session_new');
    expect(within(dlg).getByText('意図：README を読んでいます')).toBeInTheDocument();
  });

  it('シートを閉じても依頼は続き、始まったら受信箱の行に出る', async () => {
    render(<App pairText={null} launchEveryMs={20} />);
    await openNew();
    fillAndStart();
    await screen.findByRole('dialog', { name: /会話を開始中…/ });
    await waitFor(() => expect(launches).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '受信箱へ' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const before = inboxReads;
    answer = { ok: true, sessionId: 's-new', title: '導入を直す' };
    status = 'started';
    feeds = [feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-new', title: '導入を直す', status: 'busy', intent: '導入の節を直す' })] })];
    // 始まったと分かった時点で受信箱を読み直し、実行中の行に出る。
    expect(await screen.findByText('導入の節を直す')).toBeInTheDocument();
    expect(inboxReads).toBeGreaterThan(before);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('失敗したらシートに文を出し、「もう一度送信」で同じ依頼を送り直せる', async () => {
    render(<App pairText={null} launchEveryMs={20} />);
    await openNew();
    fillAndStart();
    await screen.findByRole('dialog', { name: /会話を開始中…/ });
    status = 'failed';
    answer = { ok: false, reason: 'project-missing' };
    expect(await screen.findByText(/その PC にプロジェクトのディレクトリがありません/)).toBeInTheDocument();
    expect(steps()).toEqual(['done', 'fail', 'todo']);
    status = 'pending';
    answer = undefined;
    fireEvent.click(screen.getByRole('button', { name: 'もう一度送信' }));
    await waitFor(() => expect(launches).toHaveLength(2));
    expect(launches[1]!.id).not.toBe(launches[0]!.id);
    await waitFor(() => expect(steps()).toEqual(['done', 'act', 'todo']));
  });

  it('依頼を受けた Worker が 401 を返したら、接続し直しの画面へ', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/m/inbox')) return json(await inboxOf(key, feeds, { now: Date.now() }));
      if (init?.method === 'POST') return json({ error: 'unauthorized' }, 401);
      return json({}, 404);
    });
    render(<App pairText={null} launchEveryMs={20} />);
    await openNew();
    fillAndStart();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('heading', { name: /接続/ })).toBeInTheDocument();
  });
});
