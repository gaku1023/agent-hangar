import { describe, expect, it, vi } from 'vitest';
import { initialUpdate, type UpdateState } from '../store/update.ts';
import type { UpdateBridge } from './desktop.ts';
import { UpdateFailure } from './desktop.ts';
import { createUpdateRunner, UPDATE_CHECK_INTERVAL_MS, UPDATE_DISMISSED_KEY, UPDATE_NOTIFY_KEY, UPDATE_PROGRESS_POLL_MS } from './updater.ts';

/** 予約を手で進める時計。 */
function clock() {
  let now = 1_000;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ at: now + ms, fn }); },
    pending: () => timers.length,
    async advance(ms: number) {
      now += ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
        await flush();
      }
    },
  };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function setup(opts: { stored?: Record<string, unknown>; bridge?: Partial<UpdateBridge> } = {}) {
  const c = clock();
  const saved: Record<string, unknown> = { ...opts.stored };
  let state: UpdateState = initialUpdate();
  const bridge: UpdateBridge = {
    status: vi.fn(async () => ({ current: '1.4.2', done: 0, total: null })),
    check: vi.fn(async () => ({ version: '1.5.0' })),
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    ...opts.bridge,
  };
  const runner = createUpdateRunner({
    bridge,
    storage: { get: (k) => saved[k], set: (k, v) => { saved[k] = v; } },
    setTimeout: c.setTimeout, now: c.now,
    get: () => state, set: (s) => { state = s; },
  });
  return { c, saved, bridge, runner, state: () => state };
}

