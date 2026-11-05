import { describe, expect, it, vi } from 'vitest';
import {
  deriveEpochKeys,
  openPeerAnswer,
  PEER_LAUNCH_TTL_MS,
  randomEpochKey,
  sealPeerLaunch,
  type EpochKeys,
  type LaunchParams,
  type PeerKeyring,
  type PeerLaunchAnswer,
  type PeerLaunchRequest,
} from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import type { LaunchResult } from '../runs/manager.ts';
import { getSpawn, recordSpawn } from '../sessions/spawns.ts';
import { CloudError } from '../sync/client.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { PEER_ANSWER_RESEND_WINDOW_MS, PeerLaunchInbox, type PeerAccount, type PeerLaunchInboxDeps } from './launchInbox.ts';

const T0 = 1_800_000_000_000;

async function ringOf(epochs: Record<number, string>, cur: number): Promise<PeerKeyring> {
  const keys = new Map<number, EpochKeys>();
  for (const [n, k] of Object.entries(epochs)) keys.set(Number(n), await deriveEpochKeys(Number(n), k));
  return { current: () => keys.get(cur)!, at: (n) => keys.get(n) ?? null };
}

const request = (over: Partial<PeerLaunchRequest> = {}): PeerLaunchRequest => ({
  v: 1, createdAt: T0, parentSessionId: 'parent-1', projectId: 'project-a', scratch: false, agent: 'claude-code', account: '', permissionMode: 'acceptEdits', model: 'sonnet', prompt: 'TODO の先頭をやって', ...over,
});

const started = (sessionId: string): LaunchResult => ({ run: { id: 'run-1', sessionId } as LaunchResult['run'], sessionId, tabs: [] });

const ACCOUNTS: Record<string, PeerAccount> = { 'claude-code:work': { id: 'acc-work', loggedIn: true }, 'claude-code:out': { id: 'acc-out', loggedIn: false }, 'codex:cx': { id: 'acc-cx', loggedIn: true } };

async function setup(o: { start?: (p: LaunchParams) => LaunchResult | Promise<LaunchResult>; ownRing?: PeerKeyring; canProcess?: () => boolean; db?: ReturnType<typeof openDb>; hasAgent?: PeerLaunchInboxDeps['hasAgent']; control?: PeerLaunchInboxDeps['control']; onStarted?: PeerLaunchInboxDeps['onStarted'] } = {}) {
  const db = o.db ?? openDb(':memory:');
  const key = randomEpochKey();
  const callerRing = await ringOf({ 1: key }, 1);
  const ring = o.ownRing ?? callerRing;
  let now = T0;
  const a = new FakeCloudClient({ deviceId: 'pc-a', now: () => now });
  const b = a.asDevice('pc-b');
  await b.pullChanges(0, 10);
  const start = vi.fn(o.start ?? (() => started('s-new')));
  const reread = vi.fn(async () => {});
  const inbox = new PeerLaunchInbox({
    db, api: b.peerLaunch, ring: async () => ring, reread, deviceId: 'pc-b', start,
    hasProjectHere: (id) => id === 'project-a',
    accountByName: (agent, name) => ACCOUNTS[`${agent}:${name}`] ?? null,
    hasAgent: o.hasAgent ?? (() => true),
    canProcess: o.canProcess ?? (() => true),
    now: () => now,
    ...(o.control ? { control: o.control } : {}),
    ...(o.onStarted ? { onStarted: o.onStarted } : {}),
  });
  /** pc-a が頼みを置き、pc-b の pull で届く形を返す。 */
  const post = async (id: string, req: PeerLaunchRequest, sealWith: PeerKeyring = callerRing) => {
    await a.peerLaunch.put({ id, to: 'pc-b', sealed: await sealPeerLaunch(sealWith, { requestId: id, from: 'pc-a', to: 'pc-b' }, req) });
    return (await b.pullChanges(0, 10)).peerLaunches ?? [];
  };
  const answerOf = async (id: string): Promise<PeerLaunchAnswer> => {
    const out = (await a.peerLaunch.outbox(0)).launches.find((l) => l.id === id)!;
    return openPeerAnswer(callerRing, { requestId: id, from: 'pc-a', to: 'pc-b' }, out.sealedAnswer!);
  };
  return { db, a, b, start, reread, inbox, post, answerOf, callerRing, setNow: (t: number) => { now = t; } };
}

