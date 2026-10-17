import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMessageOf, PushError, readPushStatus, takeOpenFragment, turnOffPush, turnOnPush } from './push.ts';
import { json, WORKER } from './test/pairText.ts';

const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };
const otherPairing = { url: WORKER, token: 'tok-2', deviceId: 'phone-2' };
/** Worker の VAPID の公開鍵（65 バイトの非圧縮点）の base64url。 */
const VAPID = new Uint8Array(65).fill(7);
VAPID[0] = 4;
const VAPID_B64 = Buffer.from(VAPID).toString('base64url');
const PUSH_RECORD = 'hangar.mobile.push';

let n = 0;
class FakeSub {
  endpoint = `https://web.push.apple.com/sub-${++n}`;
  options: { applicationServerKey: ArrayBuffer | null; userVisibleOnly: boolean };
  unsubscribe = vi.fn(async () => {
    if (this.pm.sub === this) this.pm.sub = null;
    return true;
  });
  constructor(
    private pm: FakePushManager,
    key: Uint8Array,
  ) {
    this.options = { applicationServerKey: key.slice().buffer, userVisibleOnly: true };
  }
  toJSON() {
    return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: 'p256dh-1', auth: 'auth-1' } };
  }
}
class FakePushManager {
  sub: FakeSub | null = null;
  subscribe = vi.fn(async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
    this.sub = new FakeSub(this, o.applicationServerKey);
    return this.sub;
  });
  getSubscription = vi.fn(async () => this.sub);
}

let pm: FakePushManager;
let fake: { permission: NotificationPermission; requestPermission: ReturnType<typeof vi.fn> };
let fetchMock: ReturnType<typeof vi.fn>;
let putStatus: number;

const calls = (method: string, path: string) =>
  fetchMock.mock.calls.filter(([u, i]) => String(u) === `${WORKER}${path}` && ((i as RequestInit | undefined)?.method ?? 'GET') === method);
const putBodies = () => calls('PUT', '/m/push/subscription').map(([, i]) => JSON.parse(String((i as RequestInit).body)) as Record<string, unknown>);

