import { COMPAT_VERSION, aadAnswer, aadLaunch, open, seal, type MobileLaunchAnswer, type MobileLaunchPayload } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LaunchError } from './api.ts';
import { LAUNCH_POLL_MS, launchChoices, requestLaunch, waitLaunch } from './launch.ts';
import { at1, feedOf, makeKey, MIN, NOW } from './test/fixtures.ts';
import { json, WORKER } from './test/pairText.ts';

const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };
let key: CryptoKey;
let fetchMock: ReturnType<typeof vi.fn>;

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

const project = (id: string, name: string, lastUsedAt: number | null) => ({ id, name, lastUsedAt });
const account = (id: string, name: string) => ({ id, name, color: '#4a63e8', fiveHour: null, sevenDay: null });

describe('launchChoices', () => {
  it('場所の無い PC と 3 分見ていない PC は選べない', () => {
    const feeds = [
      feedOf('pc-1', 'Mac', { projects: [project('p-a', 'project-a', NOW - 5 * MIN)] }),
      feedOf('pc-2', 'Mini', { projects: [project('p-a', 'project-a', NOW - 9 * MIN), project('p-b', 'project-b', NOW - MIN)] }),
      feedOf('pc-3', 'Old', { projects: [project('p-a', 'project-a', NOW), project('p-c', 'project-c', NOW)] }),
    ];
    const c = launchChoices(feeds, new Set(['pc-1', 'pc-2']));
    expect(c.projects.map((p) => p.id)).toEqual(['p-b', 'p-a']);
    expect(c.projects.find((p) => p.id === 'p-a')!.deviceIds).toEqual(['pc-1', 'pc-2']);
    expect(c.projects.find((p) => p.id === 'p-b')!.deviceIds).toEqual(['pc-2']);
    // 3 分見ていない PC だけが場所を持つプロジェクトは出さない。
    expect(c.projects.some((p) => p.id === 'p-c')).toBe(false);
  });

  it('同じ id のプロジェクトは新しく使った方の名前と時刻', () => {
    const feeds = [
      feedOf('pc-1', 'Mac', { projects: [project('p-a', 'project-a', NOW - 9 * MIN)] }),
      feedOf('pc-2', 'Mini', { projects: [project('p-a', 'project-a2', NOW - MIN)] }),
    ];
    const c = launchChoices(feeds, new Set(['pc-1', 'pc-2']));
    expect(c.projects).toEqual([{ id: 'p-a', name: 'project-a2', lastUsedAt: NOW - MIN, deviceIds: ['pc-1', 'pc-2'] }]);
  });

  it('すぐ始めるは生きている PC ならどれでも選べ、依頼は projectId null・scratch true', async () => {
    const feeds = [feedOf('pc-1', 'Mac', { projects: [] }), feedOf('pc-2', 'Mini'), feedOf('pc-3', 'Old')];
    const c = launchChoices(feeds, new Set(['pc-1', 'pc-2']));
    expect(c.scratchDeviceIds).toEqual(['pc-1', 'pc-2']);

    fetchMock.mockResolvedValue(json({ id: 'x', status: 'pending', sealedAnswer: null }, 201));
    await requestLaunch(pairing, at1(key), { targetDevice: 'pc-1', payload: { projectId: null, scratch: true, accountId: 'acc-1', permissionMode: '', model: '', prompt: 'はじめて' } });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { id: string; targetDevice: string; sealed: string };
    const payload = await open<MobileLaunchPayload>(key, aadLaunch(body.id, 'pc-1'), body.sealed);
    expect(payload.projectId).toBeNull();
    expect(payload.scratch).toBe(true);
  });

  it('アカウントは選んだ PC のものだけ', () => {
    const feeds = [feedOf('pc-1', 'Mac', { accounts: [account('acc-1', 'アカウント 1')] }), feedOf('pc-2', 'Mini', { accounts: [account('acc-2', 'アカウント 2'), account('acc-3', 'アカウント 3')] })];
    const c = launchChoices(feeds, new Set(['pc-1', 'pc-2']));
    expect(c.accountsOf('pc-1').map((a) => a.id)).toEqual(['acc-1']);
    expect(c.accountsOf('pc-2').map((a) => a.id)).toEqual(['acc-2', 'acc-3']);
    expect(c.accountsOf('pc-9')).toEqual([]);
  });
});

