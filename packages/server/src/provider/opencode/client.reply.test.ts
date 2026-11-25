import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { formOf, OpencodeClient, permissionRequestOf } from './client.ts';

type Seen = { method: string; url: string; body: unknown; directory: string | undefined };

describe('OpencodeClient の返信', () => {
  let srv: http.Server | null = null;
  afterEach(() => { srv?.close(); srv = null; });
  const start = async (status: number): Promise<{ client: OpencodeClient; seen: Seen[] }> => {
    const seen: Seen[] = [];
    srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', body: b ? JSON.parse(b) : null, directory: req.headers['x-opencode-directory'] as string | undefined });
        res.statusCode = status;
        res.end(status === 204 ? undefined : '{"_tag":"x","message":"m"}');
      });
    });
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    return { client: new OpencodeClient({ url, password: 'pw', directory: '/work' }), seen };
  };

  it('許可の返信は POST で decision（と message）を送る。204 は ok', async () => {
    const { client, seen } = await start(204);
    expect(await client.replyPermission('ses_1', 'per_1', 'once')).toBe('ok');
    expect(await client.replyPermission('ses_1', 'per_2', 'reject', '断る')).toBe('ok');
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([
      ['POST', '/api/session/ses_1/permission/per_1/reply', { decision: 'once' }],
      ['POST', '/api/session/ses_1/permission/per_2/reply', { decision: 'reject', message: '断る' }],
    ]);
    expect(seen[0]!.directory).toBe('%2Fwork');
  });

  it('form の返信は answer を送る', async () => {
    const { client, seen } = await start(204);
    expect(await client.replyForm('ses_1', 'frm_1', { q0: 'Red', n: 3, ok: true, m: ['a', 'b'] })).toBe('ok');
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/session/ses_1/form/frm_1/reply', body: { answer: { q0: 'Red', n: 3, ok: true, m: ['a', 'b'] } } });
  });

  it.each([[409, 'gone'], [404, 'gone'], [401, 'unreachable'], [500, 'unreachable'], [400, 'unreachable']] as const)('%i は %s', async (status, want) => {
    const { client } = await start(status);
    expect(await client.replyPermission('s', 'p', 'once')).toBe(want);
    expect(await client.replyForm('s', 'f', {})).toBe(want);
  });

  it('つながらなければ unreachable', async () => {
    const client = new OpencodeClient({ url: 'http://127.0.0.1:1', password: 'pw' });
    expect(await client.replyPermission('s', 'p', 'once')).toBe('unreachable');
    expect(await client.replyForm('s', 'f', {})).toBe('unreachable');
  });
});

describe('formOf と permissionRequestOf の全部読み', () => {
  it('許可は save と message も読む', () => {
    expect(permissionRequestOf({ id: 'per_1', sessionID: 's', action: 'shell', resources: ['ls'], save: ['ls *', 3], message: 'm' })).toEqual({ id: 'per_1', sessionID: 's', action: 'shell', resources: ['ls'], save: ['ls *'], message: 'm' });
    expect(permissionRequestOf({ id: 'per_1', sessionID: 's', action: 'shell', resources: [] })).toEqual({ id: 'per_1', sessionID: 's', action: 'shell', resources: [] });
  });

  it('form の欄は type・options・custom・required・when・hidden・default・min・max・minItems・maxItems・url を読む', () => {
    const f = formOf({
      id: 'frm_1', sessionID: 's', title: 't',
      fields: [
        { key: 'a', type: 'string', title: 'A', description: 'd', options: [{ value: 'x', label: 'X', description: 'dx' }, { value: 1 }], custom: true, required: true, default: 'x' },
        { key: 'b', type: 'integer', minimum: 1, maximum: 9, default: 3, hidden: true, when: [{ key: 'a', op: 'eq', value: 'x' }, { key: 'z', op: 'bad', value: 1 }] },
        { key: 'c', type: 'multiselect', options: [{ value: 'p', label: 'P' }], minItems: 1, maxItems: 2, default: ['p'] },
        { key: 'd', type: 'external', url: 'https://e' },
      ],
    });
    expect(f?.fields).toEqual([
      { key: 'a', type: 'string', title: 'A', description: 'd', options: [{ value: 'x', label: 'X', description: 'dx' }], custom: true, required: true, default: 'x' },
      { key: 'b', type: 'integer', min: 1, max: 9, default: 3, hidden: true, when: [{ key: 'a', op: 'eq', value: 'x' }] },
      { key: 'c', type: 'multiselect', options: [{ value: 'p', label: 'P' }], minItems: 1, maxItems: 2, default: ['p'] },
      { key: 'd', type: 'external', url: 'https://e' },
    ]);
  });

  it('type の無い古い欄は key・title・description だけ', () => {
    expect(formOf({ id: 'frm_1', sessionID: 's', title: 't', fields: [{ key: 'q0', title: 'T', description: 'D' }] })?.fields).toEqual([{ key: 'q0', title: 'T', description: 'D' }]);
  });
});
