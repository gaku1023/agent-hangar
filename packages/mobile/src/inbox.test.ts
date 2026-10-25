import { COMPAT_HEADER, PEER_STALE_MS } from '@agent-hangar/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchInbox } from './api.ts';
import { FEED_HIDE_AFTER_MS, openInbox, readInbox } from './inbox.ts';
import { feedOf, inboxOf, liveItem, makeKey, MIN, NOW, ring } from './test/fixtures.ts';
import { json, WORKER } from './test/pairText.ts';

const now = new Date(NOW);

describe('openInbox', () => {
  it('waiting は statusAt の古い順（長く待っているものが上）', async () => {
    const key = await makeKey();
    const res = await inboxOf(key, [
      feedOf('pc-1', 'Mac', {
        live: [
          liveItem({ sessionId: 's-new', status: 'waiting', statusAt: NOW - 5 * MIN, waiting: { kind: 'question', text: '質問 1' } }),
          liveItem({ sessionId: 's-old', status: 'waiting', statusAt: NOW - 90 * MIN, waiting: { kind: 'permission', text: 'Bash: ls' } }),
          liveItem({ sessionId: 's-busy', status: 'busy' }),
        ],
      }),
      feedOf('pc-2', 'Mac 2', { live: [liveItem({ sessionId: 's-mid', status: 'waiting', statusAt: NOW - 30 * MIN })] }),
    ]);
    const v = await openInbox(res, ring(key), now);
    expect(v.waiting.map((r) => r.sessionId)).toEqual(['s-old', 's-mid', 's-new']);
    expect(v.waiting[0]!.deviceName).toBe('Mac');
    expect(v.waiting[1]!.deviceName).toBe('Mac 2');
    expect(v.running.map((r) => r.sessionId)).toEqual(['s-busy']);
    expect(v.unreadable).toEqual([]);
  });

  it('3 分見ていない PC の会話は unknown で running の末尾、waiting に出ない', async () => {
    const key = await makeKey();
    const res = await inboxOf(
      key,
      [
        feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-stale-wait', status: 'waiting', statusAt: NOW - 90 * MIN }), liveItem({ sessionId: 's-stale-busy', status: 'busy', startedAt: NOW - 200 * MIN })] }),
        feedOf('pc-2', 'Mac 2', { live: [liveItem({ sessionId: 's-fresh', status: 'busy', startedAt: NOW - 5 * MIN })] }),
      ],
      { lastSeen: { 'pc-1': NOW - PEER_STALE_MS - 1 } },
    );
    const v = await openInbox(res, ring(key), now);
    expect(v.waiting).toEqual([]);
    expect(v.running.map((r) => [r.sessionId, r.status])).toEqual([
      ['s-fresh', 'busy'],
      ['s-stale-busy', 'unknown'],
      ['s-stale-wait', 'unknown'],
    ]);
    expect(v.devices).toEqual([
      { id: 'pc-1', name: 'Mac', lastSeenAt: NOW - PEER_STALE_MS - 1, alive: false },
      { id: 'pc-2', name: 'Mac 2', lastSeenAt: NOW - MIN, alive: true },
    ]);
  });

  it('PC の名前は封じた feed から取る（Worker の name は PC の ID なので使わない）', async () => {
    const key = await makeKey();
    const mac = '3f9c2a1b-7d4e-4c1a-9b2f-0e6d5c4b3a21';
    const blank = 'a1b2c3d4-0000-4000-8000-000000000001';
    const locked = 'c0ffee00-1111-4111-8111-111111111111';
    const silent = 'deadbeef-2222-4222-8222-222222222222';
    const res = await inboxOf(
      key,
      [
        feedOf(mac, 'MacBook Pro', { live: [liveItem({ sessionId: 's-1', status: 'busy' })] }),
        feedOf(blank, '  ', { live: [liveItem({ sessionId: 's-2', status: 'waiting' })] }),
        feedOf(locked, 'Locked'),
      ],
      { otherKeyFor: [locked] },
    );
    // 素を置いていない PC（生存の行だけに出る）。
    res.devices.push({ id: silent, name: silent, platform: '', lastSeenAt: NOW - MIN });
    const v = await openInbox(res, ring(key), now);
    expect(v.running.map((r) => r.deviceName)).toEqual(['MacBook Pro']);
    // 名前が空なら、ID をそのまま出さず短い代わりの表記にする。
    expect(v.waiting.map((r) => r.deviceName)).toEqual(['PC a1b2']);
    expect(v.unreadable).toEqual(['PC c0ff']);
    expect(v.devices.map((d) => [d.id, d.name])).toEqual([
      [mac, 'MacBook Pro'],
      [blank, 'PC a1b2'],
      [locked, 'PC c0ff'],
      [silent, 'PC dead'],
    ]);
  });

  it('ちょうど 180,000 ms 前に見た PC はまだ生きている、1 ms 過ぎたら unknown', async () => {
    const key = await makeKey();
    const feeds = [feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting' })] })];
    const edge = await openInbox(await inboxOf(key, feeds, { lastSeen: { 'pc-1': NOW - 180_000 } }), ring(key), now);
    expect(edge.devices[0]!.alive).toBe(true);
    expect(edge.waiting.map((r) => r.sessionId)).toEqual(['s-1']);
    const past = await openInbox(await inboxOf(key, feeds, { lastSeen: { 'pc-1': NOW - 180_001 } }), ring(key), now);
    expect(past.devices[0]!.alive).toBe(false);
    expect(past.running.map((r) => r.status)).toEqual(['unknown']);
  });

  it('時計の差は res.now（Worker）から測る', async () => {
    const key = await makeKey();
    const ahead = await openInbox(await inboxOf(key, [feedOf('pc-1', 'Mac')], { now: NOW + 2 * 60 * MIN }), ring(key), now);
    expect(ahead.skewMs).toBe(2 * 60 * MIN);
    const res = await inboxOf(key, [feedOf('pc-1', 'Mac')]);
    const noNow = await openInbox({ ...res, now: undefined as unknown as number }, ring(key), now);
    expect(noNow.skewMs).toBe(0);
  });

  it('一度も見ていない PC（lastSeenAt が null）も unknown', async () => {
    const key = await makeKey();
    const res = await inboxOf(key, [feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting' })] })], { lastSeen: { 'pc-1': null } });
    const v = await openInbox(res, ring(key), now);
    expect(v.waiting).toEqual([]);
    expect(v.running.map((r) => r.status)).toEqual(['unknown']);
    expect(v.devices[0]!.alive).toBe(false);
  });

  it('更新が 7 日より古い feed（解除せずに去った PC）は出さない。ちょうど 7 日はまだ出す', async () => {
    const key = await makeKey();
    const res = await inboxOf(
      key,
      [
        feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting' })] }),
        feedOf('pc-2', 'Mac 2', { live: [liveItem({ sessionId: 's-2', status: 'waiting' })] }),
        feedOf('pc-3', 'Mac 3', { live: [liveItem({ sessionId: 's-3', status: 'waiting' })] }),
      ],
      { updatedAt: { 'pc-1': NOW - FEED_HIDE_AFTER_MS - 1, 'pc-2': NOW - FEED_HIDE_AFTER_MS }, otherKeyFor: ['pc-1'], lastSeen: { 'pc-1': NOW - FEED_HIDE_AFTER_MS - 1 } },
    );
    const v = await openInbox(res, ring(key), now);
    expect(FEED_HIDE_AFTER_MS).toBe(7 * 24 * 60 * 60_000);
    expect(v.feeds.map((f) => f.deviceId)).toEqual(['pc-2', 'pc-3']);
    expect([...v.waiting, ...v.running].map((r) => r.sessionId).sort()).toEqual(['s-2', 's-3']);
    // 開けない封じでも、古ければ「開けない」とは言わない。
    expect(v.unreadable).toEqual([]);
    // 7 日より前に最後に見た PC は、生存の行にも出さない（「不明」のまま残さない）。
    expect(v.devices.map((d) => d.id)).toEqual(['pc-2', 'pc-3']);
  });

  it('開けない PC は unreadable に入り、ほかの PC の行は出る', async () => {
    const key = await makeKey();
    const res = await inboxOf(
      key,
      [feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting' })] }), feedOf('pc-2', 'Mac 2', { live: [liveItem({ sessionId: 's-2', status: 'waiting' })] })],
      { otherKeyFor: ['pc-1'] },
    );
    const v = await openInbox(res, ring(key), now);
    expect(v.unreadable).toEqual(['PC pc-1']);
    expect(v.waiting.map((r) => r.sessionId)).toEqual(['s-2']);
  });

  it('壊れた封じや、宛先の違う feed も unreadable にする', async () => {
    const key = await makeKey();
    const res = await inboxOf(key, [feedOf('pc-1', 'Mac'), feedOf('pc-2', 'Mac 2')]);
    res.feeds[0]!.sealed = 'not-sealed';
    res.feeds[1]!.deviceId = 'pc-1';
    const v = await openInbox(res, ring(key), now);
    expect(v.unreadable).toEqual(['PC pc-1', 'PC pc-1']);
  });

  it('今日戻るは returnOn が今日か過ぎた日のもの。過ぎたものが先、明日以降と日付の無いものは出ない', async () => {
    const key = await makeKey();
    const res = await inboxOf(key, [
      feedOf('pc-1', 'Mac', {
        returns: [
          { sessionId: 'r-yesterday', projectName: 'project-a', title: '会話 1', accountId: 'acc-1', returnOn: '2026-10-16', returnTime: null },
          { sessionId: 'r-blank', projectName: 'project-a', title: '会話 7', accountId: 'acc-1', returnOn: '', returnTime: null },
          { sessionId: 'r-week', projectName: 'project-a', title: '会話 8', accountId: 'acc-1', returnOn: '2026-10-10', returnTime: '20:00' },
          { sessionId: 'r-late', projectName: 'project-a', title: '会話 2', accountId: 'acc-1', returnOn: '2026-10-17', returnTime: '18:00' },
          { sessionId: 'r-early', projectName: 'project-a', title: '会話 3', accountId: 'acc-1', returnOn: '2026-10-17', returnTime: '09:30' },
          { sessionId: 'r-tomorrow', projectName: 'project-a', title: '会話 4', accountId: 'acc-1', returnOn: '2026-10-18', returnTime: null },
        ],
        done: [
          { sessionId: 'd-today', projectName: 'project-a', title: '会話 5', oneLiner: '片付けた', doneAt: new Date(2026, 9, 17, 9, 0).getTime() },
          { sessionId: 'd-yesterday', projectName: 'project-a', title: '会話 6', oneLiner: null, doneAt: new Date(2026, 9, 16, 23, 59).getTime() },
        ],
      }),
    ]);
    const v = await openInbox(res, ring(key), now);
    expect(v.returning.map((r) => r.sessionId)).toEqual(['r-week', 'r-yesterday', 'r-early', 'r-late']);
    expect(v.returning[0]!.returnOn).toBe('2026-10-10');
    expect(v.returning[2]!.returnTime).toBe('09:30');
    expect(v.doneToday.map((r) => r.sessionId)).toEqual(['d-today']);
    expect(v.doneToday[0]!.oneLiner).toBe('片付けた');
  });

  it('同じ会話が 2 つの PC から来たら live の方', async () => {
    const key = await makeKey();
    const res = await inboxOf(key, [
      feedOf('pc-1', 'Mac', { done: [{ sessionId: 's-1', projectName: 'project-a', title: '会話 1', oneLiner: null, doneAt: NOW - MIN }] }),
      feedOf('pc-2', 'Mac 2', { live: [liveItem({ sessionId: 's-1', status: 'busy', statusAt: NOW - 60 * MIN })] }),
    ]);
    const v = await openInbox(res, ring(key), now);
    expect(v.doneToday).toEqual([]);
    expect(v.running.map((r) => [r.sessionId, r.deviceName])).toEqual([['s-1', 'Mac 2']]);
  });

  it('同じ会話の live が 2 つなら新しい時刻の方', async () => {
    const key = await makeKey();
    const res = await inboxOf(key, [
      feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'busy', statusAt: NOW - 60 * MIN })] }),
      feedOf('pc-2', 'Mac 2', { live: [liveItem({ sessionId: 's-1', status: 'waiting', statusAt: NOW - 2 * MIN })] }),
    ]);
    const v = await openInbox(res, ring(key), now);
    expect(v.running).toEqual([]);
    expect(v.waiting.map((r) => [r.sessionId, r.deviceName])).toEqual([['s-1', 'Mac 2']]);
  });

  it('アカウントの色と名前を行に載せ、色の形が違えば null にする', async () => {
    const key = await makeKey();
    const f = feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', accountId: 'acc-1' }), liveItem({ sessionId: 's-2', accountId: 'acc-2' })] });
    f.accounts.push({ id: 'acc-2', name: 'アカウント 2', color: 'url(https://example.com/x)', fiveHour: null, sevenDay: null });
    const v = await openInbox(await inboxOf(key, [f]), ring(key), now);
    const byId = Object.fromEntries(v.running.map((r) => [r.sessionId, r]));
    expect(byId['s-1']!.accountColor).toBe('#4a63e8');
    expect(byId['s-2']!.accountColor).toBeNull();
    expect(byId['s-2']!.accountName).toBe('アカウント 2');
  });

  it('開けた feed を feeds に残す（新しい会話の画面が使う）', async () => {
    const key = await makeKey();
    const v = await openInbox(await inboxOf(key, [feedOf('pc-1', 'Mac')]), ring(key), now);
    expect(v.feeds.map((f) => f.deviceId)).toEqual(['pc-1']);
  });

  it('受信箱の応答の見出しから Worker の版を読み、workerCompat に持つ（見出しが無ければ null）', async () => {
    const key = await makeKey();
    const res = await inboxOf(key, [feedOf('pc-1', 'Mac')]);
    const fetchMock = vi.fn(async () => {
      const r = json(res);
      r.headers.set(COMPAT_HEADER, '7');
      return r;
    });
    vi.stubGlobal('fetch', fetchMock);
    const got = await fetchInbox({ url: WORKER, token: 't', deviceId: 'phone-1' });
    expect(got.workerCompat).toBe(7);
    expect((await openInbox(got, ring(key), now)).workerCompat).toBe(7);
    fetchMock.mockImplementation(async () => json(res));
    expect((await fetchInbox({ url: WORKER, token: 't', deviceId: 'phone-1' })).workerCompat).toBeNull();
    expect((await openInbox(res, ring(key), now)).workerCompat).toBeNull();
  });
});

