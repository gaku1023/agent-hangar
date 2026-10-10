import type { SyncStatusDto } from '@agent-hangar/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createOncePass, type OncePassDeps } from './oncePass.ts';

/** 利用者が止めた印と、版と上限の止まりを持つだけの立て替えのエンジン。 */
function setup(o: { paused: boolean; compatBlocked?: boolean; limited?: boolean; pending?: number; sweepPending?: number | null; metadata?: () => Promise<void>; haltedDuringPass?: boolean; failing?: string[]; noBundle?: boolean } = { paused: true }) {
  const calls: string[] = [];
  const toasts: { level: string; message: string }[] = [];
  const sent: SyncStatusDto[] = [];
  const status = { state: 'paused', pending: o.pending ?? 0, error: o.compatBlocked ? 'この PC の hangar を上げてください' : null } as unknown as SyncStatusDto;
  const step = (name: string) => async (): Promise<void> => {
    calls.push(name);
    if (o.failing?.includes(name)) throw new Error(`${name} failed`);
  };
  const deps: OncePassDeps = {
    engine: {
      syncNow: async (a) => { calls.push(a?.evenIfPaused ? 'metadata(evenIfPaused)' : 'metadata'); await o.metadata?.(); },
      status: () => status,
      compatBlocked: () => o.compatBlocked ?? false,
      limitedUntil: () => (o.limited ? 123 : null),
      state: { get: () => (o.paused ? '1' : null) },
    },
    puller: { pullNow: step('files') },
    configBundle: o.noBundle ? null : { tick: step('config') },
    uploader: { sweep: (limit) => { calls.push(`sweep(${limit})`); }, idle: step('upload.idle') },
    cloudUsage: { refresh: step('usage') },
    isPaused: () => o.haltedDuringPass ?? false,
    sweepPending: () => (o.sweepPending === undefined ? 0 : o.sweepPending),
    broadcastSync: (s) => { sent.push(s); },
    toast: (level, message) => { toasts.push({ level, message }); },
    language: () => 'ja',
    tickMs: 5,
    log: () => {},
  };
  const once = createOncePass(deps);
  return { once, calls, toasts, sent };
}

describe('今すぐ同期', () => {
  let stop: (() => void) | null = null;
  afterEach(() => { stop?.(); stop = null; });

  it('利用者が止めていなければ、エンジンに頼むだけで 1 巡の道に回らない', async () => {
    const t = setup({ paused: false });
    stop = t.once.stopTicker;
    await t.once.syncNow();
    expect(t.calls).toEqual(['metadata']);
    expect(t.once.pass.active()).toBe(false);
    expect(t.toasts).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it('止めていれば、メタデータ、本文の降ろし、設定、本文の上げきり、使用量の順に 1 巡だけ回し、停止のままだと知らせる', async () => {
    const t = setup({ paused: true });
    stop = t.once.stopTicker;
    const done = t.once.syncNow();
    // 押した直後に 1 度配る。応答はメタデータの後なので、待たせるとボタンが効いていないように見える。
    expect(t.once.pass.active()).toBe(true);
    expect(t.sent.length).toBe(1);
    await done;
    await t.once.pass.idle();
    // 本文は走査の上限を外して上げきる。
    expect(t.calls).toEqual(['metadata(evenIfPaused)', 'files', 'config', 'sweep(Infinity)', 'upload.idle', 'usage']);
    expect(t.once.pass.active()).toBe(false);
    expect(t.toasts).toEqual([{ level: 'info', message: '1 回だけ同期しました。同期は一時停止のままです' }]);
  });

  it('1 巡の最中は進みを配り続け、終われば止める', async () => {
    let release = (): void => {};
    const t = setup({ paused: true, metadata: () => new Promise<void>((r) => { release = r; }) });
    stop = t.once.stopTicker;
    const done = t.once.syncNow();
    await new Promise((r) => setTimeout(r, 40));
    const during = t.sent.length;
    expect(during).toBeGreaterThan(2);
    release();
    await done;
    await t.once.pass.idle();
    const after = t.sent.length;
    await new Promise((r) => setTimeout(r, 40));
    // 終わりに 1 度配った後は、もう配らない。
    expect(t.sent.length).toBe(after);
  });

  it('最中にもう一度押されたら、新しく始めずにその回へ相乗りする', async () => {
    const t = setup({ paused: true });
    stop = t.once.stopTicker;
    await Promise.all([t.once.syncNow(), t.once.syncNow()]);
    await t.once.pass.idle();
    expect(t.calls.filter((c) => c.startsWith('metadata')).length).toBe(1);
  });

  it('残りがあれば、成功ではなく残りの件数で知らせる', async () => {
    const t = setup({ paused: true, pending: 2, sweepPending: 3 });
    stop = t.once.stopTicker;
    await t.once.syncNow();
    await t.once.pass.idle();
    expect(t.toasts).toEqual([{ level: 'error', message: '1 回だけ同期しましたが、未送信 2 件、未送信のトランスクリプト 3 件が残りました。同期は一時停止のままです' }]);
  });

  it('版で断られた 1 巡は、本文の降ろしに行かず、成功の知らせも toast も出さない（版の文は同期の状態が運ぶ）', async () => {
    const t = setup({ paused: true, compatBlocked: true, haltedDuringPass: true });
    stop = t.once.stopTicker;
    await t.once.syncNow();
    await t.once.pass.idle();
    expect(t.calls).not.toContain('files');
    expect(t.toasts).toEqual([]);
    // 状態は配る。ヘッダーの同期の語とベルの行が、この状態（error と理由）から組まれる。
    expect(t.sent.length).toBeGreaterThan(0);
  });

  it('上限で退いた 1 巡は、その終わりに成功や残りの件数の知らせを重ねない', async () => {
    const t = setup({ paused: true, limited: true, pending: 4, haltedDuringPass: true });
    stop = t.once.stopTicker;
    await t.once.syncNow();
    await t.once.pass.idle();
    expect(t.toasts).toEqual([]);
    // 状態は配る。件数は 1 巡で動いているが、エンジンは paused のまま配り直さない。
    expect(t.sent.length).toBeGreaterThan(0);
  });

  it('繋がらない段があっても、残りの段は試す', async () => {
    const t = setup({ paused: true, failing: ['files', 'config', 'usage'] });
    stop = t.once.stopTicker;
    await t.once.syncNow();
    await t.once.pass.idle();
    expect(t.calls).toEqual(['metadata(evenIfPaused)', 'files', 'config', 'sweep(Infinity)', 'upload.idle', 'usage']);
  });

  it('設定の同期を組んでいない端末では、設定の段を飛ばす', async () => {
    const t = setup({ paused: true, noBundle: true });
    stop = t.once.stopTicker;
    await t.once.syncNow();
    await t.once.pass.idle();
    expect(t.calls).toEqual(['metadata(evenIfPaused)', 'files', 'sweep(Infinity)', 'upload.idle', 'usage']);
  });
});
