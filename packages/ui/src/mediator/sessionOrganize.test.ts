import { describe, expect, it } from 'vitest';
import type { Input } from './types.ts';
import { initialState, transition, type State } from './transition.ts';
import { initialStore } from '../store/store.ts';

// セッションのメニューの「プロジェクトを変更…」と「削除…」が開くダイアログと、消えたセッションの画面の後始末。

const act = (state: State, input: Input) => transition(state, initialStore(), input);
const onSession = (id: string): State => ({ ...initialState(), screen: { name: 'session', id } });

describe('移す先のダイアログと削除の確認を開く', () => {
  it('session.move.open は移す先のダイアログを開く', () => {
    const r = act(initialState(), { kind: 'action', action: { type: 'session.move.open', id: 's1' } });
    expect(r.state.overlay).toEqual({ kind: 'moveSession', sessionId: 's1' });
    expect(r.effects).toEqual([]);
  });
  it('session.delete.open は削除の確認を開く', () => {
    const r = act(initialState(), { kind: 'action', action: { type: 'session.delete.open', id: 's1' } });
    expect(r.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'deleteSession', sessionId: 's1' } });
  });
  it('決めるまで閉じないダイアログの上には重ねない', () => {
    const busy: State = { ...initialState(), overlay: { kind: 'pause', sessionId: 's2', from: 'menu' } };
    expect(act(busy, { kind: 'action', action: { type: 'session.move.open', id: 's1' } }).state.overlay).toEqual(busy.overlay);
    expect(act(busy, { kind: 'action', action: { type: 'session.delete.open', id: 's1' } }).state.overlay).toEqual(busy.overlay);
  });
  it('overlay.close で閉じる', () => {
    const open: State = { ...initialState(), overlay: { kind: 'moveSession', sessionId: 's1' } };
    expect(act(open, { kind: 'action', action: { type: 'overlay.close' } }).state.overlay).toEqual({ kind: 'none' });
  });
});

describe('セッションが消えた（session.removed）', () => {
  it('その画面を開いていたら、ホームへ戻る', () => {
    const r = act(onSession('s1'), { kind: 'server', event: { type: 'session.removed', id: 's1' } });
    expect(r.effects).toEqual([{ kind: 'navigate', route: { name: 'home' } }]);
  });
  it('ほかのセッションの画面にいるときは動かない', () => {
    const r = act(onSession('s2'), { kind: 'server', event: { type: 'session.removed', id: 's1' } });
    expect(r.effects).toEqual([]);
    expect(r.state.screen).toEqual({ name: 'session', id: 's2' });
  });
  it('そのセッションの移す先のダイアログ、削除の確認、Paused の入力が開いていれば閉じる', () => {
    for (const overlay of [{ kind: 'moveSession', sessionId: 's1' }, { kind: 'confirm', confirm: { kind: 'deleteSession', sessionId: 's1' } }, { kind: 'pause', sessionId: 's1', from: 'menu' }] as const) {
      const r = act({ ...initialState(), screen: { name: 'home' }, overlay }, { kind: 'server', event: { type: 'session.removed', id: 's1' } });
      expect(r.state.overlay).toEqual({ kind: 'none' });
    }
  });
  it('ほかのセッションのダイアログは閉じない', () => {
    const overlay = { kind: 'moveSession', sessionId: 's2' } as const;
    const r = act({ ...initialState(), screen: { name: 'home' }, overlay }, { kind: 'server', event: { type: 'session.removed', id: 's1' } });
    expect(r.state.overlay).toEqual(overlay);
  });
});
