import { describe, expect, it, vi } from 'vitest';
import { aadAnswer, aadLaunch, deriveMobileKey, LAUNCH_TTL_MS, MOBILE_LAUNCH_ID_MAX, MOBILE_PROMPT_MAX, open, seal, type LaunchParams, type MobileLaunchAnswer, type MobileLaunchPayload } from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import type { LaunchResult } from '../runs/manager.ts';
import type { CloudClient } from '../sync/client.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { MobileLaunchInbox } from './launchInbox.ts';
import { mobileKeyFor } from './publisher.ts';

const SECRET = 'join-secret-for-tests-0123456789abcdef';
const OTHER_SECRET = 'another-join-secret-0123456789abcdef';
const T0 = 1_800_000_000_000;

const payload = (over: Partial<MobileLaunchPayload> = {}): MobileLaunchPayload => ({
  v: 1, createdAt: T0, projectId: 'project-a', scratch: false, accountId: 'primary', permissionMode: 'acceptEdits', model: 'sonnet', prompt: 'TODO の先頭をやって', ...over,
});

const result = (sessionId: string): LaunchResult => ({ run: { id: 'run-1', sessionId } as LaunchResult['run'], sessionId, tabs: [] });

function setup(o: { start?: (p: LaunchParams) => LaunchResult } = {}) {
  const db = openDb(':memory:');
  let now = T0;
  let canProcess = true;
  const cloud = new FakeCloudClient({ deviceId: 'pc-a', now: () => now });
  const start = vi.fn(o.start ?? (() => result('s-new')));
  const hasProjectHere = vi.fn((id: string) => id === 'project-a');
  const inbox = new MobileLaunchInbox({
    db, client: cloud, joinSecret: SECRET, deviceId: 'pc-a', start, hasProjectHere,
    hasAccount: (id) => id === 'primary', canProcess: () => canProcess, now: () => now,
  });
  /** スマホの依頼を置き、pull で届く形（launches）を返す。 */
  const post = async (id: string, p: unknown, o2: { secret?: string; aadTarget?: string; target?: string } = {}) => {
    const key = o2.secret ? await deriveMobileKey(o2.secret) : await mobileKeyFor(SECRET);
    cloud.postLaunch({ id, targetDevice: o2.target ?? 'pc-a', sealed: await seal(key, aadLaunch(id, o2.aadTarget ?? 'pc-a'), p) });
    return (await cloud.pullChanges(0, 100)).launches ?? [];
  };
  const answerOf = async (id: string): Promise<MobileLaunchAnswer> => open<MobileLaunchAnswer>(await mobileKeyFor(SECRET), aadAnswer(id), cloud.launches.get(id)!.sealedAnswer!);
  const recorded = (id: string) => db.prepare('select id, handled_at, result from mobile_launches where id = ?').get(id) as { id: string; handled_at: number; result: string } | undefined;
  return { db, cloud, start, hasProjectHere, inbox, post, answerOf, recorded, setNow: (t: number) => { now = t; }, setCanProcess: (v: boolean) => { canProcess = v; } };
}

