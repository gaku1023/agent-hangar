import { aadAnswer, aadLaunch, open, seal, type MobileLaunchAnswer, type MobileLaunchPayload } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLaunch, type LaunchSpec, type RunState } from './launchRun.ts';
import { makeKey } from './test/fixtures.ts';
import { json, WORKER } from './test/pairText.ts';

const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };
let key: CryptoKey;
let fetchMock: ReturnType<typeof vi.fn>;
let sent: { id: string; targetDevice: string; sealed: string }[];

const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
  targetDevice: 'pc-1',
  pcName: 'Mac',
  projectName: 'project-a',
  accountId: 'acc-1',
  accountName: 'アカウント 1',
  accountColor: '#4a63e8',
  payload: { projectId: 'p-a', scratch: false, accountId: 'acc-1', permissionMode: '', model: '', prompt: 'a' },
  skewMs: 0,
  ...over,
});

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

type Reply = { status: 'pending' | 'claimed' | 'started' | 'failed' | 'expired'; answer?: MobileLaunchAnswer } | { http: number; body: unknown };

/** POST は受けて pending、GET は replies を順に返す（最後のものを繰り返す）。 */
function serve(replies: Reply[], posts: Reply[] = []): void {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { id: string; targetDevice: string; sealed: string };
      sent.push(body);
      const first = posts[0];
      if (first && 'http' in first) {
        posts.shift();
        return json(first.body, first.http);
      }
      return json({ id: body.id, status: 'pending', sealedAnswer: null }, 201);
    }
    const id = url.split('/').pop()!;
    const a = replies.length > 1 ? replies.shift()! : replies[0]!;
    if ('http' in a) return json(a.body, a.http);
    return json({ id, status: a.status, sealedAnswer: a.answer ? await seal(key, aadAnswer(id), a.answer) : null });
  });
}

function run(s: LaunchSpec = spec(), o: { everyMs?: number; giveUpMs?: number } = {}) {
  const states: RunState[] = [];
  const r = startLaunch(pairing, key, s, { everyMs: 10, ...o, onState: (st) => states.push(st) });
  const last = (): RunState => states[states.length - 1]!;
  return { r, states, last };
}