describe('PeerLaunchInbox', () => {
  it('同じプロジェクトに起こして started と session_id を答え、結び付きを書く（テスト 2）', async () => {
    const { db, inbox, post, start, answerOf } = await setup();
    await inbox.receive(await post('l1', request()));
    expect(start).toHaveBeenCalledWith({ projectId: 'project-a', permissionMode: 'acceptEdits', model: 'sonnet', prompt: 'TODO の先頭をやって' });
    expect(await answerOf('l1')).toEqual({ ok: true, sessionId: 's-new', title: 'TODO の先頭をやって' });
    expect(getSpawn(db, 'pc-b', 's-new')).toMatchObject({ parentId: 'parent-1', parentDeviceId: 'pc-a', childDeviceId: 'pc-b' });
    expect(db.prepare('select result, session_id, answered from peer_launches where id = ?').get('l1')).toEqual({ result: 'started', session_id: 's-new', answered: 1 });
  });

  it('auto_approve と permission_mode はそのまま通す（D10）。opencode と Codex の欄も組む', async () => {
    const { inbox, post, start } = await setup();
    await inbox.receive(await post('l1', request({ permissionMode: 'bypassPermissions', effort: 'high' })));
    await inbox.receive(await post('l2', request({ agent: 'opencode', permissionMode: '', model: '', mode: 'build', autoApprove: true })));
    await inbox.receive(await post('l3', request({ agent: 'codex', permissionMode: '', mode: 'full-access', model: '' })));
    expect(start.mock.calls[0]![0]).toMatchObject({ permissionMode: 'bypassPermissions', effort: 'high' });
    expect(start.mock.calls[1]![0]).toEqual({ projectId: 'project-a', agent: 'opencode', mode: 'build', autoApprove: true, prompt: 'TODO の先頭をやって' });
    expect(start.mock.calls[2]![0]).toEqual({ projectId: 'project-a', agent: 'codex', mode: 'full-access', prompt: 'TODO の先頭をやって' });
  });

  it('断る理由（テスト 4）：project-missing、account-missing、account-logged-out、agent-missing、bad-payload、expired', async () => {
    const { inbox, post, start, answerOf, setNow } = await setup({ hasAgent: (a) => a === 'claude-code' });
    await inbox.receive(await post('p', request({ projectId: 'nowhere' })));
    await inbox.receive(await post('am', request({ account: 'nobody' })));
    await inbox.receive(await post('lo', request({ account: 'out' })));
    await inbox.receive(await post('ag', request({ agent: 'opencode', permissionMode: '' })));
    await inbox.receive(await post('bp', request({ permissionMode: 'rm -rf' })));
    await inbox.receive(await post('bp2', request({ agent: 'opencode', account: 'work', permissionMode: '' })));
    expect(await answerOf('p')).toEqual({ ok: false, reason: 'project-missing' });
    expect(await answerOf('am')).toEqual({ ok: false, reason: 'account-missing', detail: 'nobody' });
    expect(await answerOf('lo')).toEqual({ ok: false, reason: 'account-logged-out', detail: 'out' });
    expect(await answerOf('ag')).toEqual({ ok: false, reason: 'agent-missing' });
    expect(await answerOf('bp')).toEqual({ ok: false, reason: 'bad-payload' });
    expect(await answerOf('bp2')).toEqual({ ok: false, reason: 'bad-payload' });
    // 時計のずれの余裕を超えて古い頼み。
    setNow(T0 + PEER_LAUNCH_TTL_MS + 6 * 60_000);
    const list = await post('ex', request({ createdAt: T0 }));
    await inbox.receive(list);
    expect(await answerOf('ex')).toEqual({ ok: false, reason: 'expired' });
    expect(start).not.toHaveBeenCalled();
  });

  it('アカウントを名前で突き合わせ、省かれていれば呼び出し元のアカウントの名前を使う（テスト 5）', async () => {
    const { inbox, post, start, answerOf } = await setup();
    await inbox.receive(await post('l1', request({ account: 'work' })));
    await inbox.receive(await post('l2', request({ account: '', callerAccount: 'work' })));
    await inbox.receive(await post('l3', request({ account: '', callerAccount: 'out' })));
    await inbox.receive(await post('l4', request({ account: '' })));
    expect(start.mock.calls[0]![0]).toMatchObject({ account: 'acc-work' });
    expect(start.mock.calls[1]![0]).toMatchObject({ account: 'acc-work' });
    expect(await answerOf('l3')).toMatchObject({ ok: false, reason: 'account-logged-out' });
    expect((start.mock.calls[2]![0] as LaunchParams).account).toBeUndefined();
  });

  it('起こされた会話から別の PC への頼みは depth-exceeded（テスト 8）。申告でも同期で届いた結び付きでも断り、同じ PC の入れ子は影響しない', async () => {
    const { db, inbox, post, start, answerOf } = await setup();
    await inbox.receive(await post('l1', request({ spawnedRemotely: true })));
    expect(await answerOf('l1')).toEqual({ ok: false, reason: 'depth-exceeded' });
    // pc-a の会話 p-x は、pc-c から起こされたものと同期で届いている。
    recordSpawn(db, 'pc-a', 'p-x', 'q', T0, { parentDeviceId: 'pc-c', childDeviceId: 'pc-a' });
    await inbox.receive(await post('l2', request({ parentSessionId: 'p-x' })));
    expect(await answerOf('l2')).toEqual({ ok: false, reason: 'depth-exceeded' });
    // pc-a の中の入れ子（親も子も pc-a）は深さに数えない。
    recordSpawn(db, 'pc-a', 'p-y', 'q', T0, { parentDeviceId: 'pc-a', childDeviceId: 'pc-a' });
    await inbox.receive(await post('l3', request({ parentSessionId: 'p-y' })));
    expect(await answerOf('l3')).toMatchObject({ ok: true });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('claim が false なら起動せず、記録もしない', async () => {
    const { b, inbox, post, start, db } = await setup();
    const list = await post('l1', request());
    await b.peerLaunch.claim('l1');
    await inbox.receive(list);
    expect(start).not.toHaveBeenCalled();
    expect(db.prepare('select count(*) as n from peer_launches').get()).toEqual({ n: 0 });
  });

  it('同じ頼みを二度起こさない。同じ DB を使う作り直し（再起動）の後も', async () => {
    const first = await setup();
    const list = await first.post('l1', request());
    await first.inbox.receive(list);
    await first.inbox.receive(list);
    expect(first.start).toHaveBeenCalledTimes(1);
    const second = await setup({ db: first.db });
    await second.inbox.receive(list);
    expect(second.start).not.toHaveBeenCalled();
  });

  it('開けない封は bad-payload で答える（別の鍵、AAD の違う宛先）', async () => {
    const { inbox, post, answerOf, start } = await setup();
    const other = await ringOf({ 1: randomEpochKey() }, 1);
    await inbox.receive(await post('l1', request(), other));
    expect(await answerOf('l1')).toEqual({ ok: false, reason: 'bad-payload' });
    expect(start).not.toHaveBeenCalled();
  });

  it('知らない世代の頼みは keybox を読み直し、鍵が無ければ claim せずに残す', async () => {
    const key2 = randomEpochKey();
    const caller = await ringOf({ 1: randomEpochKey(), 2: key2 }, 2);
    const own = await ringOf({ 1: randomEpochKey() }, 1);
    const { b, reread, inbox, post, start } = await setup({ ownRing: own });
    const list = await post('l1', request(), caller);
    await inbox.receive(list);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    // 受け取られていない（Worker の行は pending のまま）。
    expect((await b.pullChanges(0, 10)).peerLaunches).toHaveLength(1);
  });

  it('答えを送れなかったときは記録を残し、resendAnswers が同じ封で送り直す。409 なら止める', async () => {
    const { b, inbox, post, answerOf, db, setNow } = await setup();
    let fail = true;
    const real = b.peerLaunch.answer;
    vi.spyOn(b.peerLaunch, 'answer').mockImplementation(async (...args) => { if (fail) throw new CloudError(503, 'x'); return real(...args); });
    await inbox.receive(await post('l1', request()));
    expect(db.prepare('select answered from peer_launches where id = ?').get('l1')).toEqual({ answered: 0 });
    fail = false;
    await inbox.resendAnswers();
    expect(await answerOf('l1')).toMatchObject({ ok: true });
    expect(db.prepare('select answered from peer_launches where id = ?').get('l1')).toEqual({ answered: 1 });
    // 送り直しの窓を過ぎたら送らない。
    db.prepare('insert into peer_launches (id, from_device, handled_at, result, sealed_answer, ok, answered) values (?, ?, ?, ?, ?, 1, 0)').run('old', 'pc-a', T0, 'started', '1.eA', );
    setNow(T0 + PEER_ANSWER_RESEND_WINDOW_MS + 1);
    const spy = vi.spyOn(b.peerLaunch, 'answer');
    spy.mockClear();
    await inbox.resendAnswers();
    expect(spy).not.toHaveBeenCalled();
  });

  it('起動に失敗したら launch-failed と理由を答え、結び付きは書かない', async () => {
    const { db, inbox, post, answerOf } = await setup({ start: () => { throw new Error('boom'); } });
    await inbox.receive(await post('l1', request()));
    expect(await answerOf('l1')).toEqual({ ok: false, reason: 'launch-failed', detail: 'boom' });
    expect(db.prepare('select count(*) as n from session_spawns').get()).toEqual({ n: 0 });
  });

  it('扱ってよくない（古い Worker、止まっている）あいだは claim せずに残す', async () => {
    let ok = false;
    const { b, inbox, post, start } = await setup({ canProcess: () => ok });
    const list = await post('l1', request());
    await inbox.receive(list);
    expect(start).not.toHaveBeenCalled();
    expect((await b.pullChanges(0, 10)).peerLaunches).toHaveLength(1);
    ok = true;
    await inbox.receive(list);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('onStarted に prompt の有無を渡す', async () => {
    const onStarted = vi.fn();
    const { inbox, post } = await setup({ onStarted });
    await inbox.receive(await post('l1', request()));
    await inbox.receive(await post('l2', request({ prompt: '' })));
    expect(onStarted.mock.calls.map((c) => [c[0].requestId, c[0].hasPrompt])).toEqual([['l1', true], ['l2', false]]);
  });

  describe('send と stop（D16、テスト 14 の受ける側）', () => {
    const sendReq = (over: Partial<PeerLaunchRequest> = {}): PeerLaunchRequest => request({ op: 'send', targetSessionId: 's-new', scratch: true, projectId: null, account: '', permissionMode: '', model: '', prompt: '続きをお願い', ...over });
    const stopReq = (over: Partial<PeerLaunchRequest> = {}): PeerLaunchRequest => sendReq({ op: 'stop', prompt: '', ...over });

    it('自分が起こした会話への send は入力を入れ、stop は止める。起動はしない', async () => {
      const control = { send: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
      const { db, inbox, post, start, answerOf } = await setup({ control });
      await inbox.receive(await post('l1', request()));
      await inbox.receive(await post('s1', sendReq()));
      await inbox.receive(await post('t1', stopReq()));
      expect(start).toHaveBeenCalledTimes(1);
      expect(control.send).toHaveBeenCalledWith('s-new', '続きをお願い');
      expect(control.stop).toHaveBeenCalledWith('s-new');
      expect(await answerOf('s1')).toMatchObject({ ok: true, sessionId: 's-new' });
      expect(await answerOf('t1')).toMatchObject({ ok: true, sessionId: 's-new' });
      expect(db.prepare('select result, session_id from peer_launches where id = ?').get('s1')).toEqual({ result: 'send', session_id: 's-new' });
    });

    it('起こしていない会話、別の親の会話、別の PC の親の会話は not-spawned-by-caller で断る', async () => {
      const control = { send: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
      const { db, inbox, post, answerOf } = await setup({ control });
      await inbox.receive(await post('l1', request()));
      recordSpawn(db, 'pc-b', 's-local', 'parent-1', T0);
      recordSpawn(db, 'pc-b', 's-other-parent', 'parent-9', T0, { parentDeviceId: 'pc-a' });
      recordSpawn(db, 'pc-b', 's-other-pc', 'parent-1', T0, { parentDeviceId: 'pc-c' });
      for (const [i, target] of ['nowhere', 's-local', 's-other-parent', 's-other-pc'].entries()) {
        await inbox.receive(await post(`s${i}`, sendReq({ targetSessionId: target })));
        await inbox.receive(await post(`t${i}`, stopReq({ targetSessionId: target })));
        expect(await answerOf(`s${i}`)).toEqual({ ok: false, reason: 'not-spawned-by-caller' });
        expect(await answerOf(`t${i}`)).toEqual({ ok: false, reason: 'not-spawned-by-caller' });
      }
      expect(control.send).not.toHaveBeenCalled();
      expect(control.stop).not.toHaveBeenCalled();
    });

    it('入力を入れられなければ launch-failed と理由を答える。bad-payload の形も断る', async () => {
      const control = { send: vi.fn(async () => { throw new Error('no pane'); }), stop: vi.fn(async () => {}) };
      const { inbox, post, answerOf } = await setup({ control });
      await inbox.receive(await post('l1', request()));
      await inbox.receive(await post('s1', sendReq()));
      await inbox.receive(await post('s2', sendReq({ prompt: '   ' })));
      await inbox.receive(await post('s3', sendReq({ targetSessionId: undefined })));
      expect(await answerOf('s1')).toEqual({ ok: false, reason: 'launch-failed', detail: 'no pane' });
      expect(await answerOf('s2')).toEqual({ ok: false, reason: 'bad-payload' });
      expect(await answerOf('s3')).toEqual({ ok: false, reason: 'bad-payload' });
    });

    it('op の欄が無い頼みは今までどおり起動、知らない op は封じられない', async () => {
      const { inbox, post, start, answerOf } = await setup();
      await inbox.receive(await post('l1', request()));
      await inbox.receive(await post('l2', { ...request(), op: 'launch' }));
      expect(start).toHaveBeenCalledTimes(2);
      // 知らない op は、封じる側が断る（開く側も同じ検査で bad-payload にする）。
      await expect(post('l3', { ...request(), op: 'restart' as never })).rejects.toThrow();
      void answerOf;
    });
  });

  it('peer_launches の表は版 49 にある', () => {
    const db = openDb(':memory:');
    expect((db.prepare("select name from pragma_table_info('peer_launches')").all() as { name: string }[]).map((r) => r.name)).toEqual(['id', 'from_device', 'handled_at', 'result', 'sealed_answer', 'ok', 'answered', 'session_id', 'parent_session_id']);
    void upsertShared;
  });
});
