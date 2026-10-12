import { describe, expect, it } from 'vitest';
import type { ReadinessDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { initialState, transition, type State } from './transition.ts';
import type { Input } from './types.ts';

// 中断の群のまとめて再開（同時に 2 本まで）と、「再開しない」と、その元に戻す。

const action = (a: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: a });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });
const store: Store = initialStore();
const resumes = (effects: { kind: string }[]) => effects.filter((e): e is { kind: 'api.resumeQueued'; sessionId: string } => e.kind === 'api.resumeQueued').map((e) => e.sessionId);

describe('まとめて再開', () => {
  it('同時に 2 本まで起こし、残りは順番待ちにする。画面は移さない', () => {
    const r = transition(initialState(), store, action({ type: 'interrupted.resume', ids: ['a', 'b', 'c'] }));
    expect(r.state.resumeQueue).toEqual({ queued: ['c'], active: ['a', 'b'], failed: {} });
    expect(resumes(r.effects)).toEqual(['a', 'b']);
    expect(r.effects.some((e) => e.kind === 'navigate')).toBe(false);
    expect(r.state.launch).toEqual({ kind: 'idle' });
  });

  it('1 本済むと次を起こし、失敗は理由を残して次へ進む', () => {
    const a = transition(initialState(), store, action({ type: 'interrupted.resume', ids: ['a', 'b', 'c', 'd'] })).state;
    const b = transition(a, store, runtime({ type: 'resumeQueue.done', sessionId: 'a' }));
    expect(b.state.resumeQueue).toEqual({ queued: ['d'], active: ['b', 'c'], failed: {} });
    expect(resumes(b.effects)).toEqual(['c']);
    const c = transition(b.state, store, runtime({ type: 'resumeQueue.failed', sessionId: 'b', message: '作業ディレクトリが見つかりません' }));
    expect(c.state.resumeQueue).toEqual({ queued: [], active: ['c', 'd'], failed: { b: '作業ディレクトリが見つかりません' } });
    expect(resumes(c.effects)).toEqual(['d']);
  });

  it('再試行は失敗の印を外して順番待ちに足す。動いているものと待っているものは重ねない', () => {
    const s: State = { ...initialState(), resumeQueue: { queued: ['c'], active: ['a', 'b'], failed: { x: 'だめ' } } };
    const r = transition(s, store, action({ type: 'interrupted.resume', ids: ['x', 'a', 'c'] }));
    expect(r.state.resumeQueue).toEqual({ queued: ['c', 'x'], active: ['a', 'b'], failed: {} });
    expect(r.effects).toEqual([]);
  });

  it('残りをキャンセルすると、順番待ちだけを外す（起こしかけたものは止めない）', () => {
    const s: State = { ...initialState(), resumeQueue: { queued: ['c', 'd'], active: ['a'], failed: { x: 'だめ' } } };
    expect(transition(s, store, action({ type: 'interrupted.cancel' })).state.resumeQueue).toEqual({ queued: [], active: ['a'], failed: { x: 'だめ' } });
  });

  it('tmux（psmux）が無いと分かっていれば、案内で止める', () => {
    const missing = { tools: { tmux: { path: null, ok: false, problem: 'unset', version: null } } } as unknown as ReadinessDto;
    const r = transition(initialState(), { ...store, readiness: missing }, action({ type: 'interrupted.resume', ids: ['a'] }));
    expect(r.state.overlay).toEqual({ kind: 'muxGuide', pending: { type: 'interrupted.resume', ids: ['a'] }, back: null });
    expect(r.effects).toEqual([]);
  });
});

describe('再開しない', () => {
  it('印を付けて、元に戻せるトーストを出す', () => {
    const r = transition(initialState(), store, action({ type: 'interrupted.dismiss', runIds: ['r1'], dismissed: true, name: '検索の並び順' }));
    expect(r.effects).toEqual([{ kind: 'api.dismissInterrupted', runIds: ['r1'], dismissed: true }]);
    expect(r.state.toasts).toEqual([{ id: '1', level: 'info', message: '「検索の並び順」は再開しません', action: { label: '元に戻す', send: { type: 'interrupted.dismiss', runIds: ['r1'], dismissed: false } } }]);
  });

  it('まとめて閉じたときは件数を言う。元に戻すときはトーストを出さない', () => {
    const r = transition(initialState(), store, action({ type: 'interrupted.dismiss', runIds: ['r1', 'r2'], dismissed: true }));
    expect(r.state.toasts[0]?.message).toBe('前回実行中の 2 件を閉じました');
    const back = transition(r.state, store, action({ type: 'interrupted.dismiss', runIds: ['r1', 'r2'], dismissed: false }));
    expect(back.state.toasts).toHaveLength(1);
    expect(back.effects).toEqual([{ kind: 'api.dismissInterrupted', runIds: ['r1', 'r2'], dismissed: false }]);
  });
});

describe('同じファイルの編集から worktree で始める', () => {
  it('そのセッションのプロジェクトで、worktree の札をオンにしたダイアログを開く（名前はダイアログが付ける）', () => {
    const s: Store = { ...store, sessions: { s1: { id: 's1', projectId: 'p1' } as Store['sessions'][string] } };
    const r = transition(initialState(), s, action({ type: 'overlap.worktree', sessionId: 's1' }));
    expect(r.state.overlay).toEqual({ kind: 'newSession', projectId: 'p1', scratch: false, worktree: true });
    expect(r.effects).toContainEqual({ kind: 'focus', target: 'newSessionName' });
  });
});
