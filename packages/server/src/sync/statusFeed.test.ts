import type { SyncStatusDto } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import type { NoticeEvent } from '../events/publisher.ts';
import { createSyncFeed } from './statusFeed.ts';

const status = (state: string): SyncStatusDto => ({ state, pending: 0, error: null } as unknown as SyncStatusDto);

function setup(o: { paused?: boolean; oncePass?: boolean; withParts?: boolean } = {}) {
  const sent: NoticeEvent[] = [];
  const calls: string[] = [];
  const toasts: string[] = [];
  let paused = o.paused ?? false;
  let sweep = 3;
  let skipped = [{ key: 'k', attempts: 2, message: 'm' }];
  const feed = createSyncFeed({
    hub: { broadcast: (ev) => { sent.push(ev); } },
    puller: o.withParts === false ? null : { skippedEntries: () => skipped, pullNow: async () => { calls.push('pull'); } },
    uploader: o.withParts === false ? null : { pendingSweep: () => sweep },
    oncePass: () => o.oncePass ?? false,
    isPaused: () => paused,
    cloudUsage: { refresh: async () => { calls.push('usage'); } },
    toast: (_l, m) => { toasts.push(m); },
    log: () => {},
  });
  return { feed, sent, calls, toasts, setPaused: (v: boolean) => { paused = v; }, setSweep: (n: number) => { sweep = n; }, clearSkipped: () => { skipped = []; } };
}

describe('同期の状態の配り', () => {
  it('websocket の sync.status が付録を運び、件数が減れば画面にも届く', () => {
    // 付録を運ぶのが HTTP だけだと、サーバの取り残しが 0 になっても画面は 3 のまま固まる。
    // 諦めた本文の赤い行も、回復したあと消えなくなる。
    const t = setup();
    const l = t.feed.listener();
    l.status!(status('idle'));
    expect(t.sent[0]).toMatchObject({ type: 'sync.status', status: { state: 'idle', sweepPending: 3, skipped: [{ key: 'k' }], oncePass: false } });
    t.setSweep(0);
    t.clearSkipped();
    l.status!(status('idle'));
    expect(t.sent[1]).toMatchObject({ type: 'sync.status', status: { sweepPending: 0, skipped: [] } });
  });

  it('同期を設定していない端末では、諦めた項目は空で、取り残しは数えられない（null）', () => {
    const t = setup({ withParts: false });
    expect(t.feed.skipped()).toEqual([]);
    expect(t.feed.sweep()).toBeNull();
    // 降ろし手が無くても、頼むだけなら落ちない。
    t.feed.pullFiles();
  });

  it('一時停止が解けたら使用量を取り直す。止まったままや、動いたままでは取り直さない', () => {
    const t = setup({ paused: true });
    const l = t.feed.listener();
    l.status!(status('paused'));
    expect(t.calls).toEqual([]);
    l.status!(status('idle'));
    expect(t.calls).toEqual(['usage']);
    l.status!(status('idle'));
    expect(t.calls).toEqual(['usage']);
  });

  it('メタデータの pull の後に、ファイルの新着を取りに行く。一時停止のあいだは行かない', () => {
    const t = setup();
    const l = t.feed.listener();
    l.pulled!();
    expect(t.calls).toEqual(['pull']);
    t.setPaused(true);
    l.pulled!();
    expect(t.calls).toEqual(['pull']);
  });

  it('頼まれた 1 巡の最中は、その巡が自分で降ろすので、pull の合図では降ろしに行かない', () => {
    const t = setup({ oncePass: true });
    t.feed.listener().pulled!();
    expect(t.calls).toEqual([]);
    expect(t.feed.oncePass()).toBe(true);
  });

  it('エンジンの知らせはトーストへ流す', () => {
    const t = setup();
    t.feed.listener().toast!('error', '同期できませんでした');
    expect(t.toasts).toEqual(['同期できませんでした']);
  });
});
