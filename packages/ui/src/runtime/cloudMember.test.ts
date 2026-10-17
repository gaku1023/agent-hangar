import { describe, expect, it, vi } from 'vitest';
import type { CloudDevicesDto, MobilePairingDto } from '@agent-hangar/shared';
import { initialCloudMember, RECOVERY_SHOW_MS, type CloudMemberState } from '../store/cloudMember.ts';
import type { CloudBridge } from './desktop.ts';
import { PAIR_TTL_MS as PAIR_TTL_SHOWN_MS } from '../presenters/cloudMember.ts';
import { CLOUD_RESTART_MS, createCloudMemberRunner, JOIN_POLL_MS, PAIR_POLL_MS, type JoinCodesApi, type RecoveryKeyApi } from './cloudMember.ts';

const check = { url: 'https://h.example', host: 'h.example', pcCount: 1, current: null };
const devices: CloudDevicesDto = { state: 'ok', devices: [], creator: false, message: null };

/** 発行した PC の口（サーバーの /api/sync/join-codes）の偽物。既定は何も発行していない状態を返す。 */
function fakeJoinCodes(over: Partial<JoinCodesApi> = {}): JoinCodesApi {
  return {
    current: vi.fn(async () => ({ kind: 'idle' as const })),
    issue: vi.fn(async () => ({ kind: 'open' as const, code: 'K7QM-2XFD', expiresAt: 300_000 })),
    approve: vi.fn(async () => ({ kind: 'done' as const, name: 'pc-b' })),
    reject: vi.fn(async () => ({ kind: 'idle' as const })),
    close: vi.fn(async () => ({ kind: 'idle' as const })),
    ...over,
  };
}

/** 「リカバリーキーを再発行」の口（サーバーの /api/sync/recovery-key）の偽物。 */
function fakeRecovery(over: Partial<RecoveryKeyApi> = {}): RecoveryKeyApi {
  return {
    reissue: vi.fn(async () => ({ text: RECOVERY_TEXT, draftId: 'd1' })),
    confirm: vi.fn(async () => {}),
    ...over,
  };
}
const RECOVERY_TEXT = 'hangar リカバリーキー\n作成日: 2026-10-17\nURL: https://h.example\n暗号鍵: AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH-JJJJ-KKKK-MMMM-NNNN-K2VB';
/** 状態番号つきの失敗（runtime/api.ts の ApiStatusError と同じ形）。 */
const statusError = (status: number, message: string) => Object.assign(new Error(message), { status });

function rig(bridge: Partial<CloudBridge> | null = {}, o: { joinCodes?: JoinCodesApi; now?: () => number; load?: () => Promise<CloudDevicesDto>; recovery?: RecoveryKeyApi } = {}) {
  let s: CloudMemberState = initialCloudMember();
  const timers: { fn: () => void; ms: number }[] = [];
  const restart = vi.fn();
  const load = vi.fn(o.load ?? (async () => devices));
  const full: CloudBridge | null = bridge === null ? null : {
    joinCheck: async () => ({ ok: true, value: check }),
    joinRequest: async () => ({ ok: true, value: { sas: '123456', expiresAt: 300_000 } }),
    joinPoll: async () => ({ ok: true, value: { status: 'waiting' as const } }),
    revoke: async (id) => ({ ok: true, value: { id, kind: 'pc' as const, joinedAt: 1, lastSeenAt: 2, revokedAt: 3, expiresAt: null } }),
    leave: async () => ({ ok: true, value: { revoked: true, revokeError: null, creator: false } }),
    ...bridge,
  };
  const joinCodes = o.joinCodes ?? fakeJoinCodes();
  const recovery = o.recovery ?? fakeRecovery();
  const r = createCloudMemberRunner({ bridge: full, load, pair: async () => ({ state: 'not-joined' }), joinCodes, recovery, now: o.now ?? (() => 0), restart, setTimeout: (fn, ms) => { timers.push({ fn, ms }); }, get: () => s, set: (n) => { s = n; } });
  /** いちばん古い、ms の長さの予約を 1 つ走らせる。 */
  const fire = async (ms: number) => {
    const i = timers.findIndex((t) => t.ms === ms);
    if (i < 0) throw new Error(`no timer of ${ms}ms`);
    const [t] = timers.splice(i, 1);
    t!.fn();
    await flush();
  };
  return { r, get: () => s, set: (n: CloudMemberState) => { s = n; }, timers, restart, load, joinCodes, recovery, fire };
}

