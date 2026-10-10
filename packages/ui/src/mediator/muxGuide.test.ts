import { describe, expect, it } from 'vitest';
import type { LaunchParams, ReadinessDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { initialState, transition, type State } from './transition.ts';
import type { Input } from './types.ts';

// psmux（Windows）と tmux が無いときの案内（段 6 の B2）。
// セッションを始めようとした瞬間に止めて案内し、再確認で見つかればそのまま始められるようにする。

const READY: ReadinessDto = {
  tools: { tmux: { path: 'C:\\x\\psmux.exe', ok: true, problem: null, version: '3.3.1' }, claude: { path: '/c', ok: true, problem: null, version: '2.3.1' }, code: { path: null, ok: false, problem: 'unset', version: null }, node: { path: '/n', ok: true, problem: null, version: 'v22.9.0', auto: true } },
  workspace: { path: '/w', exists: true, projectCount: 1 }, mcp: { registered: true, file: '/c.json' }, statusline: { command: null, scriptPath: null, installed: true },
  commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' },
  compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
};
const MISSING: ReadinessDto = { ...READY, tools: { ...READY.tools, tmux: { path: null, ok: false, problem: 'unset', version: null } } };
const storeWith = (r: ReadinessDto | null): Store => ({ ...initialStore(), readiness: r });
const action = (a: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: a });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });
const params: LaunchParams = { projectId: 'p1', name: 'x' } as LaunchParams;

describe('セッションを始める前の止め（B2）', () => {
  it('psmux が無ければ再開を止めて案内を出し、サーバへは送らない', () => {
    const r = transition(initialState(), storeWith(MISSING), action({ type: 'session.resume', id: 's1' }));
    expect(r.state.overlay).toEqual({ kind: 'muxGuide', pending: { type: 'session.resume', id: 's1' }, back: null });
    expect(r.state.launch).toEqual({ kind: 'idle' });
    expect(r.effects).toEqual([]);
  });
  it('フォークと「この PC で再開」も止める', () => {
    expect(transition(initialState(), storeWith(MISSING), action({ type: 'session.fork', id: 's1' })).state.overlay.kind).toBe('muxGuide');
    expect(transition(initialState(), storeWith(MISSING), action({ type: 'session.resumeHere', id: 's1' })).state.overlay.kind).toBe('muxGuide');
  });
  it('見つかっているとき、まだ確かめていないときは止めない', () => {
    expect(transition(initialState(), storeWith(READY), action({ type: 'session.resume', id: 's1' })).effects).toEqual([{ kind: 'api.resume', sessionId: 's1' }]);
    expect(transition(initialState(), storeWith(null), action({ type: 'session.resume', id: 's1' })).effects).toEqual([{ kind: 'api.resume', sessionId: 's1' }]);
  });
  it('新しいセッションの「開始」は、ダイアログを覚えて止め、キャンセルでダイアログへ戻る', () => {
    const open: State = { ...initialState(), overlay: { kind: 'newSession', projectId: 'p1', scratch: false } };
    const r = transition(open, storeWith(MISSING), action({ type: 'session.new.submit', params }));
    expect(r.state.overlay).toEqual({ kind: 'muxGuide', pending: { type: 'session.new.submit', params }, back: { kind: 'newSession', projectId: 'p1', scratch: false } });
    expect(r.effects).toEqual([]);
    const back = transition(r.state, storeWith(MISSING), action({ type: 'overlay.close' }));
    expect(back.state.overlay).toEqual({ kind: 'newSession', projectId: 'p1', scratch: false });
  });
  it('案内を閉じると、ダイアログが無ければ何も出ていない状態へ戻る', () => {
    const r = transition(initialState(), storeWith(MISSING), action({ type: 'session.resume', id: 's1' }));
    expect(transition(r.state, storeWith(MISSING), action({ type: 'overlay.close' })).state.overlay).toEqual({ kind: 'none' });
  });
});

describe('再確認（B1、B2、B3 が共有する）', () => {
  it('押すとサーバに探し直させ、答えが来るまでは重ねて送らない', () => {
    const a = transition(initialState(), storeWith(MISSING), action({ type: 'mux.recheck' }));
    expect(a.state.muxCheck).toBe('checking');
    expect(a.effects).toEqual([{ kind: 'api.recheckMux' }]);
    expect(transition(a.state, storeWith(MISSING), action({ type: 'mux.recheck' })).effects).toEqual([]);
  });
  it('見つからなければ「まだ見つかりません」の印を持ち、見つかれば印を外す', () => {
    const checking: State = { ...initialState(), muxCheck: 'checking' };
    expect(transition(checking, storeWith(MISSING), runtime({ type: 'mux.checked', found: false })).state.muxCheck).toBe('missing');
    expect(transition(checking, storeWith(READY), runtime({ type: 'mux.checked', found: true })).state.muxCheck).toBe('idle');
  });
  it('見つかったあとの「開始」で、止めていた操作をそのまま送る', () => {
    const open: State = { ...initialState(), overlay: { kind: 'newSession', projectId: 'p1', scratch: false } };
    const guided = transition(open, storeWith(MISSING), action({ type: 'session.new.submit', params })).state;
    const r = transition(guided, storeWith(READY), action({ type: 'mux.guide.proceed' }));
    // 新しいセッションのダイアログへ戻してから送るので、起動し終えたらダイアログと下書きが片付く。
    expect(r.state.overlay).toEqual({ kind: 'newSession', projectId: 'p1', scratch: false });
    expect(r.state.launch).toEqual({ kind: 'submitting' });
    expect(r.effects).toContainEqual({ kind: 'api.launch', params });
  });
  it('再開とこの PC で再開も、見つかったあとの「開始」で送る', () => {
    const g1 = transition(initialState(), storeWith(MISSING), action({ type: 'session.resume', id: 's1' })).state;
    const r1 = transition(g1, storeWith(READY), action({ type: 'mux.guide.proceed' }));
    expect(r1.state.overlay).toEqual({ kind: 'none' });
    expect(r1.effects).toEqual([{ kind: 'api.resume', sessionId: 's1' }]);
    const g2 = transition(initialState(), storeWith(MISSING), action({ type: 'session.resumeHere', id: 's1' })).state;
    expect(transition(g2, storeWith(READY), action({ type: 'mux.guide.proceed' })).effects).toEqual([{ kind: 'api.resumeHere', sessionId: 's1', overwrite: false }]);
  });
  it('まだ見つかっていなければ「開始」は何もしない', () => {
    const g = transition(initialState(), storeWith(MISSING), action({ type: 'session.resume', id: 's1' })).state;
    const r = transition(g, storeWith(MISSING), action({ type: 'mux.guide.proceed' }));
    expect(r.state.overlay.kind).toBe('muxGuide');
    expect(r.effects).toEqual([]);
  });
});
