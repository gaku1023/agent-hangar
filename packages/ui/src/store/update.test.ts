import { describe, expect, it } from 'vitest';
import { cardPhase, initialUpdate, reduceUpdate, type UpdateEvent, type UpdateState } from './update.ts';

/** 殻が updater を持ち、いまの版が 1.4.2 の状態から始める。 */
const ready = (over: Partial<UpdateState> = {}): UpdateState => ({ ...reduceUpdate(initialUpdate(), { type: 'supported', current: '1.4.2' }), ...over });
const run = (s: UpdateState, ...events: UpdateEvent[]): UpdateState => events.reduce(reduceUpdate, s);

describe('更新の状態の移り変わり', () => {
  it('はじめは殻の updater を知らず、確認もしていない', () => {
    const s = initialUpdate();
    expect(s.supported).toBe(false);
    expect(s.current).toBeNull();
    expect(s.phase).toEqual({ kind: 'unknown' });
    expect(s.notify).toBe(true);
    expect(s.dismissed).toBeNull();
    expect(cardPhase(s)).toBeNull();
  });

  it('確認して新しい版が無ければ最新になり、札は出ない', () => {
    const s = run(ready(), { type: 'check.start', manual: false }, { type: 'check.done', version: null, at: 1000 });
    expect(s.phase).toEqual({ kind: 'latest' });
    expect(s.checkedAt).toBe(1000);
    expect(cardPhase(s)).toBeNull();
  });

  it('確認の最中は確認中で、手動かどうかを覚える', () => {
    expect(run(ready(), { type: 'check.start', manual: true })).toMatchObject({ phase: { kind: 'checking' }, manual: true });
    expect(run(ready(), { type: 'check.start', manual: false })).toMatchObject({ phase: { kind: 'checking' }, manual: false });
  });

  it('新しい版があれば札を出す', () => {
    const s = run(ready(), { type: 'check.start', manual: false }, { type: 'check.done', version: '1.5.0', at: 1000 });
    expect(s.phase).toEqual({ kind: 'available', version: '1.5.0' });
    expect(cardPhase(s)).toEqual({ kind: 'available', version: '1.5.0' });
  });

  it('知らせを切っていると、自動の確認で見つけても札は出さない。手動の確認なら出す', () => {
    const off = ready({ notify: false });
    expect(cardPhase(run(off, { type: 'check.start', manual: false }, { type: 'check.done', version: '1.5.0', at: 1 }))).toBeNull();
    expect(cardPhase(run(off, { type: 'check.start', manual: true }, { type: 'check.done', version: '1.5.0', at: 1 }))).toEqual({ kind: 'available', version: '1.5.0' });
  });

  it('取得中は進みを持ち、終われば準備完了になる', () => {
    const found = run(ready(), { type: 'check.start', manual: false }, { type: 'check.done', version: '1.5.0', at: 1 });
    const started = run(found, { type: 'download.start' });
    expect(started.phase).toEqual({ kind: 'downloading', version: '1.5.0', done: 0, total: null });
    const half = run(started, { type: 'download.progress', done: 50, total: 100 });
    expect(half.phase).toEqual({ kind: 'downloading', version: '1.5.0', done: 50, total: 100 });
    expect(cardPhase(half)?.kind).toBe('downloading');
    const done = run(half, { type: 'download.done' });
    expect(done.phase).toEqual({ kind: 'ready', version: '1.5.0' });
    expect(cardPhase(done)).toEqual({ kind: 'ready', version: '1.5.0' });
  });

  it('取得できなければ失敗になり、その版を覚えて札に出す', () => {
    const s = run(ready(), { type: 'check.start', manual: false }, { type: 'check.done', version: '1.5.0', at: 1 }, { type: 'download.start' }, { type: 'download.failed', reason: 'network' });
    expect(s.phase).toEqual({ kind: 'failed', step: 'download', version: '1.5.0', reason: 'network' });
    expect(cardPhase(s)?.kind).toBe('failed');
  });

  it('インストールの最中とその失敗も札に出す', () => {
    const readyToInstall = run(ready(), { type: 'check.start', manual: false }, { type: 'check.done', version: '1.5.0', at: 1 }, { type: 'download.start' }, { type: 'download.done' });
    const installing = run(readyToInstall, { type: 'install.start' });
    expect(installing.phase).toEqual({ kind: 'installing', version: '1.5.0' });
    const failed = run(installing, { type: 'install.failed', reason: 'permission' });
    expect(failed.phase).toEqual({ kind: 'failed', step: 'install', version: '1.5.0', reason: 'permission' });
    expect(cardPhase(failed)?.kind).toBe('failed');
  });

  it('失敗からもう一度取得できる', () => {
    const failed = run(ready(), { type: 'check.start', manual: false }, { type: 'check.done', version: '1.5.0', at: 1 }, { type: 'download.start' }, { type: 'download.failed', reason: 'network' });
    expect(run(failed, { type: 'download.start' }).phase).toEqual({ kind: 'downloading', version: '1.5.0', done: 0, total: null });
  });

  it('確認の失敗は札にせず、設定の節にだけ出す', () => {
    const s = run(ready(), { type: 'check.start', manual: false }, { type: 'check.failed', reason: 'network' });
    expect(s.phase).toEqual({ kind: 'failed', step: 'check', version: null, reason: 'network' });
    expect(cardPhase(s)).toBeNull();
  });

  it('取得中、インストール中、準備完了のあいだは、確認をし直さない', () => {
    const found = run(ready(), { type: 'check.start', manual: false }, { type: 'check.done', version: '1.5.0', at: 1 });
    const downloading = run(found, { type: 'download.start' });
    expect(run(downloading, { type: 'check.start', manual: true })).toBe(downloading);
    const done = run(downloading, { type: 'download.done' });
    expect(run(done, { type: 'check.start', manual: false })).toBe(done);
    const installing = run(done, { type: 'install.start' });
    expect(run(installing, { type: 'check.start', manual: true })).toBe(installing);
  });

  it('新しい版が無いのに取得しようとしても、何も変えない', () => {
    const latest = run(ready(), { type: 'check.start', manual: false }, { type: 'check.done', version: null, at: 1 });
    expect(run(latest, { type: 'download.start' })).toBe(latest);
    expect(run(latest, { type: 'install.start' })).toBe(latest);
  });

  it('閉じた版は覚え、同じ版の札は出さない。次の版が出たら出す', () => {
    const found = run(ready(), { type: 'check.start', manual: false }, { type: 'check.done', version: '1.5.0', at: 1 });
    const closed = run(found, { type: 'dismiss' });
    expect(closed.dismissed).toBe('1.5.0');
    expect(cardPhase(closed)).toBeNull();
    // 次の確認で同じ版が見つかっても出さない。
    const again = run(closed, { type: 'check.start', manual: false }, { type: 'check.done', version: '1.5.0', at: 2 });
    expect(cardPhase(again)).toBeNull();
    // 次の版なら出す。
    const next = run(again, { type: 'check.start', manual: false }, { type: 'check.done', version: '1.6.0', at: 3 });
    expect(cardPhase(next)).toEqual({ kind: 'available', version: '1.6.0' });
  });

  it('準備完了と失敗の札も、閉じればその版では出さない', () => {
    const done = run(ready(), { type: 'check.start', manual: false }, { type: 'check.done', version: '1.5.0', at: 1 }, { type: 'download.start' }, { type: 'download.done' });
    expect(cardPhase(run(done, { type: 'dismiss' }))).toBeNull();
    const failed = run(done, { type: 'install.start' }, { type: 'install.failed', reason: 'other' });
    expect(cardPhase(run(failed, { type: 'dismiss' }))).toBeNull();
  });

  it('閉じた版を自分で取得し直したら、その版の札をまた出す', () => {
    const found = run(ready(), { type: 'check.start', manual: false }, { type: 'check.done', version: '1.5.0', at: 1 }, { type: 'dismiss' });
    const s = run(found, { type: 'download.start' });
    expect(s.dismissed).toBeNull();
    expect(cardPhase(s)?.kind).toBe('downloading');
  });

  it('版の無い状態で閉じても、覚える版は変えない', () => {
    const s = ready({ dismissed: '1.3.0' });
    expect(run(s, { type: 'dismiss' })).toBe(s);
  });

  it('知らせのスイッチを覚える', () => {
    expect(run(ready(), { type: 'notify', on: false }).notify).toBe(false);
    expect(run(ready({ notify: false }), { type: 'notify', on: true }).notify).toBe(true);
  });

  it('保存してあった閉じた版とスイッチを読み戻す。形の違う値は捨てる', () => {
    expect(run(initialUpdate(), { type: 'restore', dismissed: '1.5.0', notify: false })).toMatchObject({ dismissed: '1.5.0', notify: false });
    expect(run(initialUpdate(), { type: 'restore', dismissed: 3, notify: 'no' })).toMatchObject({ dismissed: null, notify: true });
  });

  it('殻が updater を持たないときは、札を出さない', () => {
    const s = run(initialUpdate(), { type: 'check.start', manual: true }, { type: 'check.done', version: '1.5.0', at: 1 });
    expect(cardPhase(s)).toBeNull();
  });
});
