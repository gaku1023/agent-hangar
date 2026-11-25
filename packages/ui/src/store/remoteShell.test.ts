import { describe, expect, it } from 'vitest';
import type { BootstrapDto, RemoteTabDto, RunDto } from '@agent-hangar/shared';
import { applyBootstrap, applyServerEvent, initialStore, tabAlive } from './store.ts';
import { remoteTabsOf, staleRemoteTabs } from './remoteShell.ts';
import { sessionDto } from '../test/sessionDto.ts';

const tab = (over: Partial<RemoteTabDto> = {}): RemoteTabDto => ({ id: 'r1', sessionId: 's1', deviceId: 'd2', title: 'シェル', createdAt: 10, ...over });
const emptyBootstrap = { projects: [], sessions: [], runs: [], tabs: [], todos: [], artifacts: [], summaryPending: [], deleteApprovals: [] };

describe('store: SSH のシェルタブ', () => {
  it('bootstrap で remoteTabs と remoteHosts を置き換え、無い古いサーバでは空になる', () => {
    const base = { ...initialStore(), remoteTabs: { old: tab({ id: 'old' }) }, remoteHosts: { d9: 'x' } };
    const got = applyBootstrap(base, { ...emptyBootstrap, remoteTabs: [tab()], remoteHosts: { d2: 'win' } } as unknown as BootstrapDto);
    expect(got.remoteTabs).toEqual({ r1: tab() });
    expect(got.remoteHosts).toEqual({ d2: 'win' });
    const old = applyBootstrap(base, emptyBootstrap as unknown as BootstrapDto);
    expect(old.remoteTabs).toEqual({});
    expect(old.remoteHosts).toEqual({});
  });

  it('出来事で増減する（upsert、closed、host の設定と解除）', () => {
    let s = applyServerEvent(initialStore(), { type: 'remoteTab.upsert', tab: tab() });
    expect(Object.keys(s.remoteTabs)).toEqual(['r1']);
    expect(applyServerEvent(s, { type: 'remoteTab.upsert', tab: tab() })).toBe(s);
    s = applyServerEvent(s, { type: 'remoteHost.changed', deviceId: 'd2', host: 'win' });
    expect(s.remoteHosts).toEqual({ d2: 'win' });
    s = applyServerEvent(s, { type: 'remoteHost.changed', deviceId: 'd2', host: null });
    expect(s.remoteHosts).toEqual({});
    s = applyServerEvent(s, { type: 'remoteTab.closed', id: 'r1' });
    expect(s.remoteTabs).toEqual({});
    expect(applyServerEvent(s, { type: 'remoteTab.closed', id: 'r1' })).toBe(s);
  });

  it('remoteTabsOf は会話のタブを作った順に返し、tabAlive は開いている間だけ真', () => {
    const s = { ...initialStore(), remoteTabs: { b: tab({ id: 'b', createdAt: 20 }), a: tab({ id: 'a', createdAt: 10 }), z: tab({ id: 'z', sessionId: 's2' }) } };
    expect(remoteTabsOf(s, 's1').map((t) => t.id)).toEqual(['a', 'b']);
    expect(tabAlive(s, 'a')).toBe(true);
    expect(tabAlive(s, 'none')).toBe(false);
  });
});

describe('staleRemoteTabs（Q5：この PC で再開、または別 PC で終わった）', () => {
  const locked = sessionDto({ id: 's1', lock: { deviceId: 'd2', deviceName: 'B', runId: null, at: 1 } as never });
  const withTab = (sessions = { s1: locked }) => ({ ...initialStore(), device: { id: 'd1', name: 'A' }, sessions, remoteTabs: { r1: tab(), r2: tab({ id: 'r2', sessionId: 's9' }) } });
  const run = (over: Partial<RunDto> = {}) => ({ id: 'run1', sessionId: 's1', deviceId: 'd1', endedAt: null, ...over }) as RunDto;

  it('この PC で run が始まったら、その会話のタブだけ返す', () => {
    const before = withTab();
    const ev = { type: 'run.started', run: run(), tabs: [] } as never;
    expect(staleRemoteTabs(before, applyServerEvent(before, ev), ev)).toEqual(['r1']);
  });

  it('別の PC の run の開始では返さない', () => {
    const before = withTab();
    const ev = { type: 'run.started', run: run({ deviceId: 'd2' }), tabs: [] } as never;
    expect(staleRemoteTabs(before, applyServerEvent(before, ev), ev)).toEqual([]);
  });

  it('lock が外れた（別 PC で終わった）ら返し、元から lock の無い会話では返さない', () => {
    const before = withTab();
    const ev = { type: 'session.upsert', session: { ...locked, lock: null } } as never;
    expect(staleRemoteTabs(before, applyServerEvent(before, ev), ev)).toEqual(['r1']);
    const free = withTab({ s1: { ...locked, lock: null } });
    const ev2 = { type: 'session.upsert', session: { ...locked, lock: null, name: 'x' } } as never;
    expect(staleRemoteTabs(free, applyServerEvent(free, ev2), ev2)).toEqual([]);
  });

  it('関係の無い出来事では返さない', () => {
    const before = withTab();
    const ev = { type: 'ready', version: '1' } as never;
    expect(staleRemoteTabs(before, applyServerEvent(before, ev), ev)).toEqual([]);
  });
});
