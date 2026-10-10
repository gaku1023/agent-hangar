import { describe, expect, it } from 'vitest';
import type { RunDto, SettingsDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { initialUpdate, type UpdatePhase, type UpdateState } from '../store/update.ts';
import { presentUpdateCard, presentUpdateSection } from './update.ts';

const NOW = new Date(2026, 9, 10, 9, 12).getTime();
const MIN = 60_000;
const up = (phase: UpdatePhase, over: Partial<UpdateState> = {}): UpdateState => ({ ...initialUpdate(), supported: true, current: '1.4.2', phase, ...over });
const storeOf = (update: UpdateState, over: Partial<Store> = {}): Store => ({ ...initialStore(), bootstrapped: true, update, ...over });
const run = (id: string, sessionId: string, endedAt: number | null = null) => ({ id, sessionId, endedAt }) as unknown as RunDto;
const en = { language: 'en' } as unknown as SettingsDto;

describe('presentUpdateCard：右下の札', () => {
  it('新しい版が無いとき、殻が updater を持たないときは札を出さない', () => {
    expect(presentUpdateCard(storeOf(up({ kind: 'latest' })))).toBeNull();
    expect(presentUpdateCard(storeOf({ ...up({ kind: 'available', version: '1.5.0' }), supported: false }))).toBeNull();
  });

  it('新しい版があれば、版といまの版を言い、取得とあとでを置く', () => {
    const c = presentUpdateCard(storeOf(up({ kind: 'available', version: '1.5.0' })))!;
    expect(c).toMatchObject({ kind: 'available', tone: 'info', head: '更新あり', title: 'Hangar 1.5.0 を利用できます', detail: '現在は 1.4.2 です。', progress: null });
    expect(c.actions).toEqual([
      { label: 'ダウンロードしてインストール', action: { type: 'update.download' }, primary: true },
      { label: 'あとで', action: { type: 'update.dismiss' }, primary: false },
    ]);
  });

  it('取得中は同じ札の中で進みを出し、操作は置かない', () => {
    const c = presentUpdateCard(storeOf(up({ kind: 'downloading', version: '1.5.0', done: 62, total: 100 })))!;
    expect(c).toMatchObject({ kind: 'downloading', head: 'ダウンロード中', title: 'Hangar 1.5.0', progress: { percent: 62, label: '62%' }, actions: [] });
    // 大きさが分からないときは、割合を出さずに取得中とだけ言う。
    expect(presentUpdateCard(storeOf(up({ kind: 'downloading', version: '1.5.0', done: 10, total: null }))))!.toMatchObject({ progress: { percent: null, label: 'ダウンロードしています…' } });
  });

  it('準備ができたら、実行中のセッションが止まらないことを言い、再起動して更新とあとでだけを置く', () => {
    const store = storeOf(up({ kind: 'ready', version: '1.5.0' }), { runs: { r1: run('r1', 's1'), r2: run('r2', 's2'), r3: run('r3', 's3', 5) } });
    const c = presentUpdateCard(store)!;
    expect(c).toMatchObject({ kind: 'ready', tone: 'ok', head: 'インストール準備完了', title: '再起動して 1.5.0 に更新', detail: '実行中のセッション 2 件は止まりません。再起動のあと、続きから表示します。' });
    expect(c.actions).toEqual([
      { label: '再起動して更新', action: { type: 'update.install' }, primary: true },
      { label: 'あとで', action: { type: 'update.dismiss' }, primary: false },
    ]);
    // 実行中のセッションが無ければ、数を言わない。
    expect(presentUpdateCard(storeOf(up({ kind: 'ready', version: '1.5.0' })))!.detail).toBe('再起動すると、新しいバージョンで開きます。');
  });

  it('インストール中は操作を置かない', () => {
    expect(presentUpdateCard(storeOf(up({ kind: 'installing', version: '1.5.0' }))))!.toMatchObject({ kind: 'installing', head: 'インストール中', actions: [] });
  });

  it('失敗したら、いまの版が変わらないことと理由を言い、もう一度試すと閉じるを置く', () => {
    const c = presentUpdateCard(storeOf(up({ kind: 'failed', step: 'install', version: '1.5.0', reason: 'signature' })))!;
    expect(c).toMatchObject({ kind: 'failed', tone: 'err', head: '更新に失敗', title: 'インストールできませんでした', detail: 'いまのバージョン 1.4.2 は変わりません。署名を確認できませんでした。' });
    expect(c.actions).toEqual([
      { label: 'もう一度試す', action: { type: 'update.download' }, primary: true },
      { label: '閉じる', action: { type: 'update.dismiss' }, primary: false },
    ]);
    expect(presentUpdateCard(storeOf(up({ kind: 'failed', step: 'download', version: '1.5.0', reason: 'network' }))))!.toMatchObject({ title: 'ダウンロードできませんでした' });
  });

  it('閉じた版の札は出さない', () => {
    expect(presentUpdateCard(storeOf(up({ kind: 'available', version: '1.5.0' }, { dismissed: '1.5.0' })))).toBeNull();
  });

  it('英語でも組める', () => {
    const c = presentUpdateCard(storeOf(up({ kind: 'available', version: '1.5.0' }), { settings: en }))!;
    expect(c).toMatchObject({ head: 'Update available', title: 'Hangar 1.5.0 is available' });
  });
});

describe('presentUpdateSection：設定の「更新」の節', () => {
  it('最新なら、版と最終確認の時刻、最新の札を出す', () => {
    const p = presentUpdateSection(storeOf(up({ kind: 'latest' }, { checkedAt: NOW - 5 * MIN })), NOW);
    expect(p).toMatchObject({ supported: true, badge: { text: '最新', tone: 'ok' }, version: { title: 'バージョン 1.4.2', sub: '最終確認：5 分前', checkLabel: '更新を確認', checkDisabled: false }, pending: null });
    expect(p.notify).toEqual({ on: true, desc: '新しいバージョンが出たら知らせます。インストールは押したときだけ行います。' });
    expect(p.tocState).toBe('最新');
  });

  it('確認中はボタンを押せず、通知オフなら札は通知オフにする', () => {
    const p = presentUpdateSection(storeOf(up({ kind: 'checking' }, { notify: false })), NOW);
    expect(p).toMatchObject({ badge: { text: '通知オフ', tone: 'off' }, version: { sub: '確認中…', checkLabel: '確認中…', checkDisabled: true } });
    expect(p.notify).toEqual({ on: false, desc: '無効です。手動の確認だけ使えます。' });
  });

  it('まだ確認していなければ、そう言う', () => {
    const p = presentUpdateSection(storeOf(up({ kind: 'unknown' })), NOW);
    expect(p.version.sub).toBe('まだ確認していません');
    expect(p.badge).toBeNull();
    expect(p.tocState).toBe('バージョン 1.4.2');
  });

  it('確認に失敗したら、理由を版の行に出す', () => {
    const p = presentUpdateSection(storeOf(up({ kind: 'failed', step: 'check', version: null, reason: 'network' })), NOW);
    expect(p.version.sub).toBe('確認できませんでした。ネットワークか配布元に接続できませんでした。');
    expect(p.pending).toBeNull();
  });

  it('新しい版があれば、閉じていても節には出す', () => {
    const p = presentUpdateSection(storeOf(up({ kind: 'available', version: '1.5.0' }, { dismissed: '1.5.0', checkedAt: NOW })), NOW);
    expect(p.badge).toEqual({ text: '新しいバージョンあり', tone: 'info' });
    expect(p.pending).toMatchObject({ title: 'Hangar 1.5.0 を利用できます', actions: [{ label: 'ダウンロードしてインストール', action: { type: 'update.download' }, primary: true }] });
  });

  it('取得中は確認を押せず、進みを出す', () => {
    const p = presentUpdateSection(storeOf(up({ kind: 'downloading', version: '1.5.0', done: 1, total: 4 })), NOW);
    expect(p.version.checkDisabled).toBe(true);
    expect(p.pending).toMatchObject({ progress: { percent: 25 }, actions: [] });
  });

  it('準備ができたら再起動待ちの札と、再起動して更新を出す', () => {
    const p = presentUpdateSection(storeOf(up({ kind: 'ready', version: '1.5.0' })), NOW);
    expect(p.badge).toEqual({ text: '再起動待ち', tone: 'warn' });
    expect(p.pending?.actions).toEqual([{ label: '再起動して更新', action: { type: 'update.install' }, primary: true }]);
  });

  it('取得の失敗は失敗の札にし、もう一度試すを出す', () => {
    const p = presentUpdateSection(storeOf(up({ kind: 'failed', step: 'download', version: '1.5.0', reason: 'other' })), NOW);
    expect(p.badge).toEqual({ text: '失敗', tone: 'stop' });
    expect(p.pending?.actions).toEqual([{ label: 'もう一度試す', action: { type: 'update.download' }, primary: true }]);
  });

  it('殻が updater を持たないとき（ブラウザ）は、デスクトップのアプリで確認すると言う', () => {
    const p = presentUpdateSection(storeOf(initialUpdate()), NOW);
    expect(p.supported).toBe(false);
    expect(p.unsupported).toBe('更新はデスクトップのアプリで確認します。');
  });
});
