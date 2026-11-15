import { describe, expect, it } from 'vitest';
import { translator, type LiveSessionDto, type SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentOrchestratorNav } from './orchestrator.ts';
import { presentHome } from './home.ts';
import { presentShell } from './shell.ts';

const ja = translator('ja');
const NOW = 1_800_000_000_000;
const sess = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', projectId: null, name: `name-${id}`, cwd: '/w', live: 'busy', startedAt: NOW - 1000, lastActivityAt: NOW, unread: null, state: null, stats: { turns: 1, contextPercent: 10 }, ...over }) as SessionDto;
const live = (id: string, status: LiveSessionDto['status']): LiveSessionDto => ({ sessionId: id, status, name: null, nameSource: null, cwd: '/w', pid: 1 });

function store(over: { enabled?: boolean; sessionId?: string | null; status?: LiveSessionDto['status'] | null; unread?: number } = {}): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.settings = { orchestrator: { enabled: over.enabled ?? true, sessionId: over.sessionId === undefined ? 'o1' : over.sessionId, model: 'sonnet', effort: 'medium' } } as Store['settings'];
  const status = over.status === undefined ? 'idle' : over.status;
  s.live = status === null ? [] : [live('o1', status)];
  s.sessions = { o1: sess('o1', { role: 'orchestrator', live: status, unread: over.unread ? { count: over.unread, at: 1 } : null } as Partial<SessionDto>), a: sess('a') };
  return s;
}

describe('presentOrchestratorNav', () => {
  it('無効か会話が無ければ行を出さない', () => {
    expect(presentOrchestratorNav(store({ enabled: false }), ja)).toBeNull();
    expect(presentOrchestratorNav(store({ sessionId: null }), ja)).toBeNull();
  });
  it('ラベルと tone。止まっていれば ended', () => {
    expect(presentOrchestratorNav(store({ status: 'busy' }), ja)).toMatchObject({ label: '統括', tone: 'busy', count: 0 });
    expect(presentOrchestratorNav(store({ status: null }), ja)!.tone).toBe('ended');
  });
  it('数は、判断待ちの 1 と未読の数の和', () => {
    expect(presentOrchestratorNav(store({ status: 'waiting', unread: 2 }), ja)).toMatchObject({ tone: 'waiting', waiting: 1, unread: 2, count: 3 });
    expect(presentOrchestratorNav(store({ status: 'idle', unread: 2 }), ja)).toMatchObject({ waiting: 0, unread: 2, count: 2 });
  });
  it('presentShell が orchNav を渡す', () => {
    expect(presentShell(initialState(), store(), NOW).orchNav).toMatchObject({ label: '統括' });
    expect(presentShell(initialState(), store({ enabled: false }), NOW).orchNav).toBeNull();
  });
});

describe('統括の会話を一覧から外す', () => {
  it('サイドバーの実行中のまとまりに出さない', () => {
    const state = { ...initialState(), screen: { name: 'projects' as const } };
    const shown = presentShell(state, store({ status: 'busy' }), NOW).live;
    expect(shown.rows.map((r) => r.id)).toEqual(['a']);
    expect(shown.ids).toEqual(['a']);
    const pinned = store({ status: 'busy' });
    pinned.sessions.o1!.pinnedAt = 5;
    expect(presentShell(state, pinned, NOW).live.pins).toEqual([]);
  });
  it('ホームのナビの数に統括の判断待ちと未読を数えない（統括の行で数える）', () => {
    const s = store({ status: 'waiting', unread: 2 });
    s.sessions.a = sess('a', { unread: { count: 1, at: 1 } } as Partial<SessionDto>);
    const home = presentShell(initialState(), s, NOW).nav.find((n) => n.route.name === 'home')!;
    expect(home).toMatchObject({ waiting: 0, unread: 1, count: 1 });
  });
  it('ホームの一覧に出さない', () => {
    const h = JSON.stringify(presentHome(initialState(), store({ status: 'waiting', unread: 1 }), NOW));
    expect(h).not.toContain('name-o1');
    expect(h).toContain('name-a');
  });
});