describe('更新の確認の頻度', () => {
  it('起動したら殻の版を読み、すぐ 1 度確認する', async () => {
    const s = setup();
    s.runner.start();
    await flush();
    expect(s.state()).toMatchObject({ supported: true, current: '1.4.2', phase: { kind: 'available', version: '1.5.0' }, checkedAt: 1_000, manual: false });
    expect(s.bridge.check).toHaveBeenCalledTimes(1);
  });

  it('その後は数時間おきに確認する', async () => {
    const s = setup();
    s.runner.start();
    await flush();
    await s.c.advance(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(s.bridge.check).toHaveBeenCalledTimes(1);
    await s.c.advance(1);
    expect(s.bridge.check).toHaveBeenCalledTimes(2);
    await s.c.advance(UPDATE_CHECK_INTERVAL_MS);
    expect(s.bridge.check).toHaveBeenCalledTimes(3);
    expect(UPDATE_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(3 * 3_600_000);
  });

  it('知らせを切っていれば、起動のときも、数時間おきにも確認しない', async () => {
    const s = setup({ stored: { [UPDATE_NOTIFY_KEY]: false } });
    s.runner.start();
    await flush();
    await s.c.advance(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(s.bridge.check).not.toHaveBeenCalled();
    expect(s.state()).toMatchObject({ supported: true, notify: false, phase: { kind: 'unknown' } });
  });

  it('手動の確認は、知らせを切っていても行う', async () => {
    const s = setup({ stored: { [UPDATE_NOTIFY_KEY]: false } });
    s.runner.start();
    await flush();
    s.runner.run({ op: 'check' });
    await flush();
    expect(s.bridge.check).toHaveBeenCalledTimes(1);
    expect(s.state()).toMatchObject({ manual: true, phase: { kind: 'available', version: '1.5.0' } });
  });

  it('殻が版を答えなければ（古い殻、権限で断られた）、updater は無いものとして何もしない', async () => {
    const s = setup({ bridge: { status: vi.fn(async () => { throw new Error('not allowed'); }) } });
    s.runner.start();
    await flush();
    expect(s.state().supported).toBe(false);
    expect(s.bridge.check).not.toHaveBeenCalled();
    s.runner.run({ op: 'check' });
    await flush();
    expect(s.bridge.check).not.toHaveBeenCalled();
  });

  it('確認の失敗は理由を持って失敗にする', async () => {
    const s = setup({ bridge: { check: vi.fn(async () => { throw new UpdateFailure('network'); }) } });
    s.runner.start();
    await flush();
    expect(s.state().phase).toEqual({ kind: 'failed', step: 'check', version: null, reason: 'network' });
  });

  it('取得してからインストールを待つあいだは、数時間おきの確認をしない', async () => {
    const s = setup();
    s.runner.start();
    await flush();
    s.runner.run({ op: 'download' });
    await flush();
    expect(s.state().phase.kind).toBe('ready');
    await s.c.advance(UPDATE_CHECK_INTERVAL_MS);
    expect(s.bridge.check).toHaveBeenCalledTimes(1);
  });
});

describe('取得とインストール', () => {
  it('取得のあいだは進みを読み、終われば準備完了にする', async () => {
    let finish: () => void = () => {};
    const status = vi.fn(async () => ({ current: '1.4.2', done: 0, total: null as number | null }));
    const s = setup({ bridge: { status, download: vi.fn(() => new Promise<void>((r) => { finish = r; })) } });
    s.runner.start();
    await flush();
    s.runner.run({ op: 'download' });
    await flush();
    expect(s.state().phase).toMatchObject({ kind: 'downloading', done: 0 });
    status.mockResolvedValue({ current: '1.4.2', done: 30, total: 60 });
    await s.c.advance(UPDATE_PROGRESS_POLL_MS);
    expect(s.state().phase).toEqual({ kind: 'downloading', version: '1.5.0', done: 30, total: 60 });
    finish();
    await flush();
    expect(s.state().phase).toEqual({ kind: 'ready', version: '1.5.0' });
    // 終わったら進みを読みに行かない。
    const calls = status.mock.calls.length;
    await s.c.advance(UPDATE_PROGRESS_POLL_MS * 3);
    expect(status.mock.calls.length).toBe(calls);
  });

  it('取得の失敗は理由を持って失敗にする', async () => {
    const s = setup({ bridge: { download: vi.fn(async () => { throw new UpdateFailure('signature'); }) } });
    s.runner.start();
    await flush();
    s.runner.run({ op: 'download' });
    await flush();
    expect(s.state().phase).toEqual({ kind: 'failed', step: 'download', version: '1.5.0', reason: 'signature' });
  });

  it('見つけた版が無いときに取得を押しても、殻を呼ばない', async () => {
    const s = setup({ bridge: { check: vi.fn(async () => ({ version: null })) } });
    s.runner.start();
    await flush();
    s.runner.run({ op: 'download' });
    s.runner.run({ op: 'install' });
    await flush();
    expect(s.bridge.download).not.toHaveBeenCalled();
    expect(s.bridge.install).not.toHaveBeenCalled();
  });

  it('準備ができてから再起動して更新を押すと、殻にインストールを頼む。失敗は失敗にする', async () => {
    const s = setup({ bridge: { install: vi.fn(async () => { throw new UpdateFailure('permission'); }) } });
    s.runner.start();
    await flush();
    s.runner.run({ op: 'download' });
    await flush();
    s.runner.run({ op: 'install' });
    expect(s.state().phase.kind).toBe('installing');
    await flush();
    expect(s.bridge.install).toHaveBeenCalledTimes(1);
    expect(s.state().phase).toEqual({ kind: 'failed', step: 'install', version: '1.5.0', reason: 'permission' });
  });
});

describe('閉じた版と知らせのスイッチ', () => {
  it('閉じた版を覚え、開き直しても読み戻す', async () => {
    const s = setup();
    s.runner.start();
    await flush();
    s.runner.run({ op: 'dismiss' });
    expect(s.saved[UPDATE_DISMISSED_KEY]).toBe('1.5.0');
    const again = setup({ stored: s.saved });
    again.runner.start();
    await flush();
    expect(again.state().dismissed).toBe('1.5.0');
  });

  it('スイッチを覚える。入れ直したら、その場で 1 度確認する', async () => {
    const s = setup({ stored: { [UPDATE_NOTIFY_KEY]: false } });
    s.runner.start();
    await flush();
    s.runner.run({ op: 'notify', on: true });
    await flush();
    expect(s.saved[UPDATE_NOTIFY_KEY]).toBe(true);
    expect(s.bridge.check).toHaveBeenCalledTimes(1);
    expect(s.state().manual).toBe(false);
    s.runner.run({ op: 'notify', on: false });
    expect(s.saved[UPDATE_NOTIFY_KEY]).toBe(false);
  });
});
