import { describe, expect, it } from 'vitest';
import type { RunDto, SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentHome } from './home.ts';
import { presentPalette } from './palette.ts';
import { presentSessionRow } from './row.ts';
import { presentSession } from './session.ts';
import { presentShell } from './shell.ts';

// 本体は入力を受け付けていて、裏の Bash だけが動いているセッション（Claude の登録の status が shell）。
const NOW = Date.parse('2026-10-07T12:00:00Z');
const ASIDE = { shell: true, agents: 0 };
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: null, name: 'name-' + id, cwd: '/w', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 180_000, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, ...over });
const run = (id: string, sessionId: string): RunDto => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: null, startedAt: NOW - 60_000, endedAt: null, endReason: null, heartbeatAt: 1 });

function storeWith(): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.sessions = {
    a: session('a', { live: 'busy', liveAside: ASIDE, activity: { tool: 'Bash', summary: 'npm run build', question: null } }),
    b: session('b', { live: 'busy', activity: { tool: 'Edit', summary: 'x.ts', question: null } }),
  };
  s.runs = { r1: run('r1', 'a') };
  return s;
}

describe('裏だけ動いているセッションの見せ方', () => {
  it('サイドバーの行は、丸を裏だけにし、短い語を添える。止めるときは作業中として確かめる', () => {
    const rows = presentShell(initialState(), storeWith(), NOW).live.rows;
    expect(rows.find((r) => r.id === 'a')).toMatchObject({ live: 'busy', aside: '裏', waited: null, stop: { runId: 'r1', working: true, aside: true } });
    expect(rows.find((r) => r.id === 'b')).toMatchObject({ live: 'busy', aside: null });
  });
  it('一覧の行とパレットの丸も裏だけにする', () => {
    const store = storeWith();
    expect(presentSessionRow(store.sessions.a!, store, NOW)).toMatchObject({ live: 'busy', aside: true });
    expect(presentSessionRow(store.sessions.b!, store, NOW)).toMatchObject({ live: 'busy', aside: false });
    const items = presentPalette({ ...initialState(), overlay: { kind: 'palette' } }, store, 'name-a', NOW)!.sections.flatMap((s) => s.items);
    expect(items.find((i) => i.id === 'session:a')).toMatchObject({ lead: { kind: 'dot', live: 'busy', aside: true }, meta: '裏で作業中 3 分' });
  });
  it('ホームの札は、いまの手を出さず、指揮役が空いていることを言う', () => {
    const card = presentHome(initialState(), storeWith(), NOW).running.find((c) => c.id === 'a');
    expect(card).toMatchObject({ live: 'busy', aside: true, activity: null, intent: null, note: '裏でシェルが動いている。指揮役は空いている' });
  });
  it('セッション画面の見出しは「裏で作業中」と最後の返答からの長さ、灯は裏だけの色', () => {
    const p = presentSession(initialState(), storeWith(), NOW, 'a');
    expect(p).toMatchObject({ live: 'busy', aside: true, liveLabel: '裏で作業中 3 分' });
    expect(p.livePane?.lamp).toEqual({ tone: 'aside', head: '裏でシェルが動いている', sub: '指揮役は空いている' });
  });
});