beforeEach(() => {
  localStorage.clear();
  pm = new FakePushManager();
  fake = {
    permission: 'default',
    requestPermission: vi.fn(async () => {
      fake.permission = 'granted';
      return 'granted' as const;
    }),
  };
  vi.stubGlobal('Notification', fake);
  vi.stubGlobal('PushManager', function PushManager() {});
  const reg = { pushManager: pm };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(reg), getRegistration: async () => reg } });
  putStatus = 200;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === `${WORKER}/m/push/key` && method === 'GET') return json({ publicKey: VAPID_B64 });
    if (url === `${WORKER}/m/push/subscription` && method === 'PUT') return json({ ok: true }, putStatus);
    if (url === `${WORKER}/m/push/subscription` && method === 'DELETE') return json({ ok: true });
    return json({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

describe('通知の購読', () => {
  it('使えないブラウザでは unsupported', async () => {
    vi.stubGlobal('PushManager', undefined);
    expect(await readPushStatus(pairing)).toEqual({ kind: 'unsupported', ios: false });
  });

  it('iPhone の Safari（ホーム画面に追加していない）では、iOS の案内つきの unsupported', async () => {
    vi.stubGlobal('PushManager', undefined);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    expect(await readPushStatus(pairing)).toEqual({ kind: 'unsupported', ios: true });
    vi.restoreAllMocks();
  });

  it('購読が無ければ off', async () => {
    expect(await readPushStatus(pairing)).toEqual({ kind: 'off' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('通知を受け取る：許可を求め、Worker の鍵で購読し、quiet を省いて tzOffset と一緒に送る', async () => {
    expect(await turnOnPush(pairing, { tzOffset: -540 })).toEqual({ kind: 'on' });
    expect(fake.requestPermission).toHaveBeenCalledTimes(1);
    expect(pm.subscribe).toHaveBeenCalledTimes(1);
    const opts = pm.subscribe.mock.calls[0]![0];
    expect(opts.userVisibleOnly).toBe(true);
    expect([...opts.applicationServerKey]).toEqual([...VAPID]);
    const [, keyInit] = calls('GET', '/m/push/key')[0]!;
    expect((keyInit as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok-1' });
    const body = putBodies();
    expect(body).toEqual([{ endpoint: pm.sub!.endpoint, keys: { p256dh: 'p256dh-1', auth: 'auth-1' }, tzOffset: -540 }]);
    expect('quiet' in body[0]!).toBe(false);
    expect(await readPushStatus(pairing, { tzOffset: -540 })).toEqual({ kind: 'on' });
  });

  it('許可を求める前に網へ出ない（利用者の操作の中で requestPermission を呼ぶ）', async () => {
    let fetchedBefore = -1;
    fake.requestPermission.mockImplementation(async () => {
      fetchedBefore = fetchMock.mock.calls.length;
      fake.permission = 'granted';
      return 'granted';
    });
    await turnOnPush(pairing, { tzOffset: 0 });
    expect(fetchedBefore).toBe(0);
  });

  it('許可されなければ購読しない（拒否は denied、閉じただけなら off）', async () => {
    fake.requestPermission.mockImplementation(async () => {
      fake.permission = 'denied';
      return 'denied';
    });
    expect(await turnOnPush(pairing, { tzOffset: 0 })).toEqual({ kind: 'denied' });
    fake.requestPermission.mockImplementation(async () => 'default');
    fake.permission = 'default';
    expect(await turnOnPush(pairing, { tzOffset: 0 })).toEqual({ kind: 'off' });
    expect(pm.subscribe).not.toHaveBeenCalled();
    expect(putBodies()).toEqual([]);
  });

  it('拒否してあれば、開いたときに denied', async () => {
    fake.permission = 'denied';
    expect(await readPushStatus(pairing)).toEqual({ kind: 'denied' });
  });

  it('Worker が受け取れなければ購読を外して PushError', async () => {
    putStatus = 500;
    await expect(turnOnPush(pairing, { tzOffset: 0 })).rejects.toBeInstanceOf(PushError);
    expect(pm.sub).toBeNull();
    expect(await readPushStatus(pairing)).toEqual({ kind: 'off' });
  });

  it('前の購読の鍵が違えば（接続先が変わった）外してから購読し直す', async () => {
    const old = await pm.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array(65).fill(1) });
    await turnOnPush(pairing, { tzOffset: 0 });
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(pm.sub).not.toBe(old);
  });

  it('前の購読の鍵が同じなら、そのまま使って送る', async () => {
    const old = await pm.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID });
    pm.subscribe.mockClear();
    await turnOnPush(pairing, { tzOffset: 0 });
    expect(old.unsubscribe).not.toHaveBeenCalled();
    expect(pm.subscribe).not.toHaveBeenCalled();
    expect(putBodies()[0]!.endpoint).toBe(old.endpoint);
  });

  it('開くたびに tzOffset が変わっていれば送り直す（変わっていなければ送らない）', async () => {
    await turnOnPush(pairing, { tzOffset: -540 });
    expect(await readPushStatus(pairing, { tzOffset: -540 })).toEqual({ kind: 'on' });
    expect(putBodies()).toHaveLength(1);
    expect(await readPushStatus(pairing, { tzOffset: 300 })).toEqual({ kind: 'on' });
    expect(putBodies().map((b) => b.tzOffset)).toEqual([-540, 300]);
    expect(await readPushStatus(pairing, { tzOffset: 300 })).toEqual({ kind: 'on' });
    expect(putBodies()).toHaveLength(2);
  });

  it('購読が切れていれば（getSubscription が null）off に戻し、Worker の行も消す', async () => {
    await turnOnPush(pairing, { tzOffset: 0 });
    pm.sub = null;
    expect(await readPushStatus(pairing, { tzOffset: 0 })).toEqual({ kind: 'off' });
    expect(localStorage.getItem(PUSH_RECORD)).toBeNull();
    expect(calls('DELETE', '/m/push/subscription')).toHaveLength(1);
    expect(await readPushStatus(pairing, { tzOffset: 0 })).toEqual({ kind: 'off' });
    expect(calls('DELETE', '/m/push/subscription')).toHaveLength(1);
  });

  it('許可を後から外したら off', async () => {
    await turnOnPush(pairing, { tzOffset: 0 });
    fake.permission = 'default';
    expect(await readPushStatus(pairing, { tzOffset: 0 })).toEqual({ kind: 'off' });
  });

  it('前の接続で購読したものは、この接続ではオンと見なさない', async () => {
    await turnOnPush(otherPairing, { tzOffset: 0 });
    expect(await readPushStatus(pairing, { tzOffset: 0 })).toEqual({ kind: 'off' });
    expect(putBodies()).toHaveLength(1);
  });

  it('通知を止める：購読を外して DELETE を送る', async () => {
    await turnOnPush(pairing, { tzOffset: 0 });
    const sub = pm.sub!;
    expect(await turnOffPush(pairing)).toEqual({ kind: 'off' });
    expect(sub.unsubscribe).toHaveBeenCalled();
    const [, init] = calls('DELETE', '/m/push/subscription')[0]!;
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok-1' });
    expect(await readPushStatus(pairing, { tzOffset: 0 })).toEqual({ kind: 'off' });
  });

  it('止めるときに Worker へ送れなくても、手元はオフにする', async () => {
    await turnOnPush(pairing, { tzOffset: 0 });
    fetchMock.mockImplementation(async () => {
      throw new TypeError('offline');
    });
    expect(await turnOffPush(pairing)).toEqual({ kind: 'off' });
    expect(pm.sub).toBeNull();
  });
});

describe('openMessageOf', () => {
  it('サービスワーカーの hangar-open だけを読む', () => {
    expect(openMessageOf({ type: 'hangar-open', sessionId: 's-1' })).toBe('s-1');
    expect(openMessageOf({ type: 'other', sessionId: 's-1' })).toBeNull();
    expect(openMessageOf({ type: 'hangar-open', sessionId: '' })).toBeNull();
    expect(openMessageOf(null)).toBeNull();
  });
});

describe('takeOpenFragment', () => {
  it('#open= の会話の ID を取り出し、URL から消す', () => {
    history.replaceState(null, '', `/app/#open=${encodeURIComponent('s-1/x')}`);
    expect(takeOpenFragment()).toBe('s-1/x');
    expect(location.hash).toBe('');
    expect(location.pathname).toBe('/app/');
  });

  it('#open= が無ければ null で、URL に触らない', () => {
    history.replaceState(null, '', '/app/#pair=abc');
    expect(takeOpenFragment()).toBeNull();
    expect(location.hash).toBe('#pair=abc');
    history.replaceState(null, '', '/app/');
  });
});
