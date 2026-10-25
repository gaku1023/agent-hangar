import { PHONE_MAX_AGE_MS, type MobileFeed } from '@agent-hangar/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openInbox, type InboxView } from '../inbox.ts';
import { loadLaunchDefaults, saveLaunchDefaults } from '../launchDefaults.ts';
import * as push from '../push.ts';
import { loadPairing, savePairing, type Pairing } from '../store.ts';
import { feedOf, inboxOf, makeKey, ring } from '../test/fixtures.ts';
import { json, WORKER } from '../test/pairText.ts';
import { SettingsScreen } from './SettingsScreen.tsx';

vi.mock('../push.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../push.ts')>();
  return { ...actual, readPushStatus: vi.fn(), turnOnPush: vi.fn(), turnOffPush: vi.fn(), setPushQuiet: vi.fn(), pushQuiet: vi.fn() };
});

const pairing: Pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };
const read = vi.mocked(push.readPushStatus);
const on = vi.mocked(push.turnOnPush);
const off = vi.mocked(push.turnOffPush);
const setQuiet = vi.mocked(push.setPushQuiet);
const quietOf = vi.mocked(push.pushQuiet);

let key: CryptoKey;
let fetchMock: ReturnType<typeof vi.fn>;
let leaveRes: () => Promise<Response>;

const twoPcs = (): MobileFeed[] => [
  feedOf('pc-1', 'MacBook', { accounts: [{ id: 'acc-w', name: '会社', color: '#4a63e8', fiveHour: null, sevenDay: null }] }),
  feedOf('pc-2', 'Windows', {
    accounts: [
      { id: 'acc-w', name: '会社', color: '#4a63e8', fiveHour: null, sevenDay: null },
      { id: 'acc-u', name: '大学', color: '#3a8f5c', fiveHour: null, sevenDay: null },
    ],
  }),
];

async function viewOf(feeds: MobileFeed[] = twoPcs()): Promise<InboxView> {
  return openInbox(await inboxOf(key, feeds, { now: Date.now() }), ring(key), new Date());
}