describe('opencode の行（F1）', () => {
  it('行に agent と使用量を載せる。agent の無い行（Claude）は agent が null で使用量も無い', async () => {
    const key = await makeKey();
    const res = await inboxOf(key, [
      feedOf('pc-1', 'Mac', {
        live: [
          liveItem({ sessionId: 's-claude', status: 'busy' }),
          liveItem({ sessionId: 's-oc', status: 'busy', agent: 'opencode', usage: { ctx: 34, tokens: 13_600, cost: 0, model: 'opencode/big-pickle' } }),
        ],
        done: [{ sessionId: 'd-oc', projectName: 'project-a', title: '終わった', oneLiner: null, doneAt: NOW - MIN, agent: 'opencode' }],
        returns: [{ sessionId: 'r-oc', projectName: 'project-a', title: '戻る', accountId: 'acc-1', returnOn: '2026-10-17', returnTime: null, agent: 'opencode' }],
      }),
    ]);
    const v = await openInbox(res, ring(key), now);
    const by = Object.fromEntries([...v.running, ...v.doneToday, ...v.returning].map((r) => [r.sessionId, r]));
    expect(by['s-claude']).toMatchObject({ agent: null, usage: null });
    expect(by['s-oc']).toMatchObject({ agent: 'opencode', usage: { ctx: 34, tokens: 13_600, cost: 0 } });
    expect(by['d-oc']!.agent).toBe('opencode');
    expect(by['r-oc']!.agent).toBe('opencode');
  });

  it('形の違う使用量は捨てる（PC から来た値も信じない）。ctx は 0〜100 に収める', async () => {
    const key = await makeKey();
    const bad = (sessionId: string, usage: unknown) => liveItem({ sessionId, agent: 'opencode', usage: usage as never });
    const res = await inboxOf(key, [
      feedOf('pc-1', 'Mac', {
        live: [
          bad('s-str', { ctx: '34', tokens: 1, cost: 0, model: 'm' }),
          bad('s-notokens', { ctx: 34, tokens: null, cost: 0, model: 'm' }),
          bad('s-over', { ctx: 250, tokens: 5, cost: 'x', model: 3 }),
          bad('s-null', null),
        ],
      }),
    ]);
    const v = await openInbox(res, ring(key), now);
    const by = Object.fromEntries(v.running.map((r) => [r.sessionId, r.usage]));
    expect(by['s-str']).toEqual({ ctx: null, tokens: 1, cost: 0, model: 'm' });
    expect(by['s-notokens']).toBeNull();
    expect(by['s-over']).toEqual({ ctx: 100, tokens: 5, cost: null, model: '' });
    expect(by['s-null']).toBeNull();
  });

  it('絵は、opencode を有効にした PC（caps.agents に opencode）か opencode の行があるときだけ出す', async () => {
    const key = await makeKey();
    const open = async (feeds: Parameters<typeof inboxOf>[1]) => openInbox(await inboxOf(key, feeds), ring(key), now);
    const plain = await open([feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1' })] })]);
    expect(plain.agentIcons).toBe(false);
    const enabled = await open([feedOf('pc-1', 'Mac', { caps: { asks: true, images: true, effort: true, agents: ['claude-code', 'opencode'] } })]);
    expect(enabled.agentIcons).toBe(true);
    const hasRow = await open([feedOf('pc-1', 'Mac', { done: [{ sessionId: 'd-1', projectName: 'p', title: 't', oneLiner: null, doneAt: NOW - MIN, agent: 'opencode' }] })]);
    expect(hasRow.agentIcons).toBe(true);
  });
});

describe('スマホ用の鍵の世代', () => {
  const pairing = { url: WORKER, token: 't', deviceId: 'phone-1' };

  it('素はその世代の鍵で開き、手元に無い世代の素は開けない PC に入れる', async () => {
    const k1 = await makeKey();
    const k2 = await makeKey();
    const r1 = await inboxOf(k1, [feedOf('pc-1', 'Mac')], { epoch: 1 });
    const r2 = await inboxOf(k2, [feedOf('pc-2', 'Mac 2')], { epoch: 2 });
    const r3 = await inboxOf(k2, [feedOf('pc-3', 'Mac 3')], { epoch: 3 });
    const res = { ...r1, devices: [...r1.devices, ...r2.devices, ...r3.devices], feeds: [...r1.feeds, ...r2.feeds, ...r3.feeds] };
    const v = await openInbox(res, new Map([[1, k1], [2, k2]]), now);
    expect(v.feeds.map((f) => f.deviceId)).toEqual(['pc-1', 'pc-2']);
    expect(v.unreadable).toEqual(['PC pc-3']);
  });

  it('受信箱の素の世代が手元より新しいと keybox を読み直し、読み直した鍵で開く', async () => {
    const k1 = await makeKey();
    const k2 = await makeKey();
    vi.stubGlobal('fetch', vi.fn(async () => json(await inboxOf(k2, [feedOf('pc-1', 'Mac')], { epoch: 2 }))));
    const reloadKeys = vi.fn(async () => new Map([[1, k1], [2, k2]]));
    const got = await readInbox(pairing, new Map([[1, k1]]), { reloadKeys, now });
    expect(reloadKeys).toHaveBeenCalledTimes(1);
    expect(got.view.feeds.map((f) => f.deviceId)).toEqual(['pc-1']);
    expect(got.view.unreadable).toEqual([]);
    expect([...got.keys.keys()]).toEqual([1, 2]);
  });

  it('手元の世代と同じか古い素なら keybox を読まない', async () => {
    const k2 = await makeKey();
    const k1 = await makeKey();
    vi.stubGlobal('fetch', vi.fn(async () => json(await inboxOf(k1, [feedOf('pc-1', 'Mac')], { epoch: 1 }))));
    const reloadKeys = vi.fn(async () => new Map<number, CryptoKey>());
    const got = await readInbox(pairing, new Map([[1, k1], [2, k2]]), { reloadKeys, now });
    expect(reloadKeys).not.toHaveBeenCalled();
    expect(got.view.feeds.map((f) => f.deviceId)).toEqual(['pc-1']);
  });

  it('読み直しても新しい世代が無ければ、その素は開けない PC に入れて続ける', async () => {
    const k1 = await makeKey();
    const k2 = await makeKey();
    const a = await inboxOf(k1, [feedOf('pc-1', 'Mac')], { epoch: 1 });
    const b = await inboxOf(k2, [feedOf('pc-2', 'Mac 2')], { epoch: 2 });
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...a, devices: [...a.devices, ...b.devices], feeds: [...a.feeds, ...b.feeds] })));
    const ring = new Map([[1, k1]]);
    const got = await readInbox(pairing, ring, { reloadKeys: async () => ring, now });
    expect(got.view.feeds.map((f) => f.deviceId)).toEqual(['pc-1']);
    expect(got.view.unreadable).toEqual(['PC pc-2']);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
