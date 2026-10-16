import { PEER_STALE_MS } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { openInbox } from './inbox.ts';
import { feedOf, inboxOf, liveItem, makeKey, MIN, NOW } from './test/fixtures.ts';

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
    const v = await openInbox(res, key, now);
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
    const v = await openInbox(res, key, now);
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

  it('一度も見ていない PC（lastSeenAt が null）も unknown', async () => {
    const key = await makeKey();
    const res = await inboxOf(key, [feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting' })] })], { lastSeen: { 'pc-1': null } });
    const v = await openInbox(res, key, now);
    expect(v.waiting).toEqual([]);
    expect(v.running.map((r) => r.status)).toEqual(['unknown']);
    expect(v.devices[0]!.alive).toBe(false);
  });

  it('開けない PC は unreadable に入り、ほかの PC の行は出る', async () => {
    const key = await makeKey();
    const res = await inboxOf(
      key,
      [feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'waiting' })] }), feedOf('pc-2', 'Mac 2', { live: [liveItem({ sessionId: 's-2', status: 'waiting' })] })],
      { otherKeyFor: ['pc-1'] },
    );
    const v = await openInbox(res, key, now);
    expect(v.unreadable).toEqual(['Mac']);
    expect(v.waiting.map((r) => r.sessionId)).toEqual(['s-2']);
  });

  it('壊れた封じや、宛先の違う feed も unreadable にする', async () => {
    const key = await makeKey();
    const res = await inboxOf(key, [feedOf('pc-1', 'Mac'), feedOf('pc-2', 'Mac 2')]);
    res.feeds[0]!.sealed = 'not-sealed';
    res.feeds[1]!.deviceId = 'pc-1';
    const v = await openInbox(res, key, now);
    expect(v.unreadable).toEqual(['Mac', 'Mac']);
  });

  it('今日戻るは returnOn が今日のものだけ', async () => {
    const key = await makeKey();
    const res = await inboxOf(key, [
      feedOf('pc-1', 'Mac', {
        returns: [
          { sessionId: 'r-yesterday', projectName: 'project-a', title: '会話 1', accountId: 'acc-1', returnOn: '2026-10-16', returnTime: null },
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
    const v = await openInbox(res, key, now);
    expect(v.returning.map((r) => r.sessionId)).toEqual(['r-early', 'r-late']);
    expect(v.returning[0]!.returnTime).toBe('09:30');
    expect(v.doneToday.map((r) => r.sessionId)).toEqual(['d-today']);
    expect(v.doneToday[0]!.oneLiner).toBe('片付けた');
  });

  it('同じ会話が 2 つの PC から来たら live の方', async () => {
    const key = await makeKey();
    const res = await inboxOf(key, [
      feedOf('pc-1', 'Mac', { done: [{ sessionId: 's-1', projectName: 'project-a', title: '会話 1', oneLiner: null, doneAt: NOW - MIN }] }),
      feedOf('pc-2', 'Mac 2', { live: [liveItem({ sessionId: 's-1', status: 'busy', statusAt: NOW - 60 * MIN })] }),
    ]);
    const v = await openInbox(res, key, now);
    expect(v.doneToday).toEqual([]);
    expect(v.running.map((r) => [r.sessionId, r.deviceName])).toEqual([['s-1', 'Mac 2']]);
  });

  it('同じ会話の live が 2 つなら新しい時刻の方', async () => {
    const key = await makeKey();
    const res = await inboxOf(key, [
      feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', status: 'busy', statusAt: NOW - 60 * MIN })] }),
      feedOf('pc-2', 'Mac 2', { live: [liveItem({ sessionId: 's-1', status: 'waiting', statusAt: NOW - 2 * MIN })] }),
    ]);
    const v = await openInbox(res, key, now);
    expect(v.running).toEqual([]);
    expect(v.waiting.map((r) => [r.sessionId, r.deviceName])).toEqual([['s-1', 'Mac 2']]);
  });

  it('アカウントの色と名前を行に載せ、色の形が違えば null にする', async () => {
    const key = await makeKey();
    const f = feedOf('pc-1', 'Mac', { live: [liveItem({ sessionId: 's-1', accountId: 'acc-1' }), liveItem({ sessionId: 's-2', accountId: 'acc-2' })] });
    f.accounts.push({ id: 'acc-2', name: 'アカウント 2', color: 'url(https://example.com/x)', fiveHour: null, sevenDay: null });
    const v = await openInbox(await inboxOf(key, [f]), key, now);
    const byId = Object.fromEntries(v.running.map((r) => [r.sessionId, r]));
    expect(byId['s-1']!.accountColor).toBe('#4a63e8');
    expect(byId['s-2']!.accountColor).toBeNull();
    expect(byId['s-2']!.accountName).toBe('アカウント 2');
  });

  it('開けた feed を feeds に残す（新しい会話の画面が使う）', async () => {
    const key = await makeKey();
    const v = await openInbox(await inboxOf(key, [feedOf('pc-1', 'Mac')]), key, now);
    expect(v.feeds.map((f) => f.deviceId)).toEqual(['pc-1']);
  });
});