const NOW = 1_700_000_000_000;
const phone = (id: string, over: Partial<CloudDevicesDto['devices'][number]> = {}): CloudDevicesDto['devices'][number] => ({ id, name: id, platform: null, joinedAt: NOW, lastSeenAt: NOW, revokedAt: null, expiresAt: null, kind: 'mobile', self: false, ...over });
const pc = { ...phone('studio'), platform: 'darwin', kind: 'pc' as const, self: true };
const ready: MobilePairingDto = { state: 'ready', pairUrl: 'https://w.example/app/#pair=PAIRTEXT', pairText: 'PAIRTEXT', expiresAt: NOW + PAIR_TTL_SHOWN_MS };

/** スマホの接続の段の試験台。時計は now で進め、予約は timers に積む（走らせるのは試験が選ぶ）。 */
function phoneRig(o: { pair?: () => Promise<MobilePairingDto>; lists?: CloudDevicesDto[] } = {}) {
  let s: CloudMemberState = { ...initialCloudMember(), devices: { state: 'ok', devices: [pc], creator: false, message: null } };
  let now = NOW;
  const timers: { fn: () => void; ms: number }[] = [];
  const lists = [...(o.lists ?? [])];
  const load = vi.fn(async () => lists.shift() ?? s.devices!);
  const pair = vi.fn(o.pair ?? (async () => ready));
  const r = createCloudMemberRunner({ bridge: null, load, pair, joinCodes: fakeJoinCodes(), recovery: fakeRecovery(), now: () => now, restart: () => {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); }, get: () => s, set: (n) => { s = n; } });
  /** いちばん古い、ms の長さの予約を 1 つ走らせる。 */
  const fire = async (ms: number) => {
    const i = timers.findIndex((t) => t.ms === ms);
    if (i < 0) throw new Error(`no timer of ${ms}ms`);
    const [t] = timers.splice(i, 1);
    t!.fn();
    await flush();
  };
  return { r, get: () => s, timers, load, pair, fire, tick: (ms: number) => { now += ms; } };
}