describe('startLaunch', () => {
  it('送信 → 受け取りを待つ → PC が受け取った → 始まった、の順に進む', async () => {
    serve([{ status: 'pending' }, { status: 'claimed' }, { status: 'started', answer: { ok: true, sessionId: 's-9', title: '会話 9' } }]);
    const { states, last } = run();
    expect(states[0]).toEqual({ kind: 'sending' });
    await vi.waitFor(() => expect(last()).toEqual({ kind: 'started', sessionId: 's-9', title: '会話 9' }));
    expect(states.map((s) => s.kind)).toEqual(['sending', 'waiting', 'waiting', 'started']);
    expect(states[1]).toEqual({ kind: 'waiting', claimed: false });
    expect(states[2]).toEqual({ kind: 'waiting', claimed: true });
    expect(sent).toHaveLength(1);
    const payload = await open<MobileLaunchPayload>(key, aadLaunch(sent[0]!.id, 'pc-1'), sent[0]!.sealed);
    expect(payload).toMatchObject({ projectId: 'p-a', scratch: false, accountId: 'acc-1', prompt: 'a' });
  });

  it('失敗の答えは、理由ごとの文で PC の段の失敗として渡す', async () => {
    const cases: [MobileLaunchAnswer, RegExp][] = [
      [{ ok: false, reason: 'project-missing' }, /その PC にプロジェクトのディレクトリがありません/],
      [{ ok: false, reason: 'account-missing' }, /その PC に選んだアカウントがありません/],
      [{ ok: false, reason: 'images-missing' }, /画像/],
      [{ ok: false, reason: 'expired' }, /時間切れ/],
    ];
    for (const [answer, re] of cases) {
      serve([{ status: 'failed', answer }]);
      const { last } = run();
      await vi.waitFor(() => expect(last().kind).toBe('failed'));
      const s = last();
      expect(s.kind === 'failed' && s.at).toBe('pc');
      expect(s.kind === 'failed' && s.message).toMatch(re);
    }
  });

  it('鍵が合わない答え（bad-payload）は接続し直しを勧める', async () => {
    serve([{ status: 'failed', answer: { ok: false, reason: 'bad-payload' } }]);
    const { last } = run();
    await vi.waitFor(() => expect(last().kind).toBe('failed'));
    expect(last()).toMatchObject({ kind: 'failed', at: 'pc', reconnect: true });
  });

  it('launch-failed の detail は文字として渡す', async () => {
    serve([{ status: 'failed', answer: { ok: false, reason: 'launch-failed', detail: '<b>tmux</b> が無い' } }]);
    const { last } = run();
    await vi.waitFor(() => expect(last().kind).toBe('failed'));
    expect(last()).toMatchObject({ kind: 'failed', detail: '<b>tmux</b> が無い' });
  });

  it('送りすぎ（429）は回数の上限を言い、送信の段の失敗', async () => {
    serve([{ status: 'pending' }], [{ http: 429, body: { error: 'rate limited' } }]);
    const { last } = run();
    await vi.waitFor(() => expect(last().kind).toBe('failed'));
    expect(last()).toMatchObject({ kind: 'failed', at: 'send' });
    expect((last() as { message: string }).message).toMatch(/10 分に 10 件まで/);
  });

  it('PC が受け取らないまま時間切れなら「受け取りませんでした」、受け取った後なら「結果がまだ届いていません」', async () => {
    serve([{ status: 'pending' }]);
    const a = run(spec(), { giveUpMs: 150 });
    await vi.waitFor(() => expect(a.last().kind).toBe('failed'));
    expect((a.last() as { message: string }).message).toMatch(/Mac から応答がありません/);
    expect(a.last()).toMatchObject({ at: 'pc' });

    serve([{ status: 'pending' }, { status: 'claimed' }]);
    const b = run(spec(), { giveUpMs: 150 });
    await vi.waitFor(() => expect(b.last().kind).toBe('unanswered'));
  });

  it('返事を開けなければ unreadable', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as { id: string };
        return json({ id: body.id, status: 'pending', sealedAnswer: null }, 201);
      }
      return json({ id: url.split('/').pop(), status: 'started', sealedAnswer: 'not-a-sealed-value' });
    });
    const { last } = run();
    await vi.waitFor(() => expect(last().kind).toBe('unreadable'));
  });

  it('401 は unpaired', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as { id: string };
        return json({ id: body.id, status: 'pending', sealedAnswer: null }, 201);
      }
      return json({ error: 'unauthorized' }, 401);
    });
    const { last } = run();
    await vi.waitFor(() => expect(last().kind).toBe('unpaired'));
  });

  it('届いたか分からない失敗の後の retry は同じ id で送り、受け取られた後の失敗の retry は新しい id', async () => {
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
      const id = url.split('/').pop()!;
      return json({ id, status: 'failed', sealedAnswer: await seal(key, aadAnswer(id), { ok: false, reason: 'launch-failed' } satisfies MobileLaunchAnswer) });
    });
    const { r, last } = run();
    await vi.waitFor(() => expect(last()).toMatchObject({ kind: 'failed', at: 'send' }));
    expect((last() as { message: string }).message).toMatch(/通信を確認して/);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.id).toBe(sent[0]!.id);

    // 同じ依頼をもう一度：同じ id（前のが置けていれば Worker は行を増やさない）。
    failPosts = 2;
    r.retry();
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    await vi.waitFor(() => expect(last()).toMatchObject({ kind: 'failed', at: 'send' }));
    expect(new Set(sent.map((b) => b.id)).size).toBe(1);

    // 今度は置けて、PC が失敗を返す。その後の retry は新しい依頼。
    r.retry();
    await vi.waitFor(() => expect(last()).toMatchObject({ kind: 'failed', at: 'pc' }));
    expect(sent).toHaveLength(5);
    r.retry();
    await vi.waitFor(() => expect(sent).toHaveLength(6));
    expect(sent[5]!.id).not.toBe(sent[4]!.id);
  });

  it('止めたら、あとの状態を渡さない', async () => {
    serve([{ status: 'pending' }]);
    const { r, states } = run(spec(), { giveUpMs: 100 });
    await vi.waitFor(() => expect(states.some((s) => s.kind === 'waiting')).toBe(true));
    r.cancel();
    const n = states.length;
    await new Promise((res) => setTimeout(res, 200));
    expect(states).toHaveLength(n);
  });
});