beforeEach(async () => {
  key = await makeKey();
  read.mockResolvedValue({ kind: 'on' });
  on.mockResolvedValue({ kind: 'on' });
  off.mockResolvedValue({ kind: 'off' });
  setQuiet.mockResolvedValue(undefined);
  quietOf.mockReturnValue({ start: 23 * 60, end: 7 * 60 });
  leaveRes = async () => new Response(null, { status: 204 });
  fetchMock = vi.fn(async (url: string) => (String(url).endsWith('/m/leave') ? leaveRes() : json({ error: 'not found' }, 404)));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Opts = { view?: InboxView | null; pairing?: Pairing };
async function setup(o: Opts = {}) {
  const onClose = vi.fn();
  const onRescan = vi.fn();
  const onLeft = vi.fn();
  const view = o.view === undefined ? await viewOf() : o.view;
  const p = o.pairing ?? pairing;
  const r = render(<SettingsScreen open pairing={p} view={view} onClose={onClose} onRescan={onRescan} onLeft={onLeft} />);
  return { onClose, onRescan, onLeft, ...r };
}

const row = (name: RegExp) => screen.getByRole('button', { name });
const openPage = (name: RegExp) => fireEvent.click(row(name));
const back = () => fireEvent.click(screen.getByRole('button', { name: '‹ 設定' }));
const sw = (name: string) => screen.getByRole('switch', { name });

describe('SettingsScreen の一覧', () => {
  it('「設定」と「完了」、3 行の一覧に今の値を添える', async () => {
    const { onClose } = await setup();
    expect(screen.getByRole('dialog', { name: '設定' })).toBeInTheDocument();
    await waitFor(() => expect(row(/^通知/)).toHaveTextContent('オン・23:00〜7:00 は鳴らさない'));
    expect(row(/^新しい会話のデフォルト/)).toHaveTextContent('すべてデフォルト');
    expect(row(/^接続/)).toHaveTextContent('MacBook、Windows');
    fireEvent.click(screen.getByRole('button', { name: '完了' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('通知の値は、夜も鳴らすなら「オン・夜も鳴らす」、オフなら「オフ」', async () => {
    quietOf.mockReturnValue(null);
    await setup();
    await waitFor(() => expect(row(/^通知/)).toHaveTextContent('オン・夜も鳴らす'));
    read.mockResolvedValue({ kind: 'off' });
    await setup();
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^通知/ })[1]).toHaveTextContent('オフ'));
  });

  it('既定の値は PC とアカウントの名前と、デフォルトでない値を並べる', async () => {
    saveLaunchDefaults({ pc: 'pc-1', account: 'acc-w', permissionMode: '', model: 'opus', effort: '' });
    await setup();
    expect(row(/^新しい会話のデフォルト/)).toHaveTextContent('MacBook・会社・opus');
  });

  it('行を押すと右からページが出て、一覧は押せなくなる。「‹ 設定」で戻る', async () => {
    const { container } = await setup();
    openPage(/^接続/);
    expect(screen.getByRole('heading', { name: '接続' })).toBeInTheDocument();
    expect(container.querySelector('.set-list')).toHaveAttribute('inert');
    expect(container.querySelector('.set-list')).toHaveClass('pushed');
    back();
    expect(screen.queryByRole('heading', { name: '接続' })).not.toBeInTheDocument();
    expect(container.querySelector('.set-list')).not.toHaveAttribute('inert');
  });
});

describe('SettingsScreen の通知', () => {
  it('オンなら「通知を受け取る」と「夜は鳴らさない」がオンで、開始と終了を出す', async () => {
    await setup();
    openPage(/^通知/);
    await waitFor(() => expect(sw('通知を受け取る')).toHaveAttribute('aria-checked', 'true'));
    expect(sw('夜は鳴らさない')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('開始')).toHaveValue('23:00');
    expect(screen.getByLabelText('終了')).toHaveValue('07:00');
    expect(screen.getByText('ほかのスマホには効きません。')).toBeInTheDocument();
    expect(screen.queryByText(/このスマホの時刻で判定します/)).not.toBeInTheDocument();
    const info = screen.getByRole('button', { name: '通知の説明' });
    expect(info).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(info);
    expect(info).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(info.getAttribute('aria-controls')!)).toHaveTextContent('このスマホの時刻で判定します。');
    expect(screen.getByRole('heading', { name: '通知' })).toBeInTheDocument();
  });

  it('時刻を変えるとすぐ保存し、「保存中…」から「保存しました」に変わる', async () => {
    let done!: () => void;
    setQuiet.mockReturnValue(new Promise<void>((r) => (done = r)));
    await setup();
    openPage(/^通知/);
    await waitFor(() => expect(sw('通知を受け取る')).toHaveAttribute('aria-checked', 'true'));
    fireEvent.change(screen.getByLabelText('開始'), { target: { value: '22:30' } });
    expect(setQuiet).toHaveBeenCalledWith(pairing, { start: 22 * 60 + 30, end: 7 * 60 });
    expect(screen.getByText('保存中…')).toBeInTheDocument();
    await act(async () => done());
    expect(await screen.findByText('保存しました')).toBeInTheDocument();
    back();
    expect(row(/^通知/)).toHaveTextContent('オン・22:30〜7:00 は鳴らさない');
  });

  it('「夜は鳴らさない」を切ると null を送り、時刻の欄を閉じる', async () => {
    await setup();
    openPage(/^通知/);
    await waitFor(() => expect(sw('夜は鳴らさない')).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(sw('夜は鳴らさない'));
    expect(setQuiet).toHaveBeenCalledWith(pairing, null);
    expect(sw('夜は鳴らさない')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByLabelText('開始')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('保存しました')).toBeInTheDocument());
  });

  it('開始と終了が同じなら、夜も鳴らすと同じ扱い（null を送る）', async () => {
    await setup();
    openPage(/^通知/);
    await waitFor(() => expect(sw('通知を受け取る')).toHaveAttribute('aria-checked', 'true'));
    fireEvent.change(screen.getByLabelText('開始'), { target: { value: '07:00' } });
    expect(setQuiet).toHaveBeenLastCalledWith(pairing, null);
  });

  it('保存できなければ失敗の文を出す', async () => {
    setQuiet.mockRejectedValue(new push.PushError('network'));
    await setup();
    openPage(/^通知/);
    await waitFor(() => expect(sw('夜は鳴らさない')).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(sw('夜は鳴らさない'));
    expect(await screen.findByText('通知を設定できませんでした。通信を確認して、もう一度タップしてください。')).toBeInTheDocument();
    expect(screen.queryByText('保存しました')).not.toBeInTheDocument();
  });

  it('オフなら「夜は鳴らさない」を出さず、押した処理の中で turnOnPush を呼んでオンにする', async () => {
    read.mockResolvedValue({ kind: 'off' });
    await setup();
    openPage(/^通知/);
    await waitFor(() => expect(sw('通知を受け取る')).toHaveAttribute('aria-checked', 'false'));
    expect(screen.queryByRole('switch', { name: '夜は鳴らさない' })).not.toBeInTheDocument();
    fireEvent.click(sw('通知を受け取る'));
    // 押した処理の中で呼ぶ（iOS は操作の外で許可を求めると断る）。
    expect(on).toHaveBeenCalledWith(pairing, { quiet: { start: 23 * 60, end: 7 * 60 } });
    await waitFor(() => expect(sw('通知を受け取る')).toHaveAttribute('aria-checked', 'true'));
    expect(sw('夜は鳴らさない')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw('通知を受け取る'));
    expect(off).toHaveBeenCalledWith(pairing);
    await waitFor(() => expect(sw('通知を受け取る')).toHaveAttribute('aria-checked', 'false'));
  });

  it('押している間はスイッチを押せない', async () => {
    let done!: (s: push.PushStatus) => void;
    read.mockResolvedValue({ kind: 'off' });
    on.mockReturnValue(new Promise((r) => (done = r)));
    await setup();
    openPage(/^通知/);
    await waitFor(() => expect(sw('通知を受け取る')).toHaveAttribute('aria-checked', 'false'));
    fireEvent.click(sw('通知を受け取る'));
    expect(sw('通知を受け取る')).toBeDisabled();
    fireEvent.click(sw('通知を受け取る'));
    expect(on).toHaveBeenCalledTimes(1);
    await act(async () => done({ kind: 'on' }));
    expect(sw('通知を受け取る')).toBeEnabled();
  });

  it('拒否してあれば、許可し直す案内', async () => {
    read.mockResolvedValue({ kind: 'denied' });
    await setup();
    openPage(/^通知/);
    expect(await screen.findByText('通知が許可されていません。設定で hangar の通知を許可してから、もう一度タップしてください。')).toBeInTheDocument();
  });

  it('使えないブラウザでは、その旨と iPhone の案内（スイッチは出さない）', async () => {
    read.mockResolvedValue({ kind: 'unsupported', ios: true });
    await setup();
    await waitFor(() => expect(row(/^通知/)).toHaveTextContent('使えません'));
    openPage(/^通知/);
    expect(screen.getByText('このブラウザでは通知を使えません')).toBeInTheDocument();
    expect(screen.getByText('iPhone と iPad では、ホーム画面に追加した hangar で「通知を受け取る」をタップすると使えます。')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('失敗したら失敗の文', async () => {
    read.mockResolvedValue({ kind: 'off' });
    on.mockRejectedValue(new push.PushError('network'));
    await setup();
    openPage(/^通知/);
    await waitFor(() => expect(sw('通知を受け取る')).toHaveAttribute('aria-checked', 'false'));
    fireEvent.click(sw('通知を受け取る'));
    expect(await screen.findByText('通知を設定できませんでした。通信を確認して、もう一度タップしてください。')).toBeInTheDocument();
    expect(sw('通知を受け取る')).toHaveAttribute('aria-checked', 'false');
  });
});

describe('SettingsScreen の新しい会話のデフォルト', () => {
  it('5 行があり、押すとその下に選択肢が開く。選ぶとすぐ保存して値が変わる', async () => {
    await setup();
    openPage(/^新しい会話のデフォルト/);
    for (const n of ['PC', 'アカウント', '権限', 'モデル', 'effort']) expect(screen.getByRole('button', { name: new RegExp(`^${n}`) })).toBeInTheDocument();
    expect(screen.queryByText(/最初から選んでおく値です/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^PC/ }));
    const pcs = screen.getByRole('radiogroup', { name: 'PC' });
    expect(within(pcs).getAllByRole('radio').map((r) => r.textContent)).toEqual(['指定なし', 'MacBook', 'Windows']);
    fireEvent.click(within(pcs).getByRole('radio', { name: 'Windows' }));
    expect(loadLaunchDefaults().pc).toBe('pc-2');
    expect(screen.getByRole('button', { name: /^PC/ })).toHaveTextContent('Windows');
    // アカウントは選んだ PC のもの。
    fireEvent.click(screen.getByRole('button', { name: /^アカウント/ }));
    expect(screen.queryByRole('radiogroup', { name: 'PC' })).not.toBeInTheDocument();
    const accts = screen.getByRole('radiogroup', { name: 'アカウント' });
    expect(within(accts).getAllByRole('radio').map((r) => r.textContent)).toEqual(['指定なし', '会社', '大学']);
    fireEvent.click(within(accts).getByRole('radio', { name: '大学' }));
    expect(loadLaunchDefaults().account).toBe('acc-u');
    back();
    expect(row(/^新しい会話のデフォルト/)).toHaveTextContent('Windows・大学');
  });

  it('権限、モデル、effort の選択肢は新しい会話の画面と同じ並び', async () => {
    await setup();
    openPage(/^新しい会話のデフォルト/);
    fireEvent.click(screen.getByRole('button', { name: /^権限/ }));
    const perms = within(screen.getByRole('radiogroup', { name: '権限' })).getAllByRole('radio');
    expect(perms[0]).toHaveTextContent('デフォルト');
    expect(perms.map((r) => r.textContent)).toContain('Bypass permissions');
    fireEvent.click(screen.getByRole('button', { name: /^effort/ }));
    const efforts = within(screen.getByRole('radiogroup', { name: 'effort' })).getAllByRole('radio').map((r) => r.textContent);
    expect(efforts).toEqual(['デフォルト', 'low', 'medium', 'high', 'xhigh', 'max']);
    fireEvent.click(screen.getByRole('radio', { name: 'xhigh' }));
    expect(loadLaunchDefaults().effort).toBe('xhigh');
  });

  it('PC を変えて、前のアカウントがその PC に無ければ、アカウントを指定なしに戻す', async () => {
    saveLaunchDefaults({ pc: 'pc-2', account: 'acc-u', permissionMode: '', model: '', effort: '' });
    await setup();
    openPage(/^新しい会話のデフォルト/);
    fireEvent.click(screen.getByRole('button', { name: /^PC/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'MacBook' }));
    expect(loadLaunchDefaults()).toMatchObject({ pc: 'pc-1', account: null });
  });
});

describe('SettingsScreen の既定のエージェント', () => {
  const withOpencode = (): MobileFeed[] => {
    const fs = twoPcs();
    fs[1] = { ...fs[1]!, caps: { asks: true, images: true, effort: true, agents: ['claude-code', 'opencode'] } };
    return fs;
  };

  it('opencode を有効にした PC が無ければ、エージェントの行を出さない', async () => {
    await setup();
    openPage(/^新しい会話のデフォルト/);
    expect(screen.queryByRole('button', { name: /^エージェント/ })).not.toBeInTheDocument();
  });

  it('opencode のある PC があれば、エージェントの行を出し、選ぶとすぐ保存する', async () => {
    await setup({ view: await viewOf(withOpencode()) });
    openPage(/^新しい会話のデフォルト/);
    const rowBtn = screen.getByRole('button', { name: /^エージェント/ });
    expect(rowBtn).toHaveTextContent('Claude Code');
    fireEvent.click(rowBtn);
    const agents = screen.getByRole('radiogroup', { name: 'エージェント' });
    expect(within(agents).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Claude Code', 'opencode']);
    fireEvent.click(within(agents).getByRole('radio', { name: 'opencode' }));
    expect(loadLaunchDefaults().agent).toBe('opencode');
    expect(screen.getByRole('button', { name: /^エージェント/ })).toHaveTextContent('opencode');
    back();
    expect(row(/^新しい会話のデフォルト/)).toHaveTextContent('opencode');
    openPage(/^新しい会話のデフォルト/);
    fireEvent.click(screen.getByRole('button', { name: /^エージェント/ }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'エージェント' })).getByRole('radio', { name: 'Claude Code' }));
    expect(loadLaunchDefaults()).not.toHaveProperty('agent');
  });

  it('既定が opencode なら、opencode のある PC が今無くても行を出す（戻せるように）', async () => {
    saveLaunchDefaults({ pc: null, account: null, permissionMode: '', model: '', effort: '', agent: 'opencode' });
    await setup();
    openPage(/^新しい会話のデフォルト/);
    expect(screen.getByRole('button', { name: /^エージェント/ })).toHaveTextContent('opencode');
  });
});

describe('SettingsScreen の接続', () => {
  it('接続先、接続した日、接続し直す期限を出す', async () => {
    const joinedAt = new Date(2026, 9, 18, 12, 0).getTime();
    await setup({ pairing: { ...pairing, joinedAt } });
    openPage(/^接続/);
    const page = screen.getByRole('heading', { name: '接続' }).closest('section')!;
    expect(within(page).getByText('MacBook、Windows')).toBeInTheDocument();
    expect(within(page).getByText('10月18日')).toBeInTheDocument();
    const until = new Date(joinedAt + PHONE_MAX_AGE_MS);
    expect(within(page).getByText(`${until.getMonth() + 1}月${until.getDate()}日まで`)).toBeInTheDocument();
    expect(within(page).queryByText(/30 日使わない/)).not.toBeInTheDocument();
    expect(within(page).queryByText(/90 日たつと/)).not.toBeInTheDocument();
    const info = within(page).getByRole('button', { name: '接続の説明' });
    fireEvent.click(info);
    expect(info).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(info.getAttribute('aria-controls')!)).toHaveTextContent('30 日使わないと切れます。');
    fireEvent.click(info);
    expect(within(page).queryByText('30 日使わないと切れます。')).not.toBeInTheDocument();
  });

  it('接続した日が無ければ（前の接続）「不明」で、期限は出さない', async () => {
    await setup();
    openPage(/^接続/);
    expect(screen.getByText('不明')).toBeInTheDocument();
    expect(screen.queryByText('接続し直す期限')).not.toBeInTheDocument();
  });

  it('「QR を読んで接続し直す」で参加の画面へ', async () => {
    const { onRescan } = await setup();
    openPage(/^接続/);
    fireEvent.click(screen.getByRole('button', { name: 'QR を読んで接続し直す' }));
    expect(onRescan).toHaveBeenCalledTimes(1);
  });

  const unpair = async () => {
    openPage(/^接続/);
    fireEvent.click(screen.getByRole('button', { name: 'このスマホの接続を解除' }));
    const dlg = screen.getByRole('dialog', { name: 'このスマホの接続を解除しますか？' });
    expect(within(dlg).getByText('受信箱が見えなくなり、通知も止まります。また使うときは、PC の設定で QR を出して読み直してください。')).toBeInTheDocument();
    return dlg;
  };

  it('「キャンセル」なら何もしない', async () => {
    const { onLeft } = await setup();
    const dlg = await unpair();
    fireEvent.click(within(dlg).getByRole('button', { name: 'キャンセル' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'このスマホの接続を解除しますか？' })).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onLeft).not.toHaveBeenCalled();
  });

  it('外すと POST /m/leave を送り、通知の購読と、接続、既定を消して参加の画面へ', async () => {
    savePairing(pairing);
    saveLaunchDefaults({ pc: 'pc-1', account: null, permissionMode: '', model: '', effort: '' });
    const { onLeft } = await setup();
    const dlg = await unpair();
    fireEvent.click(within(dlg).getByRole('button', { name: '接続を解除' }));
    await waitFor(() => expect(onLeft).toHaveBeenCalledWith('left'));
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === `${WORKER}/m/leave`)).toHaveLength(1);
    expect(off).toHaveBeenCalledWith(pairing);
    expect(loadPairing()).toBeNull();
    expect(loadLaunchDefaults().pc).toBeNull();
  });

  it('401 でも外れたとみなす。404（古い Worker）は手元だけ消して old を渡す', async () => {
    leaveRes = async () => json({ error: 'not found' }, 404);
    savePairing(pairing);
    const { onLeft } = await setup();
    const dlg = await unpair();
    fireEvent.click(within(dlg).getByRole('button', { name: '接続を解除' }));
    await waitFor(() => expect(onLeft).toHaveBeenCalledWith('old'));
    expect(loadPairing()).toBeNull();
  });

  it('通信に失敗したら消さずに失敗の文を出す', async () => {
    leaveRes = async () => {
      throw new TypeError('offline');
    };
    savePairing(pairing);
    const { onLeft } = await setup();
    const dlg = await unpair();
    fireEvent.click(within(dlg).getByRole('button', { name: '接続を解除' }));
    expect(await within(dlg).findByText('接続を解除できませんでした。通信を確認して、もう一度タップしてください。')).toBeInTheDocument();
    expect(onLeft).not.toHaveBeenCalled();
    expect(off).not.toHaveBeenCalled();
    expect(loadPairing()).toEqual(pairing);
  });
});
