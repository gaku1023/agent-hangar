import { describe, expect, it } from 'vitest';
import type { ConfigSyncDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { initialState, transition, type State } from './transition.ts';
import type { Input } from './types.ts';

const dto = (over: Partial<ConfigSyncDto> = {}): ConfigSyncDto => ({ enabled: true, workerPending: false, approval: 'each', incoming: 0, conflicts: 0, held: 0, unsent: 0, backups: 0, applyOrder: null, lastSentAt: null, ...over });
const storeOf = (c: ConfigSyncDto | null): Store => ({ ...initialStore(), configSync: c });

function run(inputs: Input[], start: State = initialState(), store: Store = storeOf(dto())) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, store, i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const action = (i: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: i });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });
const server = (e: Extract<Input, { kind: 'server' }>['event']): Input => ({ kind: 'server', event: e });

describe('設定の同期のダイアログ', () => {
  it('開くと、そのダイアログに要る中身を取りに行く', () => {
    const cases = [['send', ['outgoing']], ['review', ['inbox']], ['approve', ['inbox']], ['conflicts', ['conflicts']]] as const;
    for (const [part, parts] of cases) {
      const a = run([action({ type: 'configSync.open', part })]);
      expect(a.state.overlay).toEqual({ kind: 'configSync', part, working: false });
      expect(a.effects).toEqual([{ kind: 'api.configSyncLoad', parts }]);
    }
  });
  it('開いたダイアログの間では、別の部分へ移れる（適用中は移れない）', () => {
    const a = run([action({ type: 'configSync.open', part: 'review' }), action({ type: 'configSync.open', part: 'conflicts' })]);
    expect(a.state.overlay).toEqual({ kind: 'configSync', part: 'conflicts', working: false });
    const busy = run([action({ type: 'configSync.open', part: 'review' }), action({ type: 'configSync.apply', entries: [{ id: 'file:CLAUDE.md' }] })]);
    const b = run([action({ type: 'configSync.open', part: 'conflicts' })], busy.state);
    expect(b.state).toEqual(busy.state);
  });
  it('確認や入力のあるほかのダイアログの上には開かない', () => {
    const kill = run([action({ type: 'session.kill', runId: 'r1', working: true, shellTabs: 0 })]).state;
    const r = run([action({ type: 'configSync.open', part: 'send' })], kill);
    expect(r.state).toEqual(kill);
    expect(r.effects).toEqual([]);
  });
  it('送る一覧を承諾すると、スイッチを入れて閉じる', () => {
    const r = run([action({ type: 'configSync.open', part: 'send' }), action({ type: 'configSync.send.confirm' })]);
    expect(r.state.overlay).toEqual({ kind: 'none' });
    expect(r.effects.at(-1)).toEqual({ kind: 'api.updateSettings', patch: { configBundleSync: true } });
  });
  it('送る一覧の承諾は、その一覧を開いているときだけ効く', () => {
    const r = run([action({ type: 'configSync.send.confirm' })]);
    expect(r.effects).toEqual([]);
  });
  it('適用は、選んだ項目を指示書にする効果を出し、返事が来るまで閉じさせず、二重に出さない', () => {
    const open = run([action({ type: 'configSync.open', part: 'review' })]).state;
    const a = run([action({ type: 'configSync.apply', entries: [{ id: 'file:CLAUDE.md' }, { id: 'conflict-id', take: 'mine' }] })], open);
    expect(a.state.overlay).toEqual({ kind: 'configSync', part: 'review', working: true });
    expect(a.effects).toEqual([{ kind: 'api.configSyncApply', entries: [{ id: 'file:CLAUDE.md' }, { id: 'conflict-id', take: 'mine' }] }]);
    expect(run([action({ type: 'configSync.apply', entries: [{ id: 'x' }] })], a.state).effects).toEqual([]);
    // 閉じる操作は、適用の返事を待つあいだは握りつぶす。
    expect(run([action({ type: 'overlay.close' })], a.state).state).toEqual(a.state);
  });
  it('選んだ項目が 0 件なら、何も書かない', () => {
    const open = run([action({ type: 'configSync.open', part: 'approve' })]).state;
    expect(run([action({ type: 'configSync.apply', entries: [] })], open).effects).toEqual([]);
  });
  it('適用の返事で、閉じるか、開いたまま押せる状態に戻る', () => {
    const working = run([action({ type: 'configSync.open', part: 'review' }), action({ type: 'configSync.apply', entries: [{ id: 'x' }] })]).state;
    expect(run([runtime({ type: 'configSync.done', close: true })], working).state.overlay).toEqual({ kind: 'none' });
    expect(run([runtime({ type: 'configSync.done', close: false })], working).state.overlay).toEqual({ kind: 'configSync', part: 'review', working: false });
    // ダイアログが無いときの返事は、何も変えない。
    expect(run([runtime({ type: 'configSync.done', close: true })]).state.overlay).toEqual({ kind: 'none' });
  });
  it('指示書のやり直しと取り消しと世代へ戻す操作は、そのまま効果にする', () => {
    expect(run([action({ type: 'configSync.order.apply' })]).effects).toEqual([{ kind: 'api.configSyncApply', entries: null }]);
    expect(run([action({ type: 'configSync.restore', name: '20261010-120000' })]).effects).toEqual([{ kind: 'api.configSyncRestore', name: '20261010-120000' }]);
  });
});

describe('設定の同期の中身の取り直し', () => {
  it('設定の画面に入ったとき、件数のある中身だけを取りに行く', () => {
    const store = storeOf(dto({ incoming: 2, unsent: 1, backups: 3 }));
    const r = run([runtime({ type: 'hash.changed', route: { name: 'settings', at: 'cloud' } })], initialState(), store);
    expect(r.effects).toContainEqual({ kind: 'api.configSyncLoad', parts: ['inbox', 'unsent', 'backups'] });
  });
  it('件数が全部 0 のとき、同期を組んでいないとき、設定でない画面では取りに行かない', () => {
    const none = (store: Store, route: Extract<Input, { kind: 'runtime' }>['event']) => run([runtime(route)], initialState(), store).effects.filter((e) => (e as { kind: string }).kind === 'api.configSyncLoad');
    expect(none(storeOf(dto()), { type: 'hash.changed', route: { name: 'settings' } })).toEqual([]);
    expect(none(storeOf(null), { type: 'hash.changed', route: { name: 'settings' } })).toEqual([]);
    expect(none(storeOf(dto({ incoming: 2 })), { type: 'hash.changed', route: { name: 'home' } })).toEqual([]);
  });
  it('状態が動いたとき、設定の画面を見ていれば中身を取り直し、見ていなければ取り直さない', () => {
    const store = storeOf(dto({ conflicts: 1, incoming: 1 }));
    const update = server({ type: 'config.update', configSync: dto({ conflicts: 1, incoming: 1 }) });
    const onSettings = run([runtime({ type: 'hash.changed', route: { name: 'settings', at: 'cloud' } })], initialState(), store).state;
    expect(run([update], onSettings, store).effects).toEqual([{ kind: 'api.configSyncLoad', parts: ['inbox', 'conflicts'] }]);
    expect(run([update], initialState(), store).effects).toEqual([]);
  });
  it('ダイアログを開いているときは、そのダイアログの中身を取り直す', () => {
    const open = run([action({ type: 'configSync.open', part: 'conflicts' })]).state;
    expect(run([server({ type: 'config.update', configSync: dto() })], open).effects).toEqual([{ kind: 'api.configSyncLoad', parts: ['conflicts'] }]);
  });
});