describe('MobileLaunchInbox', () => {
  it('mobile_launches の表がある（版 29）', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare("select name from pragma_table_info('mobile_launches')").all() as { name: string }[]).map((r) => r.name);
    expect(cols).toEqual(['id', 'handled_at', 'result']);
  });

  it('正しい依頼で start が 1 回呼ばれ、答えに sessionId が入る', async () => {
    const { cloud, start, inbox, post, answerOf, recorded } = setup();
    await inbox.receive(await post('l1', payload()));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ projectId: 'project-a', account: 'primary', permissionMode: 'acceptEdits', model: 'sonnet', prompt: 'TODO の先頭をやって' });
    expect(cloud.launches.get('l1')!.status).toBe('started');
    expect(await answerOf('l1')).toEqual({ ok: true, sessionId: 's-new', title: 'TODO の先頭をやって' });
    expect(recorded('l1')).toMatchObject({ id: 'l1', handled_at: T0, result: 'started' });
  });

  it('既定の権限モードとモデル（空）は params に含めない', async () => {
    const { start, inbox, post } = setup();
    await inbox.receive(await post('l1', payload({ permissionMode: '', model: '' })));
    expect(start).toHaveBeenCalledWith({ projectId: 'project-a', account: 'primary', prompt: 'TODO の先頭をやって' });
  });

  it('すぐ始める（scratch）はプロジェクトを見ずにクイックセッションで起こす', async () => {
    const { start, hasProjectHere, inbox, post, answerOf } = setup();
    await inbox.receive(await post('l1', payload({ scratch: true, projectId: null })));
    expect(hasProjectHere).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith({ scratch: true, account: 'primary', permissionMode: 'acceptEdits', model: 'sonnet', prompt: 'TODO の先頭をやって' });
    expect((await answerOf('l1')).ok).toBe(true);
  });

  it('同じ依頼を 2 回 receive しても start は 1 回（並行に 2 回呼んでも 1 回）', async () => {
    const { cloud, start, inbox, post } = setup();
    // Worker の claim が 2 度通ってしまっても、手元の記録で止める。
    cloud.claimLaunch = async () => true;
    const l = await post('l1', payload());
    await inbox.receive(l);
    await inbox.receive(l);
    expect(start).toHaveBeenCalledTimes(1);
    const l2 = await post('l2', payload());
    await Promise.all([inbox.receive(l2), inbox.receive(l2)]);
    expect(start).toHaveBeenCalledTimes(2);
    // 1 回の受け取りの中で同じ ID が重なっても 1 回。
    const l3 = await post('l3', payload());
    await inbox.receive([...l3, ...l3]);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it('claim が 409 なら start を呼ばない', async () => {
    const { cloud, start, inbox, post, recorded } = setup();
    const l = await post('l1', payload());
    // ほかで受け取られた（2 回目の claim は実物では 409）。
    expect(await cloud.claimLaunch('l1')).toBe(true);
    await inbox.receive(l);
    expect(start).not.toHaveBeenCalled();
    expect(cloud.calls.filter((c) => c.method === 'answerLaunch')).toHaveLength(0);
    expect(recorded('l1')).toBeUndefined();
  });

  it('別の秘密で封じた依頼は bad-payload と答え、start を呼ばない', async () => {
    const { cloud, start, inbox, post, answerOf, recorded } = setup();
    await inbox.receive(await post('l1', payload(), { secret: OTHER_SECRET }));
    expect(start).not.toHaveBeenCalled();
    expect(await answerOf('l1')).toMatchObject({ ok: false, reason: 'bad-payload' });
    expect(cloud.launches.get('l1')!.status).toBe('failed');
    expect(recorded('l1')?.result).toBe('bad-payload');
  });

  it('AAD の宛先が自分でない依頼は bad-payload（ほかの PC 宛てを付け替えたもの）', async () => {
    const { start, inbox, post, answerOf } = setup();
    await inbox.receive(await post('l1', payload(), { aadTarget: 'pc-b' }));
    expect(start).not.toHaveBeenCalled();
    expect(await answerOf('l1')).toMatchObject({ ok: false, reason: 'bad-payload' });
  });

  it('形の違う中身（版、権限モード、モデル）は bad-payload', async () => {
    const { start, inbox, post, answerOf } = setup();
    await inbox.receive(await post('l1', { ...payload(), v: 2 }));
    await inbox.receive(await post('l2', payload({ permissionMode: 'yolo' })));
    await inbox.receive(await post('l3', payload({ model: '--dangerously-skip-permissions' })));
    await inbox.receive(await post('l4', { ...payload(), prompt: 42 }));
    expect(start).not.toHaveBeenCalled();
    for (const id of ['l1', 'l2', 'l3', 'l4']) expect(await answerOf(id)).toMatchObject({ ok: false, reason: 'bad-payload' });
  });

  it('createdAt が TTL と 5 分の余裕より古い依頼は expired', async () => {
    const { start, inbox, post, answerOf } = setup();
    await inbox.receive(await post('l1', payload({ createdAt: T0 - LAUNCH_TTL_MS - 5 * 60_000 - 1 })));
    await inbox.receive(await post('l2', payload({ createdAt: T0 - LAUNCH_TTL_MS - 5 * 60_000 + 1 })));
    expect(await answerOf('l1')).toMatchObject({ ok: false, reason: 'expired' });
    expect((await answerOf('l2')).ok).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('この PC に場所の無いプロジェクトは project-missing、無いアカウントは account-missing', async () => {
    const { start, inbox, post, answerOf, recorded } = setup();
    await inbox.receive(await post('l1', payload({ projectId: 'project-b' })));
    await inbox.receive(await post('l2', payload({ projectId: null })));
    await inbox.receive(await post('l3', payload({ accountId: 'account-z' })));
    expect(start).not.toHaveBeenCalled();
    expect(await answerOf('l1')).toMatchObject({ ok: false, reason: 'project-missing' });
    expect(await answerOf('l2')).toMatchObject({ ok: false, reason: 'project-missing' });
    expect(await answerOf('l3')).toMatchObject({ ok: false, reason: 'account-missing' });
    expect(recorded('l3')?.result).toBe('account-missing');
  });

  it('start が投げたら launch-failed と答え、mobile_launches に記録される', async () => {
    const { cloud, inbox, post, answerOf, recorded } = setup({ start: () => { throw new Error('tmux が見つかりません'); } });
    await inbox.receive(await post('l1', payload()));
    expect(await answerOf('l1')).toEqual({ ok: false, reason: 'launch-failed', detail: 'tmux が見つかりません' });
    expect(cloud.launches.get('l1')!.status).toBe('failed');
    expect(recorded('l1')?.result).toBe('launch-failed');
  });

  it('answerLaunch が失敗しても、次の receive で同じ依頼を起こさない', async () => {
    const { cloud, start, inbox, post, recorded } = setup();
    cloud.claimLaunch = async () => true;
    const answer = vi.spyOn(cloud, 'answerLaunch').mockRejectedValueOnce(new Error('offline'));
    const l = await post('l1', payload());
    await inbox.receive(l);
    expect(recorded('l1')?.result).toBe('started');
    await inbox.receive(l);
    expect(start).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('claim が通信で失敗した依頼は記録せず、次の receive でもう一度試す', async () => {
    const { cloud, start, inbox, post } = setup();
    const l = await post('l1', payload());
    cloud.offline = true;
    await inbox.receive(l);
    expect(start).not.toHaveBeenCalled();
    cloud.offline = false;
    await inbox.receive(l);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('起こせた会話の題は手元の表示名、無ければ最初の指示の先頭 40 字', async () => {
    const long = 'あ'.repeat(50);
    const { db, inbox, post, answerOf } = setup({ start: () => result('s-1') });
    await inbox.receive(await post('l1', payload({ prompt: long })));
    expect(await answerOf('l1')).toMatchObject({ ok: true, title: 'あ'.repeat(40) });
    db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, ai_title, updated_at, origin_device) values ('s-1', 'claude-code', 'u1', '/w', 'pc-a', '会話 1', 1, 'pc-a')").run();
    await inbox.receive(await post('l2', payload()));
    expect(await answerOf('l2')).toMatchObject({ ok: true, title: '会話 1' });
  });

  it('client が claim の口を持たなければ何もしない', async () => {
    const { start, post } = setup();
    const l = await post('l1', payload());
    const answerLaunch = vi.fn();
    const bare = { answerLaunch } as unknown as CloudClient;
    const inbox = new MobileLaunchInbox({ db: openDb(':memory:'), client: bare, joinSecret: SECRET, deviceId: 'pc-a', start, hasProjectHere: () => true, hasAccount: () => true, canProcess: () => true, now: () => T0 });
    await inbox.receive(l);
    expect(start).not.toHaveBeenCalled();
    expect(answerLaunch).not.toHaveBeenCalled();
  });

  it('長すぎる最初の指示と ID は bad-payload', async () => {
    const { start, inbox, post, answerOf } = setup();
    await inbox.receive(await post('l1', payload({ prompt: 'a'.repeat(MOBILE_PROMPT_MAX + 1) })));
    await inbox.receive(await post('l2', payload({ projectId: 'p'.repeat(MOBILE_LAUNCH_ID_MAX + 1) })));
    await inbox.receive(await post('l3', payload({ accountId: 'a'.repeat(MOBILE_LAUNCH_ID_MAX + 1) })));
    expect(start).not.toHaveBeenCalled();
    for (const id of ['l1', 'l2', 'l3']) expect(await answerOf(id)).toMatchObject({ ok: false, reason: 'bad-payload' });
    // 上限ちょうどは通る。
    await inbox.receive(await post('l4', payload({ prompt: 'a'.repeat(MOBILE_PROMPT_MAX) })));
    expect((await answerOf('l4')).ok).toBe(true);
  });

  it('起こした後に題を読めなくても started と答え、題は最初の指示の最初の行にする', async () => {
    const { db, cloud, inbox, post, answerOf, recorded } = setup();
    const l = await post('l1', payload({ prompt: '\n会話 1 の指示\n続きの行' }));
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('from sessions s left join session_notes')) throw new Error('database is locked');
      return prepare(sql);
    }) as typeof db.prepare);
    await inbox.receive(l);
    expect(await answerOf('l1')).toEqual({ ok: true, sessionId: 's-new', title: '会話 1 の指示' });
    expect(cloud.launches.get('l1')!.status).toBe('started');
    expect(recorded('l1')?.result).toBe('started');
  });

  it('扱ってよくないあいだは claim せずに残し、扱えるようになったら起こす', async () => {
    const { cloud, start, inbox, post, recorded, setCanProcess } = setup();
    const l = await post('l1', payload());
    setCanProcess(false);
    await inbox.receive(l);
    expect(cloud.calls.filter((c) => c.method === 'claimLaunch')).toHaveLength(0);
    expect(cloud.launches.get('l1')!.status).toBe('pending');
    expect(recorded('l1')).toBeUndefined();
    setCanProcess(true);
    await inbox.receive(l);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('scratch なら projectId が入っていても見ずに、クイックセッションで起こす', async () => {
    const { start, hasProjectHere, inbox, post, answerOf } = setup();
    await inbox.receive(await post('l1', payload({ scratch: true, projectId: 'project-b' })));
    expect(hasProjectHere).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith({ scratch: true, account: 'primary', permissionMode: 'acceptEdits', model: 'sonnet', prompt: 'TODO の先頭をやって' });
    expect((await answerOf('l1')).ok).toBe(true);
  });
});
