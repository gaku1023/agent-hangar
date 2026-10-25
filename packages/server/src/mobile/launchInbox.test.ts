import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aadAnswer, aadImage, aadLaunch, appendPaths, quotePath, EFFORT_VALUES, LAUNCH_TTL_MS, MOBILE_IMAGE_MAX_BYTES, sealBytes, MOBILE_LAUNCH_ID_MAX, MOBILE_PROMPT_MAX, open, seal, type LaunchParams, type MobileLaunchAnswer, type MobileLaunchPayload } from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import type { LaunchResult } from '../runs/manager.ts';
import type { CloudClient } from '../sync/client.ts';
import type { PhoneKeySource } from '../sync/phoneKeys.ts';
import { testKey } from '../../test/cloudConfig.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { fixedPhoneKeys, PHONE_KEY_1, PHONE_KEY_2, phoneCryptoKey } from '../../test/phoneKeys.ts';
import { ANSWER_RESEND_WINDOW_MS, MOBILE_LAUNCH_KEEP_MS, MobileLaunchInbox, type MobileLaunchInboxDeps } from './launchInbox.ts';

/** PC の知らないスマホ用の鍵（別のクラウドの M）。 */
const OTHER_KEY = testKey(11);
const T0 = 1_800_000_000_000;

const payload = (over: Partial<MobileLaunchPayload> = {}): MobileLaunchPayload => ({
  v: 1, createdAt: T0, projectId: 'project-a', scratch: false, accountId: 'primary', permissionMode: 'acceptEdits', model: 'sonnet', prompt: 'TODO の先頭をやって', ...over,
});

const result = (sessionId: string): LaunchResult => ({ run: { id: 'run-1', sessionId } as LaunchResult['run'], sessionId, tabs: [] });

const tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup(o: { start?: (p: LaunchParams) => LaunchResult | Promise<LaunchResult>; phoneKeys?: Pick<PhoneKeySource, 'at'>; onStarted?: MobileLaunchInboxDeps['onStarted']; opencodeReady?: boolean } = {}) {
  const db = openDb(':memory:');
  const dropsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-inbox-')), 'drops');
  tmpDirs.push(path.dirname(dropsDir));
  let now = T0;
  let canProcess = true;
  const cloud = new FakeCloudClient({ deviceId: 'pc-a', now: () => now });
  const start = vi.fn(o.start ?? (() => result('s-new')));
  const hasProjectHere = vi.fn((id: string) => id === 'project-a');
  const inbox = new MobileLaunchInbox({
    db, client: cloud, phoneKeys: o.phoneKeys ?? fixedPhoneKeys(), deviceId: 'pc-a', dropsDir, start, hasProjectHere,
    hasAccount: (id) => id === 'primary', canProcess: () => canProcess, now: () => now,
    hasAgent: (a) => a === 'opencode' && (o.opencodeReady ?? true),
    ...(o.onStarted ? { onStarted: o.onStarted } : {}),
  });
  /** スマホの依頼を置き、pull で届く形（launches）を返す。key は封じる M（省けば M[1]）、epoch は依頼が名乗る世代（省けば 1）。置くのはスマホ phone-1 である。 */
  const post = async (id: string, p: unknown, o2: { key?: string; epoch?: number; aadTarget?: string; target?: string } = {}) => {
    const key = await phoneCryptoKey(o2.key ?? PHONE_KEY_1);
    cloud.asDevice('phone-1').postLaunch({ id, targetDevice: o2.target ?? 'pc-a', sealed: await seal(key, aadLaunch(id, o2.aadTarget ?? 'pc-a'), p), epoch: o2.epoch ?? 1 });
    return (await cloud.pullChanges(0, 100)).launches ?? [];
  };
  const answerOf = async (id: string, raw = PHONE_KEY_1): Promise<MobileLaunchAnswer> => open<MobileLaunchAnswer>(await phoneCryptoKey(raw), aadAnswer(id), cloud.launches.get(id)!.sealedAnswer!);
  const recorded = (id: string) => db.prepare('select id, handled_at, result from mobile_launches where id = ?').get(id) as { id: string; handled_at: number; result: string } | undefined;
  /** スマホが画像を置く真似。aadN で封の番号を取り違えた画像も置ける。 */
  const putImage = async (id: string, n: number, bytes: Uint8Array, o2: { key?: string; aadN?: number } = {}) => {
    const key = await phoneCryptoKey(o2.key ?? PHONE_KEY_1);
    cloud.putBlob(id, n, await sealBytes(key, aadImage(id, o2.aadN ?? n), bytes));
  };
  return { db, cloud, dropsDir, putImage, start, hasProjectHere, inbox, post, answerOf, recorded, setNow: (t: number) => { now = t; }, setCanProcess: (v: boolean) => { canProcess = v; } };
}

