import { describe, expect, it } from 'vitest';
import { initialStore, type Store } from '../store/store.ts';
import { initialState, transition, type State } from './transition.ts';
import type { Input } from './types.ts';

// 終わった扱いの run の claude が動き続けているときの再開（issue #258）。サーバの 409 を確認にし、選び方を添えて送り直す。

const action = (a: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: a });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });
const store: Store = initialStore();
const MESSAGE = 'この会話の Claude はまだ終了していません（PID 4242）';

describe('再開の前の確認（残った claude）', () => {
  it('断られたら確認を開き、起動の待ちを解く。トーストは出さない', () => {
    const a = transition(initialState(), store, action({ type: 'session.resume', id: 's1' }));
    expect(a.effects).toEqual([{ kind: 'api.resume', sessionId: 's1' }]);
    const b = transition(a.state, store, runtime({ type: 'api.conflict', kind: 'strayProcess', sessionId: 's1', pid: 4242, message: MESSAGE, queued: false }));
    expect(b.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'strayProcess', sessionId: 's1', pid: 4242 } });
    expect(b.state.launch).toEqual({ kind: 'idle' });
    expect(b.effects).toEqual([]);
  });

  it('選んだら確認を閉じ、選び方を添えて再開を頼む', () => {
    const s: State = { ...initialState(), overlay: { kind: 'confirm', confirm: { kind: 'strayProcess', sessionId: 's1', pid: 4242 } } };
    for (const stray of ['stop', 'ignore'] as const) {
      const r = transition(s, store, action({ type: 'session.resume', id: 's1', stray }));
      expect(r.state.overlay).toEqual({ kind: 'none' });
      expect(r.state.launch).toEqual({ kind: 'submitting' });
      expect(r.effects).toEqual([{ kind: 'api.resume', sessionId: 's1', stray }]);
    }
  });

  it('差し替えられないダイアログが開いていれば、確認を出さずに理由をトーストで知らせる', () => {
    const s: State = { ...initialState(), overlay: { kind: 'addAccount' }, launch: { kind: 'submitting' } };
    const r = transition(s, store, runtime({ type: 'api.conflict', kind: 'strayProcess', sessionId: 's1', pid: 4242, message: MESSAGE, queued: false }));
    expect(r.state.overlay).toEqual({ kind: 'addAccount' });
    expect(r.state.launch).toEqual({ kind: 'failed', message: MESSAGE });
    expect(r.effects).toEqual([{ kind: 'toast', level: 'error', message: MESSAGE }]);
  });

  it('まとめて再開の 1 本は、確認に印を付け、選んだら選び方を添えて順番待ちに入れ直す。済んだら選び方を忘れる', () => {
    const a = transition(initialState(), store, action({ type: 'interrupted.resume', ids: ['a'] })).state;
    const b = transition(a, store, runtime({ type: 'resumeQueue.failed', sessionId: 'a', message: MESSAGE })).state;
    const c = transition(b, store, runtime({ type: 'api.conflict', kind: 'strayProcess', sessionId: 'a', pid: 4242, message: MESSAGE, queued: true }));
    expect(c.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'strayProcess', sessionId: 'a', pid: 4242, queued: true } });
    expect(c.state.launch).toEqual({ kind: 'idle' });
    expect(c.effects).toEqual([]);
    const d = transition(c.state, store, action({ type: 'interrupted.resume', ids: ['a'], stray: 'stop' }));
    expect(d.state.overlay).toEqual({ kind: 'none' });
    expect(d.effects).toEqual([{ kind: 'api.resumeQueued', sessionId: 'a', stray: 'stop' }]);
    expect(d.state.resumeQueue).toEqual({ queued: [], active: ['a'], failed: {}, stray: { a: 'stop' } });
    const e = transition(d.state, store, runtime({ type: 'resumeQueue.done', sessionId: 'a' }));
    expect(e.state.resumeQueue).toEqual({ queued: [], active: [], failed: {} });
  });

  it('まとめて再開の 1 本で確認を出せなければ、行に残した理由だけにする', () => {
    const s: State = { ...initialState(), overlay: { kind: 'addAccount' } };
    const r = transition(s, store, runtime({ type: 'api.conflict', kind: 'strayProcess', sessionId: 'a', pid: 4242, message: MESSAGE, queued: true }));
    expect(r.state.overlay).toEqual({ kind: 'addAccount' });
    expect(r.effects).toEqual([]);
  });
});
