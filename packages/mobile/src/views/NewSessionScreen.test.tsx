import { EFFORT_VALUES, MOBILE_BELL_MIN_WORKER_COMPAT, PERMISSION_MODE_VALUES, type MobileFeed } from '@agent-hangar/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asker } from '../ask.ts';
import type { PutImage, Shrink } from '../images.ts';
import { openInbox, type InboxView } from '../inbox.ts';
import type { LaunchSpec } from '../launchRun.ts';
import { at1, feedOf, inboxOf, liveItem, makeKey, MIN, ring } from '../test/fixtures.ts';
import { WORKER } from '../test/pairText.ts';
import type { PhoneKey } from '../store.ts';
import { NewSessionScreen } from './NewSessionScreen.tsx';

let key: CryptoKey;
const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };

beforeEach(async () => {
  key = await makeKey();
});

afterEach(() => {
  vi.clearAllMocks();
});

async function viewOf(feeds: MobileFeed[], opts?: Parameters<typeof inboxOf>[2]): Promise<InboxView> {
  return openInbox(await inboxOf(key, feeds, { now: Date.now(), ...opts }), ring(key), new Date());
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

async function setup(feeds: MobileFeed[] = twoPcs(), opts?: Parameters<typeof inboxOf>[2], deps?: { putImage?: PutImage; shrink?: Shrink; asker?: Asker }, over: Partial<InboxView> = {}) {
  const onLaunch = vi.fn<(s: LaunchSpec) => void>();
  const onClose = vi.fn();
  const view = { ...(await viewOf(feeds, opts)), ...over };
  render(<NewSessionScreen view={view} pairing={pairing} phoneKey={at1(key)} deps={deps} onLaunch={onLaunch} onClose={onClose} />);
  return { onLaunch, onClose };
}

const group = (name: string) => screen.getByRole('radiogroup', { name });
const pick = (groupName: string, option: RegExp | string) => fireEvent.click(within(group(groupName)).getByRole('radio', { name: option }));
const prompt = () => screen.getByRole('textbox', { name: '初期プロンプト' });
const advanced = () => screen.getByRole('button', { name: /詳しい設定/ });
const specOf = (fn: ReturnType<typeof vi.fn<(s: LaunchSpec) => void>>): LaunchSpec => fn.mock.calls[0]![0];

describe('NewSessionScreen', () => {
  it('4 つを選んで始めると、選んだものを持った依頼を渡す', async () => {
    const { onLaunch } = await setup();
    pick('プロジェクト', /project-a/);
    pick('PC', /Mini/);
    pick('アカウント', /アカウント 3/);
    fireEvent.click(advanced());
    pick('権限モード', 'Plan');
    pick('モデル', 'opus');
    fireEvent.change(prompt(), { target: { value: 'テストを足して' } });
    const start = screen.getByRole('button', { name: 'Mini で始める' });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(specOf(onLaunch)).toEqual({
      targetDevice: 'pc-2',
      pcName: 'Mini',
      projectName: 'project-a',
      accountId: 'acc-3',
      accountName: 'アカウント 3',
      accountColor: '#c77a1a',
      payload: { projectId: 'p-a', scratch: false, accountId: 'acc-3', permissionMode: 'plan', model: 'opus', prompt: 'テストを足して' },
      skewMs: expect.any(Number),
      id: expect.any(String),
    });
    // 押したあとは、もう一度押せない。
    expect(screen.getByRole('button', { name: 'Mini で始める' })).toBeDisabled();
  });

  it('始めるボタンの文言は、足りないものを順に言う', async () => {
    await setup();
    expect(screen.getByRole('button', { name: 'プロジェクトを選んでください' })).toBeDisabled();
    pick('プロジェクト', /project-a/);
    expect(screen.getByRole('button', { name: 'PC を選んでください' })).toBeDisabled();
    pick('PC', /Mac/);
    expect(screen.getByRole('button', { name: 'Mac で始める' })).toBeDisabled();
  });

  it('初期プロンプトが空なら始められない', async () => {
    const { onLaunch } = await setup();
    pick('プロジェクト', /project-b/);
    // PC もアカウントも 1 つずつなら、それが選ばれている。
    expect(within(group('PC')).getByRole('radio', { name: /Mini/ })).toHaveAttribute('aria-checked', 'true');
    pick('アカウント', /アカウント 2/);
    const start = screen.getByRole('button', { name: 'Mini で始める' });
    expect(start).toBeDisabled();
    fireEvent.change(prompt(), { target: { value: '   ' } });
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect(onLaunch).not.toHaveBeenCalled();
    fireEvent.change(prompt(), { target: { value: 'はじめて' } });
    expect(start).toBeEnabled();
  });

  it('初期プロンプトは 8,000 字まで。近づくまで何も出さず、超えたら始められない', async () => {
    await setup();
    pick('プロジェクト', /project-b/);
    pick('アカウント', /アカウント 2/);
    const start = screen.getByRole('button', { name: 'Mini で始める' });
    fireEvent.change(prompt(), { target: { value: 'あ'.repeat(7000) } });
    expect(screen.queryByText(/字/)).not.toBeInTheDocument();
    fireEvent.change(prompt(), { target: { value: 'あ'.repeat(7900) } });
    expect(screen.getByText('あと 100 字')).toBeInTheDocument();
    fireEvent.change(prompt(), { target: { value: 'あ'.repeat(8000) } });
    expect(start).toBeEnabled();
    fireEvent.change(prompt(), { target: { value: 'あ'.repeat(8001) } });
    expect(start).toBeDisabled();
    expect(screen.getByText(/8,000 字まで/)).toBeInTheDocument();
  });

  it('クイックセッションが先頭で、選ぶと生きている PC が全部出て、依頼は projectId null・scratch true', async () => {
    const feeds = [...twoPcs(), feedOf('pc-3', 'Old')];
    const { onLaunch } = await setup(feeds, { lastSeen: { 'pc-3': Date.now() - 4 * MIN } });
    const projects = within(group('プロジェクト')).getAllByRole('radio');
    expect(projects.map((r) => r.textContent)).toEqual([expect.stringContaining('クイックセッション'), 'project-b', 'project-a']);
    pick('プロジェクト', /クイックセッション/);
    const pcs = within(group('PC')).getAllByRole('radio');
    expect(pcs.map((r) => r.textContent)).toEqual([expect.stringContaining('Mac'), expect.stringContaining('Mini')]);
    expect(pcs[0]).toHaveTextContent('実行中 1');
    expect(pcs[1]).toHaveTextContent('空き');
    pick('PC', /Mac/);
    expect(within(group('アカウント')).getByRole('radio', { name: /アカウント 1/ })).toHaveTextContent('5 時間 32%');
    fireEvent.change(prompt(), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(specOf(onLaunch)).toMatchObject({ projectName: null, targetDevice: 'pc-1' });
    expect(specOf(onLaunch).payload).toMatchObject({ projectId: null, scratch: true, accountId: 'acc-1', permissionMode: '', model: '' });
  });

  it('PC の欄は、選んだプロジェクトを持つ生きている PC だけ', async () => {
    // 3 分見ていない PC（Old）だけが持つプロジェクトは選べず、Old は PC の欄にも出ない。
    const feeds = [...twoPcs(), feedOf('pc-3', 'Old', { projects: [{ id: 'p-a', name: 'project-a', lastUsedAt: Date.now() }, { id: 'p-z', name: 'project-z', lastUsedAt: Date.now() }] })];
    await setup(feeds, { lastSeen: { 'pc-3': Date.now() - 4 * MIN } });
    expect(within(group('プロジェクト')).queryByRole('radio', { name: /project-z/ })).not.toBeInTheDocument();
    pick('プロジェクト', /project-a/);
    expect(within(group('PC')).getAllByRole('radio').map((r) => r.textContent)).toEqual([expect.stringContaining('Mac'), expect.stringContaining('Mini')]);
    pick('プロジェクト', /project-b/);
    expect(within(group('PC')).getAllByRole('radio').map((r) => r.textContent)).toEqual([expect.stringContaining('Mini')]);
  });

  it('プロジェクトが 5 件を超えると、最近の 5 件の札、検索、すべてのシートから選べる', async () => {
    const many: MobileFeed = feedOf('pc-1', 'Mac', { projects: Array.from({ length: 9 }, (_, i) => ({ id: `p-${i}`, name: `proj-${i}`, lastUsedAt: Date.now() - i * MIN })) });
    const { onLaunch } = await setup([many]);
    expect(within(group('プロジェクト')).getAllByRole('radio')).toHaveLength(6);
    fireEvent.change(screen.getByRole('textbox', { name: 'プロジェクトを検索' }), { target: { value: 'proj-8' } });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '検索結果' })).getByRole('radio', { name: /proj-8/ }));
    fireEvent.change(prompt(), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(specOf(onLaunch)).toMatchObject({ projectName: 'proj-8' });
  });

  describe('詳しい設定（C3）', () => {
    it('閉じていて要約 1 行。開くと権限モード、モデル、effort が出る', async () => {
      await setup();
      expect(advanced()).toHaveAttribute('aria-expanded', 'false');
      expect(advanced()).toHaveTextContent('すべてデフォルト');
      expect(screen.queryByRole('radiogroup', { name: '権限モード' })).not.toBeInTheDocument();
      expect(screen.queryByRole('radiogroup', { name: 'effort' })).not.toBeInTheDocument();
      fireEvent.click(advanced());
      expect(advanced()).toHaveAttribute('aria-expanded', 'true');
      const perms = within(group('権限モード')).getAllByRole('radio');
      expect(perms.map((r) => r.getAttribute('data-value'))).toEqual([...PERMISSION_MODE_VALUES]);
      expect(perms.map((r) => r.textContent)).toEqual(['デフォルト', 'Plan', 'Manual', 'Accept edits', 'Auto', "Don't ask", 'Bypass permissions']);
      const models = within(group('モデル')).getAllByRole('radio');
      expect(models.map((r) => r.textContent)).toEqual(['デフォルト', 'fable', 'opus', 'sonnet', 'haiku']);
      const efforts = within(group('effort')).getAllByRole('radio');
      expect(efforts.map((r) => r.getAttribute('data-value'))).toEqual([...EFFORT_VALUES]);
      expect(efforts.map((r) => r.textContent)).toEqual(['デフォルト', 'low', 'medium', 'high', 'xhigh', 'max']);
      for (const g of [perms, models, efforts]) expect(g[0]).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(advanced());
      expect(screen.queryByRole('radiogroup', { name: 'effort' })).not.toBeInTheDocument();
    });

    it('選んだものは、閉じても要約に出る', async () => {
      await setup();
      fireEvent.click(advanced());
      pick('権限モード', 'Plan');
      pick('モデル', 'opus');
      pick('effort', 'high');
      fireEvent.click(advanced());
      expect(advanced()).toHaveTextContent('権限 Plan · モデル opus · effort high');
    });

    it('選んだ effort が依頼に入る。デフォルトは入れない', async () => {
      const { onLaunch } = await setup();
      pick('プロジェクト', /project-b/);
      pick('アカウント', /アカウント 2/);
      fireEvent.change(prompt(), { target: { value: 'a' } });
      fireEvent.click(screen.getByRole('button', { name: 'Mini で始める' }));
      expect(specOf(onLaunch).payload).not.toHaveProperty('effort');
    });

    it('effort high は依頼の effort に入る。選び直してデフォルトに戻せば消える', async () => {
      const { onLaunch } = await setup();
      pick('プロジェクト', /project-b/);
      pick('アカウント', /アカウント 2/);
      fireEvent.change(prompt(), { target: { value: 'a' } });
      fireEvent.click(advanced());
      pick('effort', 'high');
      pick('effort', 'デフォルト');
      pick('effort', 'xhigh');
      fireEvent.click(screen.getByRole('button', { name: 'Mini で始める' }));
      expect(specOf(onLaunch).payload).toMatchObject({ effort: 'xhigh' });
    });

    it('xhigh と max には使用量の注意が出る', async () => {
      await setup();
      fireEvent.click(advanced());
      expect(screen.queryByText(/使用量が増えます/)).not.toBeInTheDocument();
      pick('effort', 'xhigh');
      expect(screen.getByText('xhigh と max は考える時間が長く、使用量が増えます。')).toBeInTheDocument();
      pick('effort', 'max');
      expect(screen.getByText(/使用量が増えます/)).toBeInTheDocument();
      pick('effort', 'medium');
      expect(screen.queryByText(/使用量が増えます/)).not.toBeInTheDocument();
    });
  });

  it('動きの長さがあっても（実機の CSS）StrictMode で開いて選べ、詳しい設定を畳める', async () => {
    document.documentElement.style.setProperty('--dur-exit', '250ms');
    document.documentElement.style.setProperty('--dur-fast', '200ms');
    try {
      const view = await viewOf(twoPcs());
      render(
        <StrictMode>
          <NewSessionScreen view={view} pairing={pairing} phoneKey={at1(key)} onLaunch={vi.fn()} onClose={vi.fn()} />
        </StrictMode>,
      );
      pick('プロジェクト', /project-a/);
      pick('PC', /Mac/);
      pick('プロジェクト', /project-b/);
      expect(within(group('PC')).getByRole('radio', { name: /Mini/ })).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(advanced());
      pick('effort', 'high');
      fireEvent.click(advanced());
    } finally {
      document.documentElement.style.removeProperty('--dur-exit');
      document.documentElement.style.removeProperty('--dur-fast');
    }
  });

  it('閉じるで受信箱へ戻る', async () => {
    const { onClose } = await setup();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('受けられる PC が無ければ、その旨だけ出す', async () => {
    await setup([feedOf('pc-1', 'Mac')], { lastSeen: { 'pc-1': Date.now() - 10 * MIN } });
    expect(screen.getByRole('status')).toHaveTextContent('新しい会話を受けられる PC がありません');
    expect(screen.queryByRole('radiogroup', { name: 'プロジェクト' })).not.toBeInTheDocument();
  });
});

describe('NewSessionScreen の画像', () => {
  type Put = { launchId: string; n: number; resolve: () => void; reject: (e: unknown) => void };
  let puts: Put[];
  const putImage: PutImage = (_p, _k, launchId, n) => new Promise<void>((resolve, reject) => puts.push({ launchId, n, resolve, reject }));
  const shrink: Shrink = async (f) => ({ data: new Uint8Array(await f.arrayBuffer()), mime: 'image/jpeg' });

  beforeEach(() => {
    puts = [];
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function attach(name: string): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: '画像を添付' }));
    const dlg = await screen.findByRole('dialog', { name: '画像を添付' });
    fireEvent.change(within(dlg).getByLabelText(/写真ライブラリ/), { target: { files: [new File([new Uint8Array(7)], name, { type: 'image/jpeg' })] } });
  }

  it('開いた後に世代が上がっても、画像と依頼は開いたときの鍵で封じる', async () => {
    const epochs: number[] = [];
    const put: PutImage = async (_p, k) => {
      epochs.push(k.epoch);
    };
    const onLaunch = vi.fn<(s: LaunchSpec, k: PhoneKey) => void>();
    const view = await viewOf(twoPcs());
    const key2 = await makeKey();
    const el = (k: PhoneKey) => <NewSessionScreen view={view} pairing={pairing} phoneKey={k} deps={{ putImage: put, shrink }} onLaunch={onLaunch} onClose={vi.fn()} />;
    const { rerender } = render(el(at1(key)));
    rerender(el(at1(key2, 2)));
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    fireEvent.change(prompt(), { target: { value: 'この画面を直して' } });
    await attach('a.jpg');
    await waitFor(() => expect(epochs).toEqual([1]));
    const start = screen.getByRole('button', { name: 'Mac で始める' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(onLaunch.mock.calls[0]![1]).toEqual(at1(key));
  });

  it('画像は先に振った依頼の ID の下に置き、置き終えるまで始められない。依頼に画像の控えと中身を渡す', async () => {
    const { onLaunch } = await setup(twoPcs(), undefined, { putImage, shrink });
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    fireEvent.change(prompt(), { target: { value: 'この画面を直して' } });
    await attach('a.jpg');
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(screen.getByRole('button', { name: '画像の送信中…' })).toBeDisabled();
    await act(async () => puts[0]!.resolve());
    const start = screen.getByRole('button', { name: 'Mac で始める' });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    const s = specOf(onLaunch);
    expect(s.id).toBe(puts[0]!.launchId);
    expect(s.payload.images).toEqual([{ n: 0, mime: 'image/jpeg', bytes: 7 }]);
    expect(s.images?.map((i) => [i.n, i.mime, i.data.length])).toEqual([[0, 'image/jpeg', 7]]);
  });

  it('送れなかった画像があれば始められない', async () => {
    await setup(twoPcs(), undefined, { putImage, shrink });
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    fireEvent.change(prompt(), { target: { value: 'x' } });
    await attach('a.jpg');
    await waitFor(() => expect(puts).toHaveLength(1));
    await act(async () => puts[0]!.reject(new Error('x')));
    expect(screen.getByRole('button', { name: '送信できなかった画像があります' })).toBeDisabled();
  });

  it('画像だけでも始められる（初期プロンプトが空でも）', async () => {
    const { onLaunch } = await setup(twoPcs(), undefined, { putImage, shrink });
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    await attach('a.jpg');
    await waitFor(() => expect(puts).toHaveLength(1));
    await act(async () => puts[0]!.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(specOf(onLaunch).payload.prompt).toBe('');
  });
});

describe('NewSessionScreen と古い PC、古い Worker', () => {
  const asker = (): Asker => ({ commands: vi.fn(async () => []), files: vi.fn(async () => []) });

  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('caps の無い（rc.1 の）PC を選ぶと「＋」と effort の欄を出さず、依頼に effort を入れない', async () => {
    const { onLaunch } = await setup([feedOf('pc-1', 'Mac', { caps: undefined })]);
    fireEvent.click(advanced());
    // PC を選ぶ前は、どちらも出る。
    expect(screen.getByRole('button', { name: '画像を添付' })).toBeInTheDocument();
    pick('effort', 'high');
    // PC は 1 台なので、プロジェクトを選ぶと決まる。
    pick('プロジェクト', /project-a/);
    expect(screen.queryByRole('radiogroup', { name: 'effort' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '画像を添付' })).not.toBeInTheDocument();
    expect(advanced()).not.toHaveTextContent('effort');
    fireEvent.change(prompt(), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(specOf(onLaunch).payload).not.toHaveProperty('effort');
  });

  it('caps の無い PC では、/ と @ を問い合わせずに「この PC は候補を返せません」', async () => {
    const a = asker();
    await setup([feedOf('pc-1', 'Mac', { caps: undefined })], undefined, { asker: a });
    pick('プロジェクト', /project-a/);
    act(() => prompt().focus());
    fireEvent.change(prompt(), { target: { value: '/', selectionStart: 1, selectionEnd: 1 } });
    await waitFor(() => expect(screen.getByText('この PC は候補を返せません')).toBeInTheDocument());
    expect(a.commands).not.toHaveBeenCalled();
  });

  it('画像を付けた後に caps の無い PC を選ぶと始められない', async () => {
    const puts: (() => void)[] = [];
    const putImage: PutImage = () => new Promise<void>((resolve) => puts.push(resolve));
    const shrink: Shrink = async (f) => ({ data: new Uint8Array(await f.arrayBuffer()), mime: 'image/jpeg' });
    const feeds = twoPcs();
    feeds[1] = { ...feeds[1]!, caps: undefined };
    await setup(feeds, undefined, { putImage, shrink });
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    fireEvent.click(screen.getByRole('button', { name: '画像を添付' }));
    const dlg = await screen.findByRole('dialog', { name: '画像を添付' });
    fireEvent.change(within(dlg).getByLabelText(/写真ライブラリ/), { target: { files: [new File([new Uint8Array(7)], 'a.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(puts).toHaveLength(1));
    await act(async () => puts[0]!());
    pick('PC', /Mini/);
    pick('アカウント', /アカウント 2/);
    expect(screen.getByRole('button', { name: 'この PC では画像を添付できません' })).toBeDisabled();
  });

  it('Worker が呼び鈴の版に届かなければ「＋」を出さず、/ は問い合わせずに「この PC は候補を返せません」', async () => {
    const a = asker();
    await setup(twoPcs(), undefined, { asker: a }, { workerCompat: MOBILE_BELL_MIN_WORKER_COMPAT - 1 });
    pick('プロジェクト', /project-a/);
    pick('PC', /Mac/);
    expect(screen.queryByRole('button', { name: '画像を添付' })).not.toBeInTheDocument();
    act(() => prompt().focus());
    fireEvent.change(prompt(), { target: { value: '/', selectionStart: 1, selectionEnd: 1 } });
    await waitFor(() => expect(screen.getByText('この PC は候補を返せません')).toBeInTheDocument());
    expect(a.commands).not.toHaveBeenCalled();
    // effort は PC が効かせるので、Worker が古くても出す。
    fireEvent.click(advanced());
    expect(group('effort')).toBeInTheDocument();
  });
});