describe('requestLaunch', () => {
  it('requestLaunch の sealed は aadLaunch(id, targetDevice) で開け、createdAt が入る', async () => {
    fetchMock.mockResolvedValue(json({ id: 'x', status: 'pending', sealedAnswer: null }, 201));
    const before = Date.now();
    const id = await requestLaunch(pairing, at1(key), { targetDevice: 'pc-2', payload: { projectId: 'p-a', scratch: false, accountId: 'acc-1', permissionMode: 'plan', model: 'opus', prompt: 'テストを足して' } });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${WORKER}/m/launches`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-1');
    expect(headers['x-hangar-compat']).toBe(String(COMPAT_VERSION));
    const body = JSON.parse(init.body as string) as { id: string; targetDevice: string; sealed: string };
    expect(body.id).toBe(id);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.targetDevice).toBe('pc-2');
    const payload = await open<MobileLaunchPayload>(key, aadLaunch(id, 'pc-2'), body.sealed);
    expect(payload).toMatchObject({ v: 1, projectId: 'p-a', scratch: false, accountId: 'acc-1', permissionMode: 'plan', model: 'opus', prompt: 'テストを足して' });
    expect(payload.createdAt).toBeGreaterThanOrEqual(before);
    expect(payload.createdAt).toBeLessThanOrEqual(Date.now());
    // ほかの宛先の AAD では開けない（付け替えを PC が見破れる）。
    await expect(open(key, aadLaunch(id, 'pc-1'), body.sealed)).rejects.toThrow();
  });

  it('429 は rate-limited、404 は not-found で断る', async () => {
    const p = { targetDevice: 'pc-1', payload: { projectId: 'p-a', scratch: false, accountId: 'acc-1', permissionMode: '', model: '', prompt: 'a' } };
    fetchMock.mockResolvedValueOnce(json({ error: 'rate limited' }, 429));
    await expect(requestLaunch(pairing, at1(key), p)).rejects.toMatchObject({ reason: 'rate-limited' });
    fetchMock.mockResolvedValueOnce(json({ error: 'not found' }, 404));
    await expect(requestLaunch(pairing, at1(key), p)).rejects.toBeInstanceOf(LaunchError);
    fetchMock.mockResolvedValueOnce(json({ error: 'not found' }, 404));
    await expect(requestLaunch(pairing, at1(key), p)).rejects.toMatchObject({ reason: 'not-found' });
  });

  it('通信が切れたら同じ id で 1 度だけ送り直す', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(json({ id: 'x', status: 'pending', sealedAnswer: null }, 201));
    const id = await requestLaunch(pairing, at1(key), { targetDevice: 'pc-1', payload: { projectId: 'p-a', scratch: false, accountId: 'acc-1', permissionMode: '', model: '', prompt: 'a' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const ids = fetchMock.mock.calls.map((c) => (JSON.parse((c[1] as RequestInit).body as string) as { id: string }).id);
    expect(ids).toEqual([id, id]);
  });
  it('skewMs の分だけ createdAt がずれる（Worker の時刻に寄せる）', async () => {
    fetchMock.mockResolvedValue(json({ id: 'x', status: 'pending', sealedAnswer: null }, 201));
    const before = Date.now();
    const id = await requestLaunch(pairing, at1(key), { targetDevice: 'pc-1', skewMs: 90 * MIN, payload: { projectId: 'p-a', scratch: false, accountId: 'acc-1', permissionMode: '', model: '', prompt: 'a' } });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as { sealed: string };
    const payload = await open<MobileLaunchPayload>(key, aadLaunch(id, 'pc-1'), body.sealed);
    expect(payload.createdAt).toBeGreaterThanOrEqual(before + 90 * MIN);
    expect(payload.createdAt).toBeLessThanOrEqual(Date.now() + 90 * MIN);
  });

  it('id を渡すとその id で送る（送り直しで Worker が行を増やさない）', async () => {
    fetchMock.mockResolvedValue(json({ id: 'l-keep', status: 'pending', sealedAnswer: null }, 201));
    const id = await requestLaunch(pairing, at1(key), { id: 'l-keep', targetDevice: 'pc-1', payload: { projectId: 'p-a', scratch: false, accountId: 'acc-1', permissionMode: '', model: '', prompt: 'a' } });
    expect(id).toBe('l-keep');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as { id: string; sealed: string };
    expect(body.id).toBe('l-keep');
    await expect(open(key, aadLaunch('l-keep', 'pc-1'), body.sealed)).resolves.toMatchObject({ prompt: 'a' });
  });
});

describe('waitLaunch', () => {
  it('読み直しの間隔は 2 秒（呼び鈴で数秒のうちに答えが来る）', () => {
    expect(LAUNCH_POLL_MS).toBe(2_000);
  });

  const status = async (id: string, s: 'pending' | 'claimed' | 'started' | 'failed' | 'expired', answer?: MobileLaunchAnswer) =>
    json({ id, status: s, sealedAnswer: answer ? await seal(key, aadAnswer(id), answer) : null });

  it('waitLaunch は started で止まり答えを渡す', async () => {
    vi.useFakeTimers();
    const answer: MobileLaunchAnswer = { ok: true, sessionId: 's-1', title: '会話 1' };
    const replies = [await status('l-1', 'pending'), await status('l-1', 'claimed'), await status('l-1', 'started', answer)];
    fetchMock.mockImplementation(async () => replies.shift() ?? (await status('l-1', 'started', answer)));
    const onStage = vi.fn();
    waitLaunch(pairing, at1(key), 'l-1', { onStage });
    expect(onStage).toHaveBeenLastCalledWith('waiting');
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    expect(onStage).not.toHaveBeenCalledWith('started', expect.anything());
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    await vi.waitFor(() => expect(onStage).toHaveBeenLastCalledWith('started', answer));
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${WORKER}/m/launches/l-1`);
    expect((init.headers as Record<string, string>)['x-hangar-compat']).toBe(String(COMPAT_VERSION));
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('最初に claimed を見たときだけ onClaimed を呼ぶ', async () => {
    vi.useFakeTimers();
    const replies = [await status('l-c', 'pending'), await status('l-c', 'claimed'), await status('l-c', 'claimed')];
    fetchMock.mockImplementation(async () => replies.shift() ?? (await status('l-c', 'claimed')));
    const onClaimed = vi.fn();
    waitLaunch(pairing, at1(key), 'l-c', { onStage: vi.fn(), onClaimed });
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    expect(onClaimed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    expect(onClaimed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS * 3);
    expect(onClaimed).toHaveBeenCalledTimes(1);
  });

  it('failed は開いた答えを渡す', async () => {
    vi.useFakeTimers();
    const answer: MobileLaunchAnswer = { ok: false, reason: 'project-missing' };
    const reply = await status('l-2', 'failed', answer);
    fetchMock.mockImplementation(async () => reply.clone());
    const onStage = vi.fn();
    waitLaunch(pairing, at1(key), 'l-2', { onStage });
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    await vi.waitFor(() => expect(onStage).toHaveBeenLastCalledWith('failed', answer));
  });

  it('80 秒で expired', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => status('l-3', 'pending'));
    const onStage = vi.fn();
    waitLaunch(pairing, at1(key), 'l-3', { onStage });
    await vi.advanceTimersByTimeAsync(79_000);
    expect(onStage).not.toHaveBeenCalledWith('expired');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStage).toHaveBeenLastCalledWith('expired');
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('claimed を見た後に時間切れになったら unanswered（受け取ったが答えが届いていない）', async () => {
    vi.useFakeTimers();
    const replies = [await status('l-5', 'pending'), await status('l-5', 'claimed')];
    fetchMock.mockImplementation(async () => replies.shift() ?? (await status('l-5', 'claimed')));
    const onStage = vi.fn();
    waitLaunch(pairing, at1(key), 'l-5', { onStage });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(onStage).toHaveBeenLastCalledWith('unanswered');
    expect(onStage).not.toHaveBeenCalledWith('expired');
  });

  it('Worker が expired と言ったら expired', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => status('l-4', 'expired'));
    const onStage = vi.fn();
    waitLaunch(pairing, at1(key), 'l-4', { onStage });
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    expect(onStage).toHaveBeenLastCalledWith('expired');
  });

  it('止めたら読まない', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => status('l-5', 'pending'));
    const onStage = vi.fn();
    const stop = waitLaunch(pairing, at1(key), 'l-5', { onStage });
    stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onStage).toHaveBeenCalledTimes(1);
  });

  it('通信が切れても待ち続ける', async () => {
    vi.useFakeTimers();
    const answer: MobileLaunchAnswer = { ok: true, sessionId: 's-1', title: '会話 1' };
    const reply = await status('l-6', 'started', answer);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockImplementation(async () => reply.clone());
    const onStage = vi.fn();
    waitLaunch(pairing, at1(key), 'l-6', { onStage });
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    expect(onStage).toHaveBeenLastCalledWith('waiting');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    await vi.waitFor(() => expect(onStage).toHaveBeenLastCalledWith('started', answer));
  });

  it('started でも答えが無いか開けなければ unreadable（始まったとは言わない）', async () => {
    vi.useFakeTimers();
    const other = await makeKey();
    const bad = json({ id: 'l-7', status: 'started', sealedAnswer: await seal(other, aadAnswer('l-7'), { ok: true, sessionId: 's', title: 't' }) });
    fetchMock.mockImplementation(async () => bad.clone());
    const onStage = vi.fn();
    waitLaunch(pairing, at1(key), 'l-7', { onStage });
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    await vi.waitFor(() => expect(onStage).toHaveBeenLastCalledWith('unreadable'));
    expect(onStage).not.toHaveBeenCalledWith('started', expect.anything());

    const none = json({ id: 'l-8', status: 'started', sealedAnswer: null });
    fetchMock.mockImplementation(async () => none.clone());
    const onStage2 = vi.fn();
    waitLaunch(pairing, at1(key), 'l-8', { onStage: onStage2 });
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    await vi.waitFor(() => expect(onStage2).toHaveBeenLastCalledWith('unreadable'));
  });

  it('failed で答えが開けなければ unreadable', async () => {
    vi.useFakeTimers();
    const reply = json({ id: 'l-9', status: 'failed', sealedAnswer: 'not-a-sealed-value' });
    fetchMock.mockImplementation(async () => reply.clone());
    const onStage = vi.fn();
    waitLaunch(pairing, at1(key), 'l-9', { onStage });
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    await vi.waitFor(() => expect(onStage).toHaveBeenLastCalledWith('unreadable'));
  });

  it('started と答えの食い違い：ok:false なら failed、failed に ok:true なら unreadable', async () => {
    vi.useFakeTimers();
    const no: MobileLaunchAnswer = { ok: false, reason: 'account-missing' };
    const r1 = await status('l-10', 'started', no);
    fetchMock.mockImplementation(async () => r1.clone());
    const onStage = vi.fn();
    waitLaunch(pairing, at1(key), 'l-10', { onStage });
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    await vi.waitFor(() => expect(onStage).toHaveBeenLastCalledWith('failed', no));

    const r2 = await status('l-11', 'failed', { ok: true, sessionId: 's', title: 't' });
    fetchMock.mockImplementation(async () => r2.clone());
    const onStage2 = vi.fn();
    waitLaunch(pairing, at1(key), 'l-11', { onStage: onStage2 });
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    await vi.waitFor(() => expect(onStage2).toHaveBeenLastCalledWith('unreadable'));
  });

  it('401 は unpaired、404 は failed', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => json({ error: 'unauthorized' }, 401));
    const onStage = vi.fn();
    waitLaunch(pairing, at1(key), 'l-12', { onStage });
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    expect(onStage).toHaveBeenLastCalledWith('unpaired');

    fetchMock.mockImplementation(async () => json({ error: 'not found' }, 404));
    const onStage2 = vi.fn();
    waitLaunch(pairing, at1(key), 'l-13', { onStage: onStage2 });
    await vi.advanceTimersByTimeAsync(LAUNCH_POLL_MS);
    expect(onStage2).toHaveBeenLastCalledWith('failed');
  });
});
