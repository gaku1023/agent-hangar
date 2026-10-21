import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaveError, leavePhone } from './api.ts';
import { json, WORKER } from './test/pairText.ts';

const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };

afterEach(() => {
  vi.unstubAllGlobals();
});

const stub = (res: () => Promise<Response>) => {
  const f = vi.fn(res);
  vi.stubGlobal('fetch', f);
  return f;
};

describe('leavePhone（POST /m/leave）', () => {
  it('スマホのトークンで本文なしに送り、204 なら外れた', async () => {
    const f = stub(async () => new Response(null, { status: 204 }));
    expect(await leavePhone(pairing)).toBe('left');
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`${WORKER}/m/leave`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok-1' });
  });

  it('401（もう外れている、期限切れ）も外れたとみなす', async () => {
    stub(async () => json({ error: 'expired' }, 401));
    expect(await leavePhone(pairing)).toBe('left');
  });

  it('404 は口の無い古い Worker', async () => {
    stub(async () => json({ error: 'not found' }, 404));
    expect(await leavePhone(pairing)).toBe('old');
  });

  it('通信の失敗は LeaveError(network)、ほかの応答は LeaveError(server)', async () => {
    stub(async () => {
      throw new TypeError('offline');
    });
    await expect(leavePhone(pairing)).rejects.toMatchObject({ name: 'LeaveError', reason: 'network' });
    stub(async () => json({ error: 'boom' }, 500));
    const e = await leavePhone(pairing).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LeaveError);
    expect(e).toMatchObject({ reason: 'server', status: 500 });
  });
});