describe('スマホの接続の QR', () => {
  it('QR を出すと券を取り、ready の間は 3 秒ごとに端末の一覧を再読み込みする', async () => {
    const x = phoneRig();
    x.r.run({ op: 'pair' });
    expect(x.get().phone).toEqual({ kind: 'loading' });
    await flush();
    expect(x.get().phone).toMatchObject({ kind: 'ready', pairText: 'PAIRTEXT', expiresAt: NOW + PAIR_TTL_SHOWN_MS });
    expect(x.timers.map((t) => t.ms).sort()).toEqual([PAIR_POLL_MS, PAIR_TTL_SHOWN_MS].sort());
    await x.fire(PAIR_POLL_MS);
    await x.fire(PAIR_POLL_MS);
    expect(x.load).toHaveBeenCalledTimes(2);
    expect(x.timers.filter((t) => t.ms === PAIR_POLL_MS)).toHaveLength(1);
  });

  it('QR を出している間に kind=mobile の新しい行が現れたら paired にし、再読み込みを止める。前からあったスマホは数えない', async () => {
    const old = phone('old-phone');
    const base: CloudDevicesDto = { state: 'ok', devices: [pc, old], creator: false, message: null };
    const x = phoneRig({ lists: [base, base, { ...base, devices: [pc, old, phone('p1', { name: 'iPhone' })] }] });
    x.r.run({ op: 'load' });
    await flush();
    x.r.run({ op: 'pair' });
    await flush();
    await x.fire(PAIR_POLL_MS);
    expect(x.get().phone.kind).toBe('ready');
    await x.fire(PAIR_POLL_MS);
    expect(x.get().phone).toEqual({ kind: 'paired', id: 'p1', name: 'iPhone' });
    expect(x.get().devices?.devices.map((d) => d.id)).toEqual(['studio', 'old-phone', 'p1']);
    // paired になったら、残っていた予約が走っても読み直さない。
    const before = x.load.mock.calls.length;
    while (x.timers.some((t) => t.ms === PAIR_POLL_MS)) await x.fire(PAIR_POLL_MS);
    expect(x.load).toHaveBeenCalledTimes(before);
  });

  it('QR を閉じたら 3 秒ごとの読み直しが止まり、QR の中身も状態から消える', async () => {
    const x = phoneRig();
    x.r.run({ op: 'pair' });
    await flush();
    x.r.run({ op: 'pairClose' });
    expect(x.get().phone).toEqual({ kind: 'idle' });
    expect(JSON.stringify(x.get())).not.toContain('PAIRTEXT');
    await x.fire(PAIR_POLL_MS);
    expect(x.load).not.toHaveBeenCalled();
    expect(x.timers.some((t) => t.ms === PAIR_POLL_MS)).toBe(false);
  });

  it('5 分たったら expired にして QR の中身を捨て、読み直しも止める', async () => {
    const x = phoneRig();
    x.r.run({ op: 'pair' });
    await flush();
    x.tick(PAIR_TTL_SHOWN_MS);
    await x.fire(PAIR_TTL_SHOWN_MS);
    expect(x.get().phone).toEqual({ kind: 'expired' });
    expect(JSON.stringify(x.get())).not.toContain('PAIRTEXT');
    await x.fire(PAIR_POLL_MS);
    expect(x.load).not.toHaveBeenCalled();
  });

  it('QR の段を開いたまま新しい QR を頼むと renew つきの loading にし（段を畳まない）、届いたら ready に戻る', async () => {
    const x = phoneRig();
    x.r.run({ op: 'pair' });
    await flush();
    x.tick(PAIR_TTL_SHOWN_MS);
    await x.fire(PAIR_TTL_SHOWN_MS);
    x.r.run({ op: 'pair' });
    expect(x.get().phone).toEqual({ kind: 'loading', renew: true });
    await flush();
    expect(x.get().phone.kind).toBe('ready');
  });

  it('新しい QR を出すと、前の QR の予約は効かなくなる', async () => {
    let n = 0;
    const x = phoneRig({ pair: async () => ({ ...ready, pairText: `T${++n}`, expiresAt: NOW + PAIR_TTL_SHOWN_MS }) });
    x.r.run({ op: 'pair' });
    await flush();
    x.r.run({ op: 'pair' });
    await flush();
    expect(x.get().phone).toMatchObject({ kind: 'ready', pairText: 'T2' });
    // 前の QR の期限の予約が走っても、新しい QR は残る。
    await x.fire(PAIR_TTL_SHOWN_MS);
    expect(x.get().phone).toMatchObject({ kind: 'ready', pairText: 'T2' });
  });

  it('Worker が古い、券の取りすぎ、参加していない、失敗は、それぞれの段にして読み直さない', async () => {
    for (const [answer, stage] of [
      [{ state: 'worker-too-old', compat: 6 }, { kind: 'old', compat: 6 }],
      [{ state: 'rate-limited' }, { kind: 'limited' }],
      [{ state: 'not-joined' }, { kind: 'notJoined' }],
    ] as const) {
      const x = phoneRig({ pair: async () => answer as MobilePairingDto });
      x.r.run({ op: 'pair' });
      await flush();
      expect(x.get().phone).toEqual(stage);
      expect(x.timers).toEqual([]);
    }
    const y = phoneRig({ pair: async () => { throw new Error('接続できません'); } });
    y.r.run({ op: 'pair' });
    await flush();
    expect(y.get().phone).toEqual({ kind: 'failed', message: '接続できません' });
  });
});

const flush = () => new Promise((res) => setTimeout(res, 0));

