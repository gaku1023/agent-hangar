import { describe, expect, it } from 'vitest';
import { listPageOf, type ListFilter, type SessionDto, type SessionStateDto, type StatusFilter } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { periodStart } from '../mediator/screen.ts';
import type { State } from '../mediator/types.ts';
import { aliveAnywhere, initialStore, type Store } from '../store/store.ts';
import { presentSessionList } from './sessions.ts';
import { sessionDto } from '../test/sessionDto.ts';

// サーバの一覧の形の検索（shared の listPageOf）が、画面が手元の全件から組む一覧（presentSessionList）と同じ並び、同じ件数になることを見張る。
// 食い違うと、画面を頁の取得に切り替えたときに、頁を送ると行が抜けたり重なったりする（RB-12）。

const NOW = Date.parse('2026-11-18T12:00:00Z');
const H = 3_600_000;

/** 決まった種から作る乱数。試験を毎回同じ並びにするため。 */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, returnTime: null, setBy: 'user', setAt: null, candidate: null, ...o });
const base = (id: string, over: Partial<SessionDto>): SessionDto => (sessionDto({ id, providerSessionId: 'u' + id, name: 'name-' + id, cwd: '/w', firstPrompt: 'first', startedAt: NOW - 9 * H, lastActivityAt: NOW - H, hasTranscript: true, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, ...over }));

/** 状態、動き、起動元、時刻、ほかの PC のロックを散らした会話の全件と、生きている run。 */
function world(seed: number, n: number): Store {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const list: SessionDto[] = [];
  for (let i = 0; i < n; i++) {
    const id = `s${String(i).padStart(3, '0')}`;
    const status = pick([null, null, null, 'done', 'done', 'paused', 'archived'] as const);
    const candidate = status === null && r() < 0.1 ? { status: 'done' as const, note: null, returnOn: null, returnTime: null, source: 'in_session' as const, at: NOW - H } : null;
    const state = status === null && candidate === null && r() < 0.7 ? null : st({ status, setAt: NOW - Math.floor(r() * 200) * H, candidate });
    const live = r() < 0.15 ? pick(['busy', 'idle', 'waiting'] as const) : null;
    // 時刻が重なる行も混ぜる（並びの揺れを見るため）。
    const lastActivityAt = r() < 0.1 ? NOW - 5 * H : NOW - Math.floor(r() * 2000) * 60_000;
    const spawnedBy = i > 0 && r() < 0.25 ? list[Math.floor(r() * i)]!.id : null;
    const lock = live === null && r() < 0.05 ? { deviceId: 'pc-b', deviceName: 'B', runId: 'rb' + id, heartbeatAt: NOW, stale: false, live: pick(['busy', 'idle', 'waiting'] as const) } : null;
    const limit = live === 'idle' && r() < 0.3 ? { kind: 'five_hour' as const, resetsAt: NOW + H, auto: false, reset: r() < 0.5 } : null;
    const waitingFor = live === 'waiting' && r() < 0.5 ? ('permission' as const) : null;
    list.push(base(id, { projectId: pick(['alpha', 'beta', null]), state, live, lastActivityAt, spawnedBy, lock, limit, waitingFor, parked: live === 'idle' && status === 'done' && r() < 0.5, woke: r() < 0.05 }));
  }
  // 起動元の輪も 1 つ作る。
  if (n > 3) { list[1] = { ...list[1]!, spawnedBy: list[2]!.id }; list[2] = { ...list[2]!, spawnedBy: list[1]!.id }; }
  const s = initialStore();
  s.bootstrapped = true;
  s.sessions = Object.fromEntries(list.map((x) => [x.id, x]));
  // live の無い会話にも、生きている run を持たせる（起動中）。
  const runIds = list.filter(() => r() < 0.05).map((x) => x.id);
  s.runs = Object.fromEntries(runIds.map((sid, i) => [`r${i}`, { id: `r${i}`, sessionId: sid, deviceId: 'd', kind: 'start', tmuxName: 't', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 } as const]));
  return s;
}

type Case = { status?: StatusFilter; live?: ListFilter['live']; stop?: ListFilter['stop']; days?: number; projectId?: string };
const CASES: Case[] = [
  {}, { status: 'active' }, { status: 'done' }, { status: 'paused' }, { status: 'archived' }, { status: 'proposed' },
  { live: 'running' }, { live: 'waiting' }, { live: 'ended' }, { stop: 'permission' }, { stop: 'limited' },
  { days: 1 }, { projectId: 'alpha' }, { projectId: 'beta', status: 'done' },
];

function screen(c: Case, page: number, size: number): State {
  const s = initialState();
  const { days, ...rest } = c;
  return { ...s, pageSize: size, search: { ...s.search, text: '', page, filter: { ...rest, ...(days ? { days } : {}) } } };
}

describe('一覧の頁はサーバと画面で同じになる', () => {
  for (const seed of [1, 7, 42]) {
    const store = world(seed, 240);
    for (const c of CASES) {
      it(`seed ${seed} の ${JSON.stringify(c)}`, () => {
        const alive = aliveAnywhere(store);
        const f: ListFilter = { projectId: c.projectId, live: c.live, stop: c.stop, status: c.status, ...(c.days ? { since: periodStart(c.days, NOW) } : {}) };
        for (const size of [25, 50]) {
          const first = presentSessionList(screen(c, 1, size), store, NOW);
          const pages = first.pager?.pageCount ?? 1;
          for (let page = 1; page <= pages; page++) {
            const ui = presentSessionList(screen(c, page, size), store, NOW);
            const server = listPageOf(Object.values(store.sessions), f, alive, (page - 1) * size, size);
            expect(server.rows).toEqual(ui.rows.map((r) => ({ id: r.id, depth: r.nest?.depth ?? 0 })));
            expect(server.total).toBe(ui.total);
            if (ui.pager) expect(server.roots).toBe(ui.pager.total);
          }
        }
      });
    }
  }
});

describe('見張りの試験の作り', () => {
  it('頁が 2 枚以上になり、入れ子の子も並ぶ（比べる中身が空にならない）', () => {
    const store = world(1, 240);
    const ui = presentSessionList(screen({}, 1, 25), store, NOW);
    expect(ui.pager?.pageCount ?? 1).toBeGreaterThan(2);
    expect(ui.rows.some((r) => (r.nest?.depth ?? 0) > 0)).toBe(true);
  });
});
