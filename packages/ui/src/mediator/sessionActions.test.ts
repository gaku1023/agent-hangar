import { describe, expect, it } from 'vitest';
import type { SessionDto, SessionLaunchSettingsDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { duplicateOpenAction } from './launch.ts';
import { initialState, transition } from './transition.ts';
import type { Input, State } from './types.ts';

// 右クリックの「未読に戻す」「ピン留めする」「同じ設定で新しいセッション…」の Mediator の試験。

const sess = (id: string, over: Partial<SessionDto> = {}) => ({ id, live: null, lastActivityAt: 1, parked: false, unread: null, projectId: 'p1', provider: 'claude-code', ...over }) as SessionDto;
const storeOf = (list: SessionDto[]): Store => ({ ...initialStore(), sessions: Object.fromEntries(list.map((s) => [s.id, s])), projects: { p1: { id: 'p1', isScratch: false }, q: { id: 'q', isScratch: true } } as unknown as Store['projects'] });
const act = (action: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action });
const hash = (id: string): Input => ({ kind: 'runtime', event: { type: 'hash.changed', route: { name: 'session', id } } });
const seens = (effects: { kind: string }[]) => effects.filter((e) => e.kind === 'api.markSeen');
const unread = { count: 1, latest: null, at: 500 };

describe('ピン留め', () => {
  it('session.pin は api.setPinned を出す', () => {
    const r = transition(initialState(), storeOf([sess('a')]), act({ type: 'session.pin', id: 'a', pinned: true }));
    expect(r.effects).toContainEqual({ kind: 'api.setPinned', id: 'a', pinned: true });
  });
});

describe('未読に戻す', () => {
  it('開いていない会話は、送るだけで印を付けない', () => {
    const r = transition(initialState(), storeOf([sess('a')]), act({ type: 'session.unread.mark', id: 'a' }));
    expect(r.effects).toContainEqual({ kind: 'api.markUnread', id: 'a' });
    expect(r.state.unreadKept).toBeNull();
  });
  it('開いている会話でも、戻した未読をすぐ既読にしない', () => {
    const open: State = transition(initialState(), storeOf([sess('a')]), hash('a')).state;
    const r = transition(open, storeOf([sess('a')]), act({ type: 'session.unread.mark', id: 'a' }));
    expect(r.state.unreadKept).toBe('a');
    const arrived = transition(r.state, storeOf([sess('a', { unread })]), { kind: 'store' });
    expect(seens(arrived.effects)).toEqual([]);
  });
  it('離れて開き直すと既読にする', () => {
    const store = storeOf([sess('a', { unread }), sess('b')]);
    const open = transition(initialState(), storeOf([sess('a'), sess('b')]), hash('a')).state;
    const kept = transition(open, storeOf([sess('a'), sess('b')]), act({ type: 'session.unread.mark', id: 'a' })).state;
    const away = transition(kept, store, hash('b'));
    expect(away.state.unreadKept).toBeNull();
    expect(seens(transition(away.state, store, hash('a')).effects)).toEqual([{ kind: 'api.markSeen', sessionId: 'a' }]);
  });
});

describe('同じ設定で新しいセッション', () => {
  const settings: SessionLaunchSettingsDto = { agent: 'claude-code', model: 'opus', effort: 'high', permissionMode: 'plan', mode: null, addDirs: ['/x'], account: 'a1' };
  it('session.duplicate は設定を読みに行くだけで、起動しない', () => {
    const r = transition(initialState(), storeOf([sess('a')]), act({ type: 'session.duplicate', id: 'a' }));
    expect(r.effects).toEqual([{ kind: 'api.loadDuplicate', id: 'a' }]);
  });
  it('プロジェクトと設定を種に入れたダイアログを開く。本文は空', () => {
    expect(duplicateOpenAction(storeOf([sess('a')]), 'a', settings)).toEqual({ type: 'session.new.open', projectId: 'p1', seed: { request: '', quote: '', accounts: { 'claude-code': 'a1' }, settings: { agent: 'claude-code', model: 'opus', effort: 'high', permissionMode: 'plan', mode: null, addDirs: ['/x'] } } });
  });
  it('本文があり止まっている Claude Code の会話は、続きからの札（名前と直近の発言）を種に持つ', () => {
    const base = { hasTranscript: true, lock: null, remoteOnly: false, name: 'ログイン画面の直し', summary: { oneLiner: '次の PR で直します' } } as Partial<SessionDto>;
    expect(duplicateOpenAction(storeOf([sess('a', base)]), 'a', settings).seed?.fork).toEqual({ sessionId: 'a', name: 'ログイン画面の直し', last: '次の PR で直します' });
    expect(duplicateOpenAction(storeOf([sess('a', { ...base, summary: null })]), 'a', settings).seed?.fork).toEqual({ sessionId: 'a', name: 'ログイン画面の直し', last: null });
  });
  it('本文が無い、動いている、ロックされている、ほかの PC だけにある、Claude Code でない会話には持たない', () => {
    const base = { hasTranscript: true, lock: null, remoteOnly: false, name: 'x' } as Partial<SessionDto>;
    const seedFork = (over: Partial<SessionDto>, st = settings) => duplicateOpenAction(storeOf([sess('a', { ...base, ...over })]), 'a', st).seed?.fork;
    expect(seedFork({ hasTranscript: false })).toBeUndefined();
    expect(seedFork({ live: 'busy' })).toBeUndefined();
    expect(seedFork({ lock: { deviceName: 'pc' } as SessionDto['lock'] })).toBeUndefined();
    expect(seedFork({ remoteOnly: true })).toBeUndefined();
    expect(seedFork({}, { ...settings, agent: 'codex' })).toBeUndefined();
    expect(seedFork({}, { ...settings, agent: 'opencode' })).toBeUndefined();
  });
  it('クイックセッションと未分類はクイックセッションで開く。Codex のアカウントは Codex の札へ', () => {
    const codex = { ...settings, agent: 'codex' as const };
    expect(duplicateOpenAction(storeOf([sess('a', { projectId: 'q' })]), 'a', codex)).toMatchObject({ scratch: true, seed: { accounts: { codex: 'a1' } } });
    expect(duplicateOpenAction(storeOf([sess('a', { projectId: null })]), 'a', { ...settings, account: null })).toMatchObject({ scratch: true, seed: { accounts: {} } });
  });
});
