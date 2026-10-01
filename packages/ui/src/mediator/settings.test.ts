import { describe, expect, it } from 'vitest';
import type { Input } from './types.ts';
import { initialState, transition, type State } from './transition.ts';

function run(inputs: Input[], start: State = initialState()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const intent = (i: Extract<Input, { kind: 'intent' }>['intent']): Input => ({ kind: 'intent', intent: i });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });

describe('欄ごとの保存（設定の C1 と B1）', () => {
  it('欄の名前を添えた保存は、その名前を効果に載せ、欄の前の知らせを消す', () => {
    const a = run([intent({ type: 'settings.update', patch: { tmuxPath: '/x' }, field: 'tmuxPath' }), runtime({ type: 'settings.failed', field: 'tmuxPath', message: '見つかりません' })]);
    expect(a.effects).toEqual([{ kind: 'api.updateSettings', patch: { tmuxPath: '/x' }, field: 'tmuxPath' }]);
    expect(a.state.settingsSave.tmuxPath).toEqual({ kind: 'error', message: '見つかりません' });
    const b = run([intent({ type: 'settings.update', patch: { tmuxPath: '/y' }, field: 'tmuxPath' })], a.state);
    expect(b.state.settingsSave.tmuxPath).toBeUndefined();
  });
  it('保存できたら欄に印を付け、同じ欄の保存のたびに印の番号を進める', () => {
    const a = run([runtime({ type: 'settings.saved', field: 'workspaceRoot' })]);
    expect(a.state.settingsSave.workspaceRoot).toEqual({ kind: 'saved', n: 1 });
    const b = run([runtime({ type: 'settings.saved', field: 'workspaceRoot' })], a.state);
    expect(b.state.settingsSave.workspaceRoot).toEqual({ kind: 'saved', n: 2 });
    // 失敗はトーストにしない。欄の下に出すので、二重に言わない。
    const c = run([runtime({ type: 'settings.failed', field: 'workspaceRoot', message: 'x' })], b.state);
    expect(c.state.toasts).toEqual([]);
  });
  // 欄の値は画面を離れると保存済みの値に戻る。戻った欄の下に前の理由だけが残ると、いまの値が断られたように読める。
  it('設定の画面を離れたら、欄の下の理由を消す。保存済みの印は残す', () => {
    const at = run([runtime({ type: 'hash.changed', route: { name: 'settings' } }), runtime({ type: 'settings.saved', field: 'workspaceRoot' }), runtime({ type: 'settings.failed', field: 'tmuxPath', message: '見つかりません' })]).state;
    expect(at.settingsSave.tmuxPath).toEqual({ kind: 'error', message: '見つかりません' });
    const left = run([runtime({ type: 'hash.changed', route: { name: 'home' } })], at).state;
    expect(left.settingsSave).toEqual({ workspaceRoot: { kind: 'saved', n: 1 } });
    // 設定の画面の中で描き直すだけ（同じ画面の hash.changed）なら消さない。
    expect(run([runtime({ type: 'hash.changed', route: { name: 'settings' } })], at).state.settingsSave.tmuxPath).toEqual({ kind: 'error', message: '見つかりません' });
  });
});

describe('準備の確かめ', () => {
  it('もう一度確かめると取り直す', () => {
    expect(run([intent({ type: 'readiness.check' })]).effects).toEqual([{ kind: 'api.readiness' }]);
  });
  it('設定の画面に入ると、ほかの値と一緒に準備の確かめも取る', () => {
    const { effects } = run([runtime({ type: 'ws.open' }), runtime({ type: 'hash.changed', route: { name: 'settings' } })]);
    expect(effects).toContainEqual({ kind: 'api.loadSettingsExtras' });
  });
});

describe('殻の操作', () => {
  it('ログを開く、再起動、コピーは効果にする', () => {
    const { effects } = run([intent({ type: 'shell.openLog' }), intent({ type: 'shell.restart' }), intent({ type: 'clipboard.copy', text: '~/.agent-hangar/desktop.log' })]);
    expect(effects).toEqual([{ kind: 'shell.openLog' }, { kind: 'shell.restart' }, { kind: 'clipboard.copy', text: '~/.agent-hangar/desktop.log' }]);
  });
});