describe('MobileLaunchInbox', () => {
  it('mobile_launches の表がある（版 29、答えの控えは版 31、起こした会話と権限モードは版 33）', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare("select name from pragma_table_info('mobile_launches')").all() as { name: string }[]).map((r) => r.name);
    expect(cols).toEqual(['id', 'handled_at', 'result', 'sealed_answer', 'ok', 'answered', 'session_id', 'permission_mode']);
  });

  it('スマホから起こすと、手元の記録に会話の ID と権限モードを控え、受け手に送り手のスマホと会話とプロジェクトと権限モードを渡す', async () => {
    const onStarted = vi.fn();
    const { db, inbox, post } = setup({ onStarted });
    await inbox.receive(await post('l1', payload({ permissionMode: 'auto' })));
    expect(db.prepare('select session_id, permission_mode from mobile_launches where id = ?').get('l1')).toEqual({ session_id: 's-new', permission_mode: 'auto' });
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledWith({ sessionId: 's-new', from: 'phone-1', projectId: 'project-a', scratch: false, permissionMode: 'auto', title: 'TODO の先頭をやって' });
  });

  it('Bypass permissions の依頼も権限モードを控える。既定の権限モードは空で控える。起こせなかった依頼は会話を控えず、受け手も呼ばない', async () => {
    const onStarted = vi.fn();
    const { db, inbox, post } = setup({ onStarted });
    await inbox.receive(await post('l1', payload({ permissionMode: 'bypassPermissions' })));
    await inbox.receive(await post('l2', payload({ permissionMode: '' })));
    await inbox.receive(await post('l3', payload({ projectId: 'project-b' })));
    const row = (id: string) => db.prepare('select session_id, permission_mode from mobile_launches where id = ?').get(id);
    expect(row('l1')).toEqual({ session_id: 's-new', permission_mode: 'bypassPermissions' });
    expect(row('l2')).toEqual({ session_id: 's-new', permission_mode: '' });
    expect(row('l3')).toEqual({ session_id: null, permission_mode: null });
    expect(onStarted.mock.calls.map((c) => (c[0] as { permissionMode: string }).permissionMode)).toEqual(['bypassPermissions', '']);
  });

  it('受け手が投げても、起こした依頼の答えは started のまま送る', async () => {
    const { cloud, inbox, post } = setup({ onStarted: () => { throw new Error('boom'); } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await inbox.receive(await post('l1', payload()));
    expect(cloud.launches.get('l1')!.status).toBe('started');
    err.mockRestore();
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

  it('同じ世代を名乗る別の鍵で封じた依頼は bad-payload と答え、start を呼ばない', async () => {
    const { cloud, start, inbox, post, answerOf, recorded } = setup();
    await inbox.receive(await post('l1', payload(), { key: OTHER_KEY }));
    expect(start).not.toHaveBeenCalled();
    expect(await answerOf('l1')).toMatchObject({ ok: false, reason: 'bad-payload' });
    expect(cloud.launches.get('l1')!.status).toBe('failed');
    expect(recorded('l1')?.result).toBe('bad-payload');
  });

  it('依頼は依頼が名乗る世代の M で開き、答えも同じ世代で封じる', async () => {
    const keys = fixedPhoneKeys({ 1: PHONE_KEY_1, 2: PHONE_KEY_2 });
    const { start, inbox, post, answerOf } = setup({ phoneKeys: keys });
    await inbox.receive(await post('l1', payload(), { key: PHONE_KEY_1, epoch: 1 }));
    await inbox.receive(await post('l2', payload(), { key: PHONE_KEY_2, epoch: 2 }));
    expect(start).toHaveBeenCalledTimes(2);
    expect(keys.asked).toEqual([1, 2]);
    expect(await answerOf('l1', PHONE_KEY_1)).toMatchObject({ ok: true });
    expect(await answerOf('l2', PHONE_KEY_2)).toMatchObject({ ok: true });
    await expect(answerOf('l2', PHONE_KEY_1)).rejects.toThrow();
  });

  it('鍵の無い世代の依頼は claim せずに残し（答えない、記録しない）、鍵が届いた後の pull で扱う', async () => {
    const have: Record<number, string> = { 1: PHONE_KEY_1 };
    const { cloud, start, inbox, post, recorded } = setup({ phoneKeys: { at: (e) => fixedPhoneKeys(have).at(e) } });
    const l = await post('l1', payload(), { key: PHONE_KEY_2, epoch: 2 });
    await inbox.receive(l);
    expect(start).not.toHaveBeenCalled();
    expect(cloud.calls.filter((c) => c.method === 'claimLaunch')).toHaveLength(0);
    expect(cloud.launches.get('l1')!.status).toBe('pending');
    expect(recorded('l1')).toBeUndefined();
    // 名簿の読み直しで M[2] が届いた。
    have[2] = PHONE_KEY_2;
    await inbox.receive(l);
    expect(start).toHaveBeenCalledTimes(1);
    expect(cloud.launches.get('l1')!.status).toBe('started');
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

  it('start が非同期でも待ってから答える。拒まれたら launch-failed', async () => {
    const ok = setup({ start: async () => { await new Promise((r) => setTimeout(r, 5)); return result('s-async'); } });
    await ok.inbox.receive(await ok.post('l1', payload()));
    expect(await ok.answerOf('l1')).toMatchObject({ ok: true, sessionId: 's-async' });
    expect(ok.recorded('l1')?.result).toBe('started');
    const ng = setup({ start: async () => { await new Promise((r) => setTimeout(r, 5)); throw new Error('opencode を起動できませんでした'); } });
    await ng.inbox.receive(await ng.post('l2', payload()));
    expect(await ng.answerOf('l2')).toEqual({ ok: false, reason: 'launch-failed', detail: 'opencode を起動できませんでした' });
    expect(ng.recorded('l2')?.result).toBe('launch-failed');
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

  it('答えを送れなかったら、封じた答えを控え、resendAnswers で同じ封のまま送り直す', async () => {
    const { cloud, start, inbox, post, answerOf, db } = setup();
    const answer = vi.spyOn(cloud, 'answerLaunch').mockRejectedValueOnce(new Error('offline'));
    await inbox.receive(await post('l1', payload()));
    const row = () => db.prepare('select sealed_answer, ok, answered from mobile_launches where id = ?').get('l1') as { sealed_answer: string | null; ok: number; answered: number };
    expect(row()).toMatchObject({ ok: 1, answered: 0 });
    const sealed = row().sealed_answer;
    expect(sealed).toBeTruthy();
    expect(cloud.launches.get('l1')!.status).toBe('claimed');
    await inbox.resendAnswers();
    expect(answer).toHaveBeenCalledTimes(2);
    expect(answer.mock.calls[1]).toEqual(['l1', true, sealed]);
    expect(cloud.launches.get('l1')!.status).toBe('started');
    expect(await answerOf('l1')).toMatchObject({ ok: true, sessionId: 's-new' });
    expect(row().answered).toBe(1);
    // 届いた答えはもう送らない。会話も二度起こさない。
    await inbox.resendAnswers();
    expect(answer).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('届いた答えは answered にし、送り直さない', async () => {
    const { cloud, inbox, post, db } = setup();
    await inbox.receive(await post('l1', payload()));
    expect((db.prepare('select answered from mobile_launches where id = ?').get('l1') as { answered: number }).answered).toBe(1);
    const answer = vi.spyOn(cloud, 'answerLaunch');
    await inbox.resendAnswers();
    expect(answer).not.toHaveBeenCalled();
  });

  it('送り直しが 409（もう答えた、時間切れ）なら answered にして、それ以上送らない', async () => {
    const { cloud, inbox, post, db } = setup();
    const answer = vi.spyOn(cloud, 'answerLaunch').mockRejectedValueOnce(new Error('offline'));
    await inbox.receive(await post('l1', payload()));
    // Worker ではもう claimed でない（ほかの経路で答えが届いた）。
    cloud.launches.get('l1')!.status = 'started';
    await inbox.resendAnswers();
    expect(answer).toHaveBeenCalledTimes(2);
    expect((db.prepare('select answered from mobile_launches where id = ?').get('l1') as { answered: number }).answered).toBe(1);
    await inbox.resendAnswers();
    expect(answer).toHaveBeenCalledTimes(2);
  });

  it('送り直しが通信で倒れたら、次の回にもう一度送る。扱ってから 10 分を過ぎたら送らない', async () => {
    const { cloud, inbox, post, setNow } = setup();
    const answer = vi.spyOn(cloud, 'answerLaunch').mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    await inbox.receive(await post('l1', payload()));
    await inbox.resendAnswers();
    expect(answer).toHaveBeenCalledTimes(2);
    setNow(T0 + ANSWER_RESEND_WINDOW_MS + 1);
    await inbox.resendAnswers();
    expect(answer).toHaveBeenCalledTimes(2);
    expect(ANSWER_RESEND_WINDOW_MS).toBe(10 * 60_000);
  });

  it('扱ってよくないあいだは答えを送り直さない', async () => {
    const { cloud, inbox, post, setCanProcess } = setup();
    const answer = vi.spyOn(cloud, 'answerLaunch').mockRejectedValueOnce(new Error('offline'));
    await inbox.receive(await post('l1', payload()));
    setCanProcess(false);
    await inbox.resendAnswers();
    expect(answer).toHaveBeenCalledTimes(1);
    setCanProcess(true);
    await inbox.resendAnswers();
    expect(answer).toHaveBeenCalledTimes(2);
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
    const inbox = new MobileLaunchInbox({ db: openDb(':memory:'), client: bare, phoneKeys: fixedPhoneKeys(), deviceId: 'pc-a', dropsDir: os.tmpdir(), start, hasProjectHere: () => true, hasAccount: () => true, canProcess: () => true, now: () => T0 });
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

describe('MobileLaunchInbox の effort', () => {
  it('値表にある effort は params に写る', async () => {
    const { start, inbox, post } = setup();
    for (const [i, e] of EFFORT_VALUES.filter((x) => x !== '').entries()) await inbox.receive(await post(`e${i}`, payload({ effort: e })));
    expect(start.mock.calls.map((c) => c[0].effort)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('effort が無い、または空（既定）なら params に付けない', async () => {
    const { start, inbox, post } = setup();
    await inbox.receive(await post('l1', payload()));
    await inbox.receive(await post('l2', payload({ effort: '' })));
    expect(start.mock.calls[0]![0]).not.toHaveProperty('effort');
    expect(start.mock.calls[1]![0]).not.toHaveProperty('effort');
  });

  it('値表に無い effort は bad-payload で起こさない', async () => {
    const { start, inbox, post, answerOf } = setup();
    await inbox.receive(await post('l1', payload({ effort: 'ultra' })));
    await inbox.receive(await post('l2', { ...payload(), effort: 3 }));
    await inbox.receive(await post('l3', payload({ effort: '--dangerous' })));
    expect(start).not.toHaveBeenCalled();
    for (const id of ['l1', 'l2', 'l3']) expect(await answerOf(id)).toMatchObject({ ok: false, reason: 'bad-payload' });
  });
});

/** opencode の依頼。アカウントと権限モードは空、effort は無い。 */
const ocPayload = (over: Partial<MobileLaunchPayload> = {}): MobileLaunchPayload => payload({ agent: 'opencode', accountId: '', permissionMode: '', model: 'opencode/glm-5.3-flash-free', mode: 'plan', autoApprove: true, ...over });

describe('MobileLaunchInbox の opencode', () => {
  it('agent が opencode なら、アカウントを見ずに agent、mode、model、autoApprove を params に写して起こす', async () => {
    const { start, inbox, post, answerOf } = setup();
    await inbox.receive(await post('l1', ocPayload()));
    expect(start).toHaveBeenCalledWith({ projectId: 'project-a', agent: 'opencode', mode: 'plan', model: 'opencode/glm-5.3-flash-free', autoApprove: true, prompt: 'TODO の先頭をやって' });
    expect((await answerOf('l1')).ok).toBe(true);
  });

  it('mode、model、autoApprove が無い（既定）なら params に付けない。autoApprove が偽でも付けない', async () => {
    const { start, inbox, post } = setup();
    await inbox.receive(await post('l1', ocPayload({ mode: undefined, model: '', autoApprove: undefined })));
    await inbox.receive(await post('l2', ocPayload({ autoApprove: false, scratch: true, projectId: null })));
    expect(start.mock.calls[0]![0]).toEqual({ projectId: 'project-a', agent: 'opencode', prompt: 'TODO の先頭をやって' });
    expect(start.mock.calls[1]![0]).toEqual({ scratch: true, agent: 'opencode', mode: 'plan', model: 'opencode/glm-5.3-flash-free', prompt: 'TODO の先頭をやって' });
  });

  it('agent が claude-code と明示された依頼は、無いときと同じく Claude を起こす（params に agent を付けない）', async () => {
    const { start, inbox, post } = setup();
    await inbox.receive(await post('l1', payload({ agent: 'claude-code' })));
    expect(start).toHaveBeenCalledWith({ projectId: 'project-a', account: 'primary', permissionMode: 'acceptEdits', model: 'sonnet', prompt: 'TODO の先頭をやって' });
  });

  it('知らない agent は bad-payload で起こさない', async () => {
    const { start, inbox, post, answerOf } = setup();
    await inbox.receive(await post('l1', payload({ agent: 'codex' as never })));
    await inbox.receive(await post('l2', { ...payload(), agent: 1 }));
    await inbox.receive(await post('l3', { ...payload(), agent: null }));
    expect(start).not.toHaveBeenCalled();
    for (const id of ['l1', 'l2', 'l3']) expect(await answerOf(id)).toMatchObject({ ok: false, reason: 'bad-payload' });
  });

  it('opencode に権限モード、effort、アカウントが混ざった依頼は bad-payload で起こさない', async () => {
    const { start, inbox, post, answerOf } = setup();
    await inbox.receive(await post('l1', ocPayload({ permissionMode: 'bypassPermissions' })));
    await inbox.receive(await post('l2', ocPayload({ effort: 'high' })));
    await inbox.receive(await post('l3', ocPayload({ effort: '' })));
    await inbox.receive(await post('l4', ocPayload({ accountId: 'primary' })));
    expect(start).not.toHaveBeenCalled();
    for (const id of ['l1', 'l2', 'l3', 'l4']) expect(await answerOf(id)).toMatchObject({ ok: false, reason: 'bad-payload' });
  });

  it('形の違う mode、model、autoApprove は bad-payload', async () => {
    const { start, inbox, post, answerOf } = setup();
    await inbox.receive(await post('l1', ocPayload({ mode: '--dangerous' })));
    await inbox.receive(await post('l2', ocPayload({ mode: 'a b' })));
    await inbox.receive(await post('l3', ocPayload({ mode: '' })));
    await inbox.receive(await post('l4', ocPayload({ mode: 'x'.repeat(41) })));
    await inbox.receive(await post('l5', ocPayload({ model: '-p' })));
    await inbox.receive(await post('l6', { ...ocPayload(), autoApprove: 'yes' }));
    expect(start).not.toHaveBeenCalled();
    for (const id of ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']) expect(await answerOf(id)).toMatchObject({ ok: false, reason: 'bad-payload' });
  });

  it('Claude の依頼に mode や autoApprove が混ざったら bad-payload', async () => {
    const { start, inbox, post, answerOf } = setup();
    await inbox.receive(await post('l1', payload({ mode: 'plan' })));
    await inbox.receive(await post('l2', payload({ autoApprove: true })));
    await inbox.receive(await post('l3', payload({ agent: 'claude-code', autoApprove: false })));
    expect(start).not.toHaveBeenCalled();
    for (const id of ['l1', 'l2', 'l3']) expect(await answerOf(id)).toMatchObject({ ok: false, reason: 'bad-payload' });
  });

  it('この PC で opencode を使えない（無効、見つからない）なら agent-missing と答え、起こさない', async () => {
    const { start, inbox, post, answerOf, recorded } = setup({ opencodeReady: false });
    await inbox.receive(await post('l1', ocPayload()));
    expect(start).not.toHaveBeenCalled();
    expect(await answerOf('l1')).toEqual({ ok: false, reason: 'agent-missing' });
    expect(recorded('l1')).toMatchObject({ result: 'agent-missing' });
  });

  it('opencode の依頼でも、場所の無いプロジェクトは project-missing', async () => {
    const { start, inbox, post, answerOf } = setup();
    await inbox.receive(await post('l1', ocPayload({ projectId: 'project-b' })));
    expect(start).not.toHaveBeenCalled();
    expect(await answerOf('l1')).toMatchObject({ ok: false, reason: 'project-missing' });
  });

  it('自動承認の opencode の依頼は、権限モードを bypassPermissions として控える（一覧のラベル「スマホから」）。自動承認なしは空', async () => {
    const onStarted = vi.fn();
    const { db, inbox, post } = setup({ onStarted });
    await inbox.receive(await post('l1', ocPayload({ autoApprove: true })));
    await inbox.receive(await post('l2', ocPayload({ autoApprove: false })));
    const row = (id: string) => db.prepare('select permission_mode from mobile_launches where id = ?').get(id);
    expect(row('l1')).toEqual({ permission_mode: 'bypassPermissions' });
    expect(row('l2')).toEqual({ permission_mode: '' });
    expect(onStarted.mock.calls.map((c) => (c[0] as { permissionMode: string }).permissionMode)).toEqual(['bypassPermissions', '']);
  });
});

const IMG = (...v: number[]) => new Uint8Array(v);
const ref = (n: number, bytes: number, mime: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg') => ({ n, mime, bytes });

describe('MobileLaunchInbox の画像', () => {
  it('画像を取って開き、drops に置き、指示の末尾にパスを足して起こす（指示欄と同じ並び）', async () => {
    const { start, inbox, post, putImage, answerOf, dropsDir } = setup();
    const l = await post('l1', payload({ images: [ref(0, 3), ref(1, 4, 'image/png')] }));
    await putImage('l1', 0, IMG(1, 2, 3));
    await putImage('l1', 1, IMG(9, 8, 7, 6));
    await inbox.receive(l);
    expect((await answerOf('l1')).ok).toBe(true);
    const files = fs.readdirSync(dropsDir).sort();
    expect(files).toHaveLength(2);
    const paths = files.map((f) => path.join(dropsDir, f));
    expect([...fs.readFileSync(paths[0]!)]).toEqual([1, 2, 3]);
    expect([...fs.readFileSync(paths[1]!)]).toEqual([9, 8, 7, 6]);
    expect(paths[0]).toMatch(/\.jpg$/);
    expect(paths[1]).toMatch(/\.png$/);
    expect(start.mock.calls[0]![0].prompt).toBe(appendPaths('TODO の先頭をやって', paths));
    expect(start.mock.calls[0]![0].prompt).toContain(`\n\n${quotePath(paths[0]!)}\n${quotePath(paths[1]!)}`);
  });

  it('指示が空でも、画像のパスだけの指示で起こす', async () => {
    const { start, inbox, post, putImage, dropsDir } = setup();
    const l = await post('l1', payload({ prompt: '', images: [ref(0, 1, 'image/webp')] }));
    await putImage('l1', 0, IMG(5));
    await inbox.receive(l);
    const [f] = fs.readdirSync(dropsDir);
    expect(start.mock.calls[0]![0].prompt).toBe(quotePath(path.join(dropsDir, f!)));
  });

  it('画像が取れない（Worker に無い）なら起こさず images-missing と答える。置いた分は消す', async () => {
    const { cloud, start, inbox, post, putImage, answerOf, dropsDir, recorded } = setup();
    const l = await post('l1', payload({ images: [ref(0, 3), ref(1, 3)] }));
    await putImage('l1', 0, IMG(1, 2, 3));
    await inbox.receive(l);
    expect(start).not.toHaveBeenCalled();
    expect(await answerOf('l1')).toMatchObject({ ok: false, reason: 'images-missing' });
    expect(cloud.launches.get('l1')!.status).toBe('failed');
    expect(recorded('l1')?.result).toBe('images-missing');
    expect(fs.existsSync(dropsDir) ? fs.readdirSync(dropsDir) : []).toEqual([]);
  });

  it('別の鍵、番号を取り違えた封、壊れた封の画像は開けず images-missing', async () => {
    for (const bad of ['key', 'aad', 'junk'] as const) {
      const { cloud, start, inbox, post, putImage, answerOf } = setup();
      const l = await post('l1', payload({ images: [ref(0, 3)] }));
      if (bad === 'key') await putImage('l1', 0, IMG(1, 2, 3), { key: OTHER_KEY });
      else if (bad === 'aad') await putImage('l1', 0, IMG(1, 2, 3), { aadN: 1 });
      else cloud.putBlob('l1', 0, IMG(1, 2, 3, 4, 5));
      await inbox.receive(l);
      expect(start, bad).not.toHaveBeenCalled();
      expect(await answerOf('l1'), bad).toMatchObject({ ok: false, reason: 'images-missing' });
    }
  });

  it('開いた画像が 1 枚の上限を超えるなら images-missing', async () => {
    const { start, inbox, post, putImage, answerOf } = setup();
    const l = await post('l1', payload({ images: [ref(0, MOBILE_IMAGE_MAX_BYTES)] }));
    await putImage('l1', 0, new Uint8Array(MOBILE_IMAGE_MAX_BYTES + 1));
    await inbox.receive(l);
    expect(start).not.toHaveBeenCalled();
    expect(await answerOf('l1')).toMatchObject({ ok: false, reason: 'images-missing' });
  });

  it('画像の置き場に書けないときも起こさず images-missing', async () => {
    const { start, inbox, post, putImage, answerOf, dropsDir } = setup();
    // 置き場の場所をファイルで塞ぐ。
    fs.mkdirSync(path.dirname(dropsDir), { recursive: true });
    fs.writeFileSync(dropsDir, 'not a dir');
    const l = await post('l1', payload({ images: [ref(0, 1)] }));
    await putImage('l1', 0, IMG(1));
    await inbox.receive(l);
    expect(start).not.toHaveBeenCalled();
    expect(await answerOf('l1')).toMatchObject({ ok: false, reason: 'images-missing' });
  });

  it('画像の控えが形の違うものは bad-payload（4 枚を超える、番号が重なる、範囲外、mime が許しの外、大きさが不正）', async () => {
    const { cloud, start, inbox, post, answerOf } = setup();
    const cases: Record<string, unknown> = {
      five: [ref(0, 1), ref(1, 1), ref(2, 1), ref(3, 1), ref(4, 1)],
      dup: [ref(0, 1), ref(0, 1)],
      range: [ref(4, 1)],
      negative: [ref(-1, 1)],
      fraction: [ref(0.5, 1)],
      mime: [{ n: 0, mime: 'image/gif', bytes: 1 }],
      svg: [{ n: 0, mime: 'image/svg+xml', bytes: 1 }],
      bytes: [{ n: 0, mime: 'image/jpeg', bytes: -1 }],
      huge: [ref(0, MOBILE_IMAGE_MAX_BYTES + 1)],
      notArray: 'x',
      notObject: [null],
    };
    for (const [name, images] of Object.entries(cases)) {
      await inbox.receive(await post(`l-${name}`, { ...payload(), images }));
      expect(await answerOf(`l-${name}`), name).toMatchObject({ ok: false, reason: 'bad-payload' });
    }
    expect(start).not.toHaveBeenCalled();
    // 画像は 1 枚も取りに行っていない。
    expect(cloud.calls.filter((c) => c.method === 'getMobileBlob')).toHaveLength(0);
  });

  it('4 枚までは通り、images が空の配列なら画像なしと同じ', async () => {
    const { start, inbox, post, putImage } = setup();
    const l = await post('l1', payload({ images: [ref(0, 1), ref(1, 1), ref(2, 1), ref(3, 1)] }));
    for (let n = 0; n < 4; n++) await putImage('l1', n, IMG(n));
    await inbox.receive(l);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0].prompt!.split('\n')).toHaveLength(2 + 4);
    await inbox.receive(await post('l2', payload({ images: [] })));
    expect(start.mock.calls[1]![0].prompt).toBe('TODO の先頭をやって');
  });

  it('プロジェクトが無い依頼では、画像を取りに行かない', async () => {
    const { cloud, inbox, post, putImage, answerOf } = setup();
    const l = await post('l1', payload({ projectId: 'project-b', images: [ref(0, 1)] }));
    await putImage('l1', 0, IMG(1));
    await inbox.receive(l);
    expect(await answerOf('l1')).toMatchObject({ ok: false, reason: 'project-missing' });
    expect(cloud.calls.filter((c) => c.method === 'getMobileBlob')).toHaveLength(0);
  });

  it('起こすのに失敗したら置いた画像を消す', async () => {
    const { inbox, post, putImage, answerOf, dropsDir } = setup({ start: () => { throw new Error('boom'); } });
    const l = await post('l1', payload({ images: [ref(0, 1)] }));
    await putImage('l1', 0, IMG(1));
    await inbox.receive(l);
    expect(await answerOf('l1')).toMatchObject({ ok: false, reason: 'launch-failed' });
    expect(fs.readdirSync(dropsDir)).toEqual([]);
  });

  it('起こすのに失敗した後の始末で例外が出ても、置いた画像は消す（7 日残さない）', async () => {
    // 失敗の理由を読むところで投げる Error。decide の外まで例外が抜ける出口になる。
    const { inbox, post, putImage, answerOf, dropsDir, start } = setup({
      start: () => { const e = new Error('x'); Object.defineProperty(e, 'message', { get() { throw new Error('unreadable'); } }); throw e; },
    });
    const l = await post('l1', payload({ images: [ref(0, 1)] }));
    await putImage('l1', 0, IMG(1));
    await inbox.receive(l);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await answerOf('l1')).toMatchObject({ ok: false, reason: 'launch-failed' });
    expect(fs.readdirSync(dropsDir)).toEqual([]);
  });

  it('封じた画像が 1 枚の上限に封の 28 バイトを足した大きさを超えるなら、開かずに images-missing', async () => {
    const { cloud, start, inbox, post, answerOf } = setup();
    const l = await post('l1', payload({ images: [ref(0, MOBILE_IMAGE_MAX_BYTES)] }));
    cloud.putBlob('l1', 0, new Uint8Array(MOBILE_IMAGE_MAX_BYTES + 29));
    await inbox.receive(l);
    expect(start).not.toHaveBeenCalled();
    expect(await answerOf('l1')).toMatchObject({ ok: false, reason: 'images-missing' });
  });

  it('封じた画像がちょうど上限（封の 28 バイトを足した大きさ）なら通る', async () => {
    const { start, inbox, post, putImage } = setup();
    const l = await post('l1', payload({ images: [ref(0, MOBILE_IMAGE_MAX_BYTES)] }));
    await putImage('l1', 0, new Uint8Array(MOBILE_IMAGE_MAX_BYTES));
    await inbox.receive(l);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('起こした会話の題は、パスを足す前の指示から付ける', async () => {
    const { inbox, post, putImage, answerOf } = setup();
    const l = await post('l1', payload({ prompt: '画像を見て直して', images: [ref(0, 1)] }));
    await putImage('l1', 0, IMG(1));
    await inbox.receive(l);
    expect(await answerOf('l1')).toMatchObject({ ok: true, title: '画像を見て直して' });
  });
});

describe('MobileLaunchInbox の記録の掃除', () => {
  it('手元の mobile_launches の 7 日より古い行を、受け取るついでに消す', async () => {
    const { db, inbox, post, recorded, setNow } = setup();
    const ins = db.prepare('insert into mobile_launches (id, handled_at, result, answered) values (?, ?, ?, 1)');
    ins.run('old', T0 - MOBILE_LAUNCH_KEEP_MS - 1, 'started');
    ins.run('edge', T0 - MOBILE_LAUNCH_KEEP_MS, 'started');
    ins.run('new', T0 - 60_000, 'started');
    expect(MOBILE_LAUNCH_KEEP_MS).toBe(7 * 24 * 60 * 60_000);
    setNow(T0);
    await inbox.receive(await post('l1', payload()));
    expect(recorded('old')).toBeUndefined();
    expect(recorded('edge')).toBeDefined();
    expect(recorded('new')).toBeDefined();
    expect(recorded('l1')).toBeDefined();
  });

  it('起こした会話の行は、7 日を過ぎても会話が残っている間は消さない（ラベル「スマホから」を保つ）。会話を消したら消す', async () => {
    const { db, inbox, post, recorded, setNow } = setup();
    upsertShared(db, 'sessions', { id: 's-kept', provider: 'claude-code', provider_session_id: 'u-kept', cwd: '/w/a', home_device: 'pc-a' }, 'pc-a');
    upsertShared(db, 'sessions', { id: 's-gone', provider: 'claude-code', provider_session_id: 'u-gone', cwd: '/w/a', home_device: 'pc-a' }, 'pc-a');
    softDeleteShared(db, 'sessions', 's-gone', 'pc-a');
    const ins = db.prepare('insert into mobile_launches (id, handled_at, result, answered, session_id, permission_mode) values (?, ?, ?, 1, ?, ?)');
    ins.run('kept', T0 - MOBILE_LAUNCH_KEEP_MS - 1, 'started', 's-kept', 'auto');
    ins.run('gone', T0 - MOBILE_LAUNCH_KEEP_MS - 1, 'started', 's-gone', 'auto');
    ins.run('missing', T0 - MOBILE_LAUNCH_KEEP_MS - 1, 'started', 's-missing', 'auto');
    setNow(T0);
    await inbox.receive(await post('l1', payload()));
    expect(recorded('kept')).toBeDefined();
    expect(recorded('gone')).toBeUndefined();
    expect(recorded('missing')).toBeUndefined();
  });
});
