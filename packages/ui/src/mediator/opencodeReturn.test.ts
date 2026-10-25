import { describe, expect, it } from 'vitest';
import { initialStore } from '../store/store.ts';
import { initialState, transition, type State } from './transition.ts';
import type { Input } from './types.ts';

// 新しいセッションのモデルの小窓の「プロバイダーを管理…」から設定へ移り、「‹ 新しいセッションに戻る」で戻る（C3 の申し送り）。
const action = (i: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: i });
const step = (state: State, i: Input) => transition(state, initialStore(), i);

describe('プロバイダーを管理して戻る', () => {
  it('ダイアログを閉じて設定の opencode へ移り、開いていたダイアログの開き方を覚える', () => {
    const open = step({ ...initialState(), screen: { name: 'home', q: '' } } as State, action({ type: 'session.new.open', projectId: 'p1' })).state;
    const r = step(open, action({ type: 'opencode.providers.manage' }));
    expect(r.state.overlay).toEqual({ kind: 'none' });
    expect(r.state.opencodeReturn).toEqual({ projectId: 'p1', scratch: false });
    expect(r.effects).toContainEqual({ kind: 'navigate', route: { name: 'settings', at: 'opencode' } });
  });

  it('戻ると同じ開き方でダイアログを開き直し、覚えたものを消す', () => {
    const at = { ...initialState(), opencodeReturn: { projectId: null, scratch: true, dir: '/w/x' } } as State;
    const r = step(at, action({ type: 'opencode.providers.back' }));
    expect(r.state.overlay).toEqual({ kind: 'newSession', projectId: null, scratch: true, dir: '/w/x' });
    expect(r.state.opencodeReturn).toBeNull();
    // 覚えたものが無ければ何もしない。
    expect(step(initialState(), action({ type: 'opencode.providers.back' })).state.overlay).toEqual({ kind: 'none' });
  });

  it('設定のほかの画面へ移ったら忘れる（あとで設定を開いても戻る行を出さない）', () => {
    const at = { ...initialState(), screen: { name: 'settings' }, opencodeReturn: { projectId: 'p1', scratch: false } } as State;
    expect(step(at, action({ type: 'nav.go', to: { name: 'settings', at: 'cloud' } })).state.opencodeReturn).toEqual({ projectId: 'p1', scratch: false });
    expect(step(at, action({ type: 'nav.go', to: { name: 'home' } })).state.opencodeReturn).toBeNull();
  });
});