describe('createCloudMemberRunner', () => {
  it('接続先を確認し、参加コードを半角にそろえて送り、2 秒ごとの問い合わせで承認を待ち、承認されたら再起動を頼む', async () => {
    const joinCheck = vi.fn(async () => ({ ok: true as const, value: check }));
    const joinRequest = vi.fn(async () => ({ ok: true as const, value: { sas: '123456', expiresAt: 300_000 } }));
    const polls: ('waiting' | 'approved')[] = ['waiting', 'approved'];
    const joinPoll = vi.fn(async () => ({ ok: true as const, value: { status: polls.shift()! } }));
    const x = rig({ joinCheck, joinRequest, joinPoll });
    x.r.run({ op: 'check', url: '  https://h.example  ' });
    expect(x.get().join).toEqual({ kind: 'checking', url: 'https://h.example' });
    await flush();
    expect(joinCheck).toHaveBeenCalledWith('https://h.example');
    expect(x.get().join).toEqual({ kind: 'code', check });
    x.r.run({ op: 'request', code: 'ｋ７ｑｍ－２ｘｆｄ' });
    expect(x.get().join).toEqual({ kind: 'requesting', check });
    await flush();
    expect(joinRequest).toHaveBeenCalledWith('https://h.example', 'K7QM2XFD', false);
    expect(x.get().join).toEqual({ kind: 'waiting', check, sas: '123456', expiresAt: 300_000 });
    await x.fire(JOIN_POLL_MS);
    expect(x.get().join.kind).toBe('waiting');
    await x.fire(JOIN_POLL_MS);
    expect(joinPoll).toHaveBeenCalledTimes(2);
    expect(x.get().join).toEqual({ kind: 'done', host: 'h.example' });
    expect(x.timers.map((t) => t.ms)).toEqual([CLOUD_RESTART_MS]);
    x.timers[0]!.fn();
    expect(x.restart).toHaveBeenCalledTimes(1);
  });

  it('形の違う参加コードは殻に渡さず、参加コードの段のまま bad-code にする', async () => {
    const joinRequest = vi.fn(async () => ({ ok: true as const, value: { sas: '123456', expiresAt: 1 } }));
    const x = rig({ joinRequest });
    x.r.run({ op: 'check', url: 'https://h.example' });
    await flush();
    x.r.run({ op: 'request', code: 'K7QM-2XF0' });
    await flush();
    expect(joinRequest).not.toHaveBeenCalled();
    expect(x.get().join).toEqual({ kind: 'failed', reason: 'bad-code', message: '', check });
  });

  it('https で始まらない URL は殻に渡さず、URL の段に理由を出す', async () => {
    const joinCheck = vi.fn(async () => ({ ok: true as const, value: check }));
    const x = rig({ joinCheck });
    x.r.run({ op: 'check', url: 'h.example' });
    await flush();
    expect(joinCheck).not.toHaveBeenCalled();
    expect(x.get().join).toEqual({ kind: 'url', failure: { code: 'invalid-url', message: '' } });
  });

  it('参加済みのクラウドがあれば、上書きで参加をリクエストする', async () => {
    const joinRequest = vi.fn(async () => ({ ok: true as const, value: { sas: '123456', expiresAt: 300_000 } }));
    const x = rig({ joinCheck: async () => ({ ok: true, value: { ...check, current: { url: 'https://o.example' } } }), joinRequest });
    x.r.run({ op: 'check', url: 'https://h.example' });
    await flush();
    x.r.run({ op: 'request', code: 'K7QM-2XFD' });
    await flush();
    expect(joinRequest).toHaveBeenCalledWith('https://h.example', 'K7QM2XFD', true);
  });

  it('殻が busy のときは待ち続け、拒否と期限切れでは問い合わせを停止する', async () => {
    const answers = [{ ok: false as const, failure: { code: 'busy', message: '' } }, { ok: true as const, value: { status: 'rejected' as const } }];
    const x = rig({ joinPoll: async () => answers.shift()! });
    x.r.run({ op: 'check', url: 'https://h.example' });
    await flush();
    x.r.run({ op: 'request', code: 'K7QM2XFD' });
    await flush();
    await x.fire(JOIN_POLL_MS);
    expect(x.get().join.kind).toBe('waiting');
    await x.fire(JOIN_POLL_MS);
    expect(x.get().join).toEqual({ kind: 'failed', reason: 'rejected', message: '', check });
    expect(x.timers).toEqual([]);
    const y = rig({ joinPoll: async () => ({ ok: true, value: { status: 'expired' } }) });
    y.r.run({ op: 'check', url: 'https://h.example' });
    await flush();
    y.r.run({ op: 'request', code: 'K7QM2XFD' });
    await flush();
    await y.fire(JOIN_POLL_MS);
    expect(y.get().join).toEqual({ kind: 'failed', reason: 'no-answer', message: '', check });
  });

  it('5 分たっても承認されなければ「応答なし」で終わる（固まらない）', async () => {
    let now = 0;
    const x = rig({}, { now: () => now });
    x.r.run({ op: 'check', url: 'https://h.example' });
    await flush();
    x.r.run({ op: 'request', code: 'K7QM2XFD' });
    await flush();
    now = 299_000;
    await x.fire(JOIN_POLL_MS);
    expect(x.get().join.kind).toBe('waiting');
    now = 300_000;
    await x.fire(JOIN_POLL_MS);
    expect(x.get().join).toEqual({ kind: 'failed', reason: 'no-answer', message: '', check });
    expect(x.timers).toEqual([]);
  });

  it('期限切れか使用済みの参加コードは expired、通信の失敗は network にする', async () => {
    const x = rig({ joinRequest: async () => ({ ok: false, failure: { code: 'code-not-found', message: '' } }) });
    x.r.run({ op: 'check', url: 'https://h.example' });
    await flush();
    x.r.run({ op: 'request', code: 'K7QM2XFD' });
    await flush();
    expect(x.get().join).toMatchObject({ kind: 'failed', reason: 'expired' });
    const y = rig({ joinRequest: async () => ({ ok: false, failure: { code: 'timeout', message: '' } }) });
    y.r.run({ op: 'check', url: 'https://h.example' });
    await flush();
    y.r.run({ op: 'request', code: 'K7QM2XFD' });
    await flush();
    expect(y.get().join).toMatchObject({ kind: 'failed', reason: 'network' });
  });

  it('待っている間に段を閉じたら、問い合わせの予約は何もしない', async () => {
    const joinPoll = vi.fn(async () => ({ ok: true as const, value: { status: 'waiting' as const } }));
    const x = rig({ joinPoll });
    x.r.run({ op: 'check', url: 'https://h.example' });
    await flush();
    x.r.run({ op: 'request', code: 'K7QM2XFD' });
    await flush();
    x.r.run({ op: 'joinCancel' });
    expect(x.get().join).toEqual({ kind: 'url', failure: null });
    await x.fire(JOIN_POLL_MS);
    expect(joinPoll).not.toHaveBeenCalled();
  });

  it('参加コードは状態に保存しない', async () => {
    const x = rig();
    x.r.run({ op: 'check', url: 'https://h.example' });
    await flush();
    x.r.run({ op: 'request', code: 'K7QM-2XFD' });
    await flush();
    expect(JSON.stringify(x.get())).not.toMatch(/K7QM/);
  });

  it('PC を追加：発行、承認、完了で一覧を取り直し、新しい PC が現れるまで 3 秒ごとに取り直す', async () => {
    const lists: CloudDevicesDto[] = [devices, { ...devices, devices: [{ id: 'pc-b', name: 'pc-b', platform: 'win32', joinedAt: 1, lastSeenAt: 1, revokedAt: null, expiresAt: null, kind: 'pc', self: false }] }];
    const x = rig({}, { load: async () => lists.shift() ?? devices });
    x.r.run({ op: 'addOpen' });
    expect(x.get().add).toEqual({ kind: 'issuing' });
    await flush();
    expect(x.joinCodes.issue).toHaveBeenCalledTimes(1);
    expect(x.get().add).toEqual({ kind: 'open', code: 'K7QM-2XFD', expiresAt: 300_000 });
    // リクエストを受信する前の承認は何もしない。
    x.r.run({ op: 'addApprove' });
    expect(x.joinCodes.approve).not.toHaveBeenCalled();
    x.set({ ...x.get(), add: { kind: 'requested', code: 'K7QM-2XFD', expiresAt: 300_000, request: { name: 'pc-b', os: 'win32', sas: '123456' } } });
    x.r.run({ op: 'addApprove' });
    expect(x.get().add).toEqual({ kind: 'approving' });
    await flush();
    expect(x.get().add).toEqual({ kind: 'done', name: 'pc-b' });
    expect(x.load).toHaveBeenCalledTimes(1);
    await x.fire(PAIR_POLL_MS);
    expect(x.load).toHaveBeenCalledTimes(2);
    expect(x.get().devices!.devices.map((d) => d.id)).toEqual(['pc-b']);
    expect(x.timers).toEqual([]);
  });

  it('PC を追加：発行の失敗はその理由で failed にし、拒否は名前つきの rejected にする。閉じるとコードを閉じる', async () => {
    const joinCodes = fakeJoinCodes({ issue: vi.fn(async () => { throw new Error('参加コードの発行が多すぎます'); }) });
    const x = rig({}, { joinCodes });
    x.r.run({ op: 'addOpen' });
    await flush();
    expect(x.get().add).toEqual({ kind: 'failed', message: '参加コードの発行が多すぎます' });
    x.set({ ...x.get(), add: { kind: 'requested', code: 'K7QM-2XFD', expiresAt: 1, request: { name: 'pc-b', os: 'win32', sas: '123456' } } });
    x.r.run({ op: 'addReject' });
    await flush();
    expect(joinCodes.reject).toHaveBeenCalledTimes(1);
    expect(x.get().add).toEqual({ kind: 'rejected', name: 'pc-b' });
    x.r.run({ op: 'addClose' });
    expect(x.get().add).toEqual({ kind: 'idle' });
    expect(joinCodes.close).toHaveBeenCalledTimes(1);
  });

  it('一覧を取るときに、発行した参加コードの状態も取る', async () => {
    const joinCodes = fakeJoinCodes({ current: vi.fn(async () => ({ kind: 'open' as const, code: 'K7QM-2XFD', expiresAt: 5 })) });
    const x = rig(null, { joinCodes });
    x.r.run({ op: 'load' });
    await flush();
    expect(x.get().add).toEqual({ kind: 'open', code: 'K7QM-2XFD', expiresAt: 5 });
  });

  it('ほかの PC を解除したら、一覧を取り直す。失敗は理由を持つ', async () => {
    const x = rig();
    x.r.run({ op: 'revoke', id: 'b' });
    expect(x.get().revoke).toEqual({ id: 'b', kind: 'busy' });
    await flush();
    expect(x.get().revoke).toEqual({ id: 'b', kind: 'done', name: 'b' });
    expect(x.load).toHaveBeenCalledTimes(1);
    const y = rig({ revoke: async () => ({ ok: false, failure: { code: 'unreachable', message: 'm' } }) });
    y.r.run({ op: 'revoke', id: 'b' });
    await flush();
    expect(y.get().revoke).toEqual({ id: 'b', kind: 'failed', failure: { code: 'unreachable', message: 'm' } });
  });

  it('この PC の参加を解除したら再起動を頼む。クラウドで解除できなかったときは、理由を読めるよう自動では再起動しない', async () => {
    const x = rig();
    x.r.run({ op: 'leave', revoke: true });
    expect(x.get().leave).toEqual({ kind: 'busy' });
    await flush();
    expect(x.get().leave).toEqual({ kind: 'left', revokeError: null });
    expect(x.timers.map((t) => t.ms)).toEqual([CLOUD_RESTART_MS]);
    const y = rig({ leave: async () => ({ ok: true, value: { revoked: false, revokeError: '繋がりません', creator: false } }) });
    y.r.run({ op: 'leave', revoke: true });
    await flush();
    expect(y.get().leave).toEqual({ kind: 'left', revokeError: '繋がりません' });
    expect(y.timers).toEqual([]);
  });

  it('リカバリーキーの再発行：確認を経て作成し、120 秒の表示の期限と下書きを持つ。保存しましたで入力の段に進む', async () => {
    const x = rig(null, { now: () => NOW });
    x.r.run({ op: 'recoveryAsk' });
    expect(x.get().recovery).toEqual({ kind: 'asking' });
    expect(x.recovery.reissue).not.toHaveBeenCalled();
    x.r.run({ op: 'recoveryReissue' });
    expect(x.get().recovery).toEqual({ kind: 'issuing' });
    await flush();
    expect(x.get().recovery).toEqual({ kind: 'shown', text: RECOVERY_TEXT, draftId: 'd1', hideAt: NOW + RECOVERY_SHOW_MS, entering: false, busy: false, sentTail: null, error: null });
    x.r.run({ op: 'recoverySaved' });
    expect(x.get().recovery).toMatchObject({ kind: 'shown', entering: true });
    x.r.run({ op: 'recoveryReveal' });
    expect(x.get().recovery).toMatchObject({ kind: 'shown', entering: false, hideAt: NOW + RECOVERY_SHOW_MS });
  });

  it('リカバリーキーの再発行：完了で confirm に下書きの ID と末尾 4 文字を渡し、済んだら done にして暗号鍵を捨てる', async () => {
    const x = rig(null, { now: () => NOW });
    x.r.run({ op: 'recoveryReissue' });
    await flush();
    x.r.run({ op: 'recoverySaved' });
    x.r.run({ op: 'recoveryConfirm', tail: 'K2VB' });
    expect(x.get().recovery).toMatchObject({ kind: 'shown', busy: true, sentTail: 'K2VB' });
    await flush();
    expect(x.recovery.confirm).toHaveBeenCalledWith('d1', 'K2VB');
    expect(x.get().recovery).toEqual({ kind: 'done' });
  });

  it('リカバリーキーの再発行：Worker の失敗（502）は下書きを残し、もう一度試すで同じ ID と末尾 4 文字を送り直す', async () => {
    const confirm = vi.fn().mockRejectedValueOnce(statusError(502, 'Worker に接続できません')).mockResolvedValueOnce(undefined);
    const x = rig(null, { now: () => NOW, recovery: fakeRecovery({ confirm }) });
    x.r.run({ op: 'recoveryReissue' });
    await flush();
    x.r.run({ op: 'recoverySaved' });
    x.r.run({ op: 'recoveryConfirm', tail: 'K2VB' });
    await flush();
    expect(x.get().recovery).toMatchObject({ kind: 'shown', draftId: 'd1', entering: true, busy: false, sentTail: 'K2VB', error: { message: 'Worker に接続できません', retry: true } });
    x.r.run({ op: 'recoveryRetry' });
    await flush();
    expect(confirm).toHaveBeenNthCalledWith(2, 'd1', 'K2VB');
    expect(x.get().recovery).toEqual({ kind: 'done' });
  });

  it('リカバリーキーの再発行：下書きが無い（409）は下書きを捨てて failed にし、末尾の違い（400）は入力の段のまま理由を出す', async () => {
    const x = rig(null, { now: () => NOW, recovery: fakeRecovery({ confirm: vi.fn(async () => { throw statusError(409, '確認できる新しいリカバリーキーがありません。もう一度再発行してください'); }) }) });
    x.r.run({ op: 'recoveryReissue' });
    await flush();
    x.r.run({ op: 'recoverySaved' });
    x.r.run({ op: 'recoveryConfirm', tail: 'K2VB' });
    await flush();
    expect(x.get().recovery).toEqual({ kind: 'failed', message: '確認できる新しいリカバリーキーがありません。もう一度再発行してください' });
    const y = rig(null, { now: () => NOW, recovery: fakeRecovery({ confirm: vi.fn(async () => { throw statusError(400, '暗号鍵の末尾 4 文字が一致しません'); }) }) });
    y.r.run({ op: 'recoveryReissue' });
    await flush();
    y.r.run({ op: 'recoverySaved' });
    y.r.run({ op: 'recoveryConfirm', tail: 'K2VB' });
    await flush();
    expect(y.get().recovery).toMatchObject({ kind: 'shown', entering: true, busy: false, error: { message: '暗号鍵の末尾 4 文字が一致しません', retry: false } });
  });

  it('リカバリーキーの再発行：作成の失敗は failed。閉じたら暗号鍵を捨て、閉じた後に届いた答えは何もしない', async () => {
    const x = rig(null, { now: () => NOW, recovery: fakeRecovery({ reissue: vi.fn(async () => { throw statusError(502, 'Worker に接続できません'); }) }) });
    x.r.run({ op: 'recoveryReissue' });
    await flush();
    expect(x.get().recovery).toEqual({ kind: 'failed', message: 'Worker に接続できません' });
    const y = rig(null, { now: () => NOW });
    y.r.run({ op: 'recoveryReissue' });
    y.r.run({ op: 'recoveryClose' });
    await flush();
    expect(y.get().recovery).toEqual({ kind: 'idle' });
    y.r.run({ op: 'recoveryReissue' });
    await flush();
    y.r.run({ op: 'recoveryClose' });
    expect(y.get().recovery).toEqual({ kind: 'idle' });
    expect(JSON.stringify(y.get())).not.toContain('K2VB');
  });

  it('一覧を取る。殻が無くても取る（ブラウザでも一覧は見せる）', async () => {
    const x = rig(null);
    x.r.run({ op: 'load' });
    await flush();
    expect(x.get().devices).toEqual(devices);
    x.r.run({ op: 'check', url: 'https://h.example' });
    expect(x.get().join).toEqual({ kind: 'url', failure: null });
  });
});
