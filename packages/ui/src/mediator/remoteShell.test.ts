import { describe, expect, it } from 'vitest';
import type { RemoteTabDto } from '@agent-hangar/shared';
import { initialStore } from '../store/store.ts';
import { initialState, transition, type State } from './transition.ts';
import type { Input } from './types.ts';
import { defaultSessionView, persistedSessionView } from './sessionView.ts';

const tab = (over: Partial<RemoteTabDto> = {}): RemoteTabDto => ({ id: 'r1', sessionId: 's1', deviceId: 'd2', title: 'シェル', createdAt: 10, ...over });
const onSession = (): State => ({ ...initialState(), screen: { name: 'session', id: 's1' } as State['screen'] });
const store = () => ({ ...initialStore(), remoteTabs: { r1: tab() } });
const act = (a: unknown): Input => ({ kind: 'action', action: a as never });

describe('mediator: SSH のシェルタブ', () => {
  it('peerTab の既定は null（チャット本体）で、保存する形に含まれる', () => {
    expect(defaultSessionView().peerTab).toBeNull();
    expect(persistedSessionView({ ...defaultSessionView(), peerTab: 'r1' }).peerTab).toBe('r1');
  });

  it('tab.open の remote は POST の効果にする', () => {
    const r = transition(onSession(), store(), act({ type: 'tab.open', sessionId: 's1', kind: 'remote' }));
    expect(r.effects).toEqual([{ kind: 'api.openRemoteTab', sessionId: 's1' }]);
  });

  it('開けたら（remoteTab.opened）そのタブを選んでつなぐ', () => {
    const r = transition(onSession(), store(), { kind: 'runtime', event: { type: 'remoteTab.opened', tab: tab() } } as never);
    expect(r.state.sessionView.s1?.peerTab).toBe('r1');
    expect(r.effects).toContainEqual({ kind: 'terminal.connect', sessionId: 's1', tabId: 'r1' });
    expect(r.effects).toContainEqual({ kind: 'focus', target: 'terminal' });
  });

  it('開いた会話の画面を離れていたら選ばない', () => {
    const r = transition(initialState(), store(), { kind: 'runtime', event: { type: 'remoteTab.opened', tab: tab() } } as never);
    expect(r.state.sessionView.s1?.peerTab ?? null).toBeNull();
    expect(r.effects.some((e) => e.kind === 'terminal.connect')).toBe(false);
  });

  it('tab.select は remote のタブを peerTab にして、remote.select の null でチャット本体へ戻す', () => {
    const a = transition(onSession(), store(), act({ type: 'tab.select', tabId: 'r1' }));
    expect(a.state.sessionView.s1?.peerTab).toBe('r1');
    expect(a.effects).toContainEqual({ kind: 'terminal.connect', sessionId: 's1', tabId: 'r1' });
    const b = transition(a.state, store(), act({ type: 'remote.select', tabId: null }));
    expect(b.state.sessionView.s1?.peerTab).toBeNull();
  });

  it('tab.close の remote は DELETE の効果にする（⌘W も同じ口）', () => {
    const r = transition(onSession(), store(), act({ type: 'tab.close', tabId: 'r1' }));
    expect(r.effects).toEqual([{ kind: 'api.closeRemoteTab', tabId: 'r1' }]);
  });

  it('remoteTab.closed が届いたら、選んでいた画面は本体へ戻り、つなぎを切る', () => {
    const sel = transition(onSession(), store(), act({ type: 'remote.select', tabId: 'r1' })).state;
    const r = transition(sel, { ...initialStore() }, { kind: 'server', event: { type: 'remoteTab.closed', id: 'r1' } });
    expect(r.state.sessionView.s1?.peerTab).toBeNull();
    expect(r.effects).toContainEqual({ kind: 'terminal.disconnect', tabId: 'r1' });
  });

  it('住所の上書きは PUT の効果にし、つなぎ直す先のタブを添えられる', () => {
    const r = transition(onSession(), store(), act({ type: 'remote.sshHost', deviceId: 'd2', host: 'win', retryTabId: 'r1' }));
    expect(r.effects).toEqual([{ kind: 'api.putSshHost', deviceId: 'd2', host: 'win', retryTabId: 'r1' }]);
    const c = transition(onSession(), store(), act({ type: 'remote.sshHost', deviceId: 'd2', host: null }));
    expect(c.effects).toEqual([{ kind: 'api.putSshHost', deviceId: 'd2', host: null }]);
  });

  it('remote.retry はつなぎ直しの効果になる', () => {
    expect(transition(onSession(), store(), act({ type: 'remote.retry', tabId: 'r1' })).effects).toEqual([{ kind: 'terminal.retry', tabId: 'r1' }]);
  });
});
