import { describe, expect, it } from 'vitest';
import type { BootstrapDto, SessionDto } from '@agent-hangar/shared';
import { applyBootstrap, applyEventsPage, applyServerEvent, eventsKey, initialStore } from './store.ts';

const session = (id: string, psid: string): SessionDto => ({ id, provider: 'claude-code', providerSessionId: psid, projectId: null, name: id, cwd: '/x', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0 } });
const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null }, projects: [], sessions: [session('s1', 'u1')], live: [], runs: [], tabs: [], index: { phase: 'idle', done: 0, total: 0 }, version: '0' };

describe('store', () => {
  it('bootstrap を正規化して入れる', () => {
    const s = applyBootstrap(initialStore(), boot);
    expect(s.bootstrapped).toBe(true);
    expect(s.sessions.s1?.name).toBe('s1');
    expect(s.device).toEqual({ id: 'd', name: 'mac' });
  });
  it('session.upsert は差し替え、live.update は各セッションの live を引き直す', () => {
    let s = applyBootstrap(initialStore(), boot);
    s = applyServerEvent(s, { type: 'session.upsert', session: { ...session('s1', 'u1'), name: 'renamed' } });
    expect(s.sessions.s1?.name).toBe('renamed');
    s = applyServerEvent(s, { type: 'live.update', live: [{ sessionId: 'u1', status: 'busy', name: null, nameSource: null, cwd: '/x', pid: 1 }] });
    expect(s.sessions.s1?.live).toBe('busy');
    s = applyServerEvent(s, { type: 'live.update', live: [] });
    expect(s.sessions.s1?.live).toBeNull();
  });
  it('関係ないイベントは同じ参照を返す', () => {
    const s = applyBootstrap(initialStore(), boot);
    expect(applyServerEvent(s, { type: 'toast', level: 'info', message: 'x' })).toBe(s);
  });
  it('events のページを追記できる', () => {
    let s = initialStore();
    const k = eventsKey('s1', null);
    s = applyEventsPage(s, k, { sessionId: 's1', events: [{ kind: 'user', seq: 0, text: 'a' }], total: 2, nextSeq: 1 }, false);
    s = applyEventsPage(s, k, { sessionId: 's1', events: [{ kind: 'assistant', seq: 1, text: 'b' }], total: 2, nextSeq: null }, true);
    expect(s.events[k]?.items.map((e) => e.seq)).toEqual([0, 1]);
    expect(s.events[k]?.nextSeq).toBeNull();
    // 同じ seq が重なって届いても増えない
    s = applyEventsPage(s, k, { sessionId: 's1', events: [{ kind: 'assistant', seq: 1, text: 'b' }], total: 2, nextSeq: null }, true);
    expect(s.events[k]?.items).toHaveLength(2);
  });
  it('transcript.appended は該当セッションの events を再読込対象にする', () => {
    let s = applyEventsPage(initialStore(), eventsKey('s1', null), { sessionId: 's1', events: [], total: 0, nextSeq: null }, false);
    s = applyServerEvent(s, { type: 'transcript.appended', sessionId: 's1', count: 1 });
    expect(s.events[eventsKey('s1', null)]?.total).toBe(1);
  });
});
