import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listPageOf, sortForList, type ServerEvent, type SessionDto, type SessionCountsDto } from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import { listSessions } from '../../db/queries.ts';
import { recordSpawn } from '../../sessions/spawns.ts';
import { proposeSessionState, setSessionState } from '../../sessions/states.ts';
import { sessionCounts } from '../../sessions/counts.ts';
import { Publisher } from '../../events/publisher.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 起動時の取得を絞るための口（RB-12 の段 1）。
// 語が空の /api/search（一覧の形）、rows=1 の行の添え、/api/sessions?ids= と spawnedBy=、件数の集計（sessionCounts）を見る。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let db: Db;
const get = async (p: string) => { const r = await app.request(p, { headers: H }); return { status: r.status, body: await r.json() }; };
const NOW = Date.now();
const MIN = 60_000;

/** 会話の行を足す。 */
function add(id: string, o: { at: number; project?: string | null; provider?: string } = { at: NOW }): void {
  db.prepare('insert into sessions (id, provider, provider_session_id, project_id, cwd, home_device, last_activity_at, updated_at, origin_device) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, o.provider ?? 'claude-code', 'u-' + id, o.project ?? null, '/w', 'd', o.at, 1, 'd');
}

beforeEach(async () => {
  t = await testDeps();
  db = t.db;
  app = createApp(t.deps);
  // 30 件。古いものほど番号が大きい。5 件ごとに Done、7 件ごとに Archived、11 件ごとに Paused。
  for (let i = 0; i < 30; i++) add(`p${String(i).padStart(2, '0')}`, { at: NOW - i * MIN, project: i % 2 === 0 ? t.alphaProjectId() : null, provider: i === 3 ? 'codex' : 'claude-code' });
  for (let i = 0; i < 30; i++) {
    const id = `p${String(i).padStart(2, '0')}`;
    if (i % 7 === 6) setSessionState(db, 'd', id, { status: 'archived', setBy: 'user', now: NOW - i * MIN });
    else if (i % 5 === 4) setSessionState(db, 'd', id, { status: 'done', setBy: 'user', now: NOW - i * MIN });
    else if (i % 11 === 10) setSessionState(db, 'd', id, { status: 'paused', setBy: 'user', now: NOW - i * MIN });
  }
  proposeSessionState(db, 'd', 'p01', { status: 'done', note: '終わった', returnOn: null, source: 'in_session', now: NOW });
  // p02 の子 p12 と、その子 p22。子は根の頁に付いてくる。
  recordSpawn(db, 'd', 'p12', 'p02', NOW);
  recordSpawn(db, 'd', 'p22', 'p12', NOW);
});
afterEach(() => { t.dispose(); });

describe('/api/search の一覧の形（語が空）', () => {
  it('並び、件数、入れ子は shared の listPageOf と同じで、rows=1 で行を添える', async () => {
    const all = listSessions(db, [], { deviceId: 'd' });
    const alive = new Set(t.deps.runs.listAlive().runs.filter((r) => r.endedAt === null).map((r) => r.sessionId));
    const want = listPageOf(all, {}, alive, 0, 10);
    const { status, body } = await get('/api/search?q=&limit=10&rows=1');
    expect(status).toBe(200);
    expect(body.rows).toEqual(want.rows);
    expect(body.total).toBe(want.total);
    expect(body.roots).toBe(want.roots);
    // hits は頁の根だけ。
    expect(body.hits.map((h: { sessionId: string }) => h.sessionId)).toEqual(want.rows.filter((r) => r.depth === 0).map((r) => r.id));
    expect(body.sessions.map((s: SessionDto) => s.id).sort()).toEqual(want.rows.map((r) => r.id).sort());
    // 子は根の下に深さつきで並ぶ。
    const at = body.rows.findIndex((r: { id: string }) => r.id === 'p02');
    expect(body.rows.slice(at, at + 3)).toEqual([{ id: 'p02', depth: 0 }, { id: 'p12', depth: 1 }, { id: 'p22', depth: 2 }]);
  });
  it('頁を送っても、行は抜けも重なりもしない。Archived は status を付けたときだけ出る', async () => {
    const seen: string[] = [];
    for (let offset = 0; ; offset += 7) {
      const { body } = await get(`/api/search?q=&limit=7&offset=${offset}`);
      if (body.hits.length === 0) break;
      seen.push(...body.rows.map((r: { id: string }) => r.id));
    }
    const all = listSessions(db, [], { deviceId: 'd' });
    expect(seen).toHaveLength(new Set(seen).size);
    expect(seen.sort()).toEqual(all.filter((s) => s.state?.status !== 'archived').map((s) => s.id).sort());
    const { body: archived } = await get('/api/search?q=&status=archived&limit=50');
    expect(archived.rows.map((r: { id: string }) => r.id).sort()).toEqual(['p06', 'p13', 'p20', 'p27']);
  });
  it('絞り込み（プロジェクト、期間、状態、提案）が効く。rows を付けなければ行は添えない', async () => {
    const { body: alpha } = await get(`/api/search?q=&projectId=${t.alphaProjectId()}&limit=200`);
    expect(alpha.sessions).toBeUndefined();
    const inAlpha = listSessions(db, [], { deviceId: 'd', projectId: t.alphaProjectId() }).filter((s) => s.state?.status !== 'archived');
    expect(alpha.total).toBe(inAlpha.length);
    const { body: recent } = await get(`/api/search?q=&since=${NOW - 4.5 * MIN}&limit=200`);
    expect(recent.rows.map((r: { id: string }) => r.id)).toEqual(sortForList(listSessions(db, [], { deviceId: 'd', ids: ['p00', 'p01', 'p02', 'p03', 'p04'] })).map((s) => s.id));
    const { body: proposed } = await get('/api/search?q=&status=proposed');
    expect(proposed.rows).toEqual([{ id: 'p01', depth: 0 }]);
  });
  it('語のある検索も rows=1 で当たった会話の行を添える', async () => {
    const { body } = await get('/api/search?q=channels&rows=1');
    expect(body.hits).toHaveLength(1);
    expect(body.sessions.map((s: SessionDto) => s.id)).toEqual([body.hits[0].sessionId]);
    expect(body.rows).toBeUndefined();
  });
});

describe('/api/sessions の ids と spawnedBy', () => {
  it('ids で行をまとめて取る。無い id と消した会話は返らない', async () => {
    db.prepare("update sessions set deleted_at = 5 where id = 'p05'").run();
    const { body } = await get('/api/sessions?ids=p00,p05,nope,p09');
    expect(body.map((s: SessionDto) => s.id).sort()).toEqual(['p00', 'p09']);
  });
  it('spawnedBy で子を取る', async () => {
    expect((await get('/api/sessions?spawnedBy=p02')).body.map((s: SessionDto) => s.id)).toEqual(['p12']);
    expect((await get('/api/sessions?spawnedBy=p12')).body.map((s: SessionDto) => s.id)).toEqual(['p22']);
  });
  it('数を絞らない /api/sessions は今までどおり全件を返す', async () => {
    expect((await get('/api/sessions')).body).toHaveLength(listSessions(db, [], { deviceId: 'd' }).length);
  });
});

describe('件数の集計（sessionCounts）', () => {
  /** 画面が手元の全件から数えていたやり方。 */
  function counted(all: SessionDto[]): Omit<SessionCountsDto, 'retention'> {
    const tab = (f: (s: SessionDto) => boolean) => all.filter(f).length;
    const byProject: SessionCountsDto['byProject'] = {};
    for (const s of all) {
      if (s.projectId === null) continue;
      const p = byProject[s.projectId] ?? (byProject[s.projectId] = { count: 0, archived: 0 });
      p.count++;
      if (s.state?.status === 'archived') p.archived++;
    }
    return {
      total: all.length,
      tabs: { all: tab((s) => s.state?.status !== 'archived'), proposed: tab((s) => !!s.state?.candidate), active: tab((s) => (s.state?.status ?? null) === null), paused: tab((s) => s.state?.status === 'paused'), done: tab((s) => s.state?.status === 'done'), archived: tab((s) => s.state?.status === 'archived') },
      byProject,
      providers: { opencode: all.some((s) => s.provider === 'opencode'), codex: all.some((s) => s.provider === 'codex') },
    };
  }
  it('画面が手元の全件から数えた値と同じになる', () => {
    const { retention: _r, ...got } = sessionCounts(db, { retentionDays: null, now: NOW });
    expect(got).toEqual(counted(listSessions(db, [], { deviceId: 'd' })));
  });
  it('保存期間で近く消える数と、期限を過ぎた数', () => {
    const DAY = 86_400_000;
    const file = (id: string, mtime: number) => db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version) values (?, ?, null, 1, ?, 1, 1)').run('/t/' + id, id, mtime);
    file('p00', NOW - 29 * DAY); // 30 日なら、あと 1 日で消える。
    file('p01', NOW - 31 * DAY); // もう過ぎた（近く消えるにも入る）。
    file('p02', NOW - 10 * DAY);
    const r = sessionCounts(db, { retentionDays: 30, now: NOW }).retention!;
    expect([r.days, r.soon, r.expired]).toEqual([30, 2, 1]);
    // 画面の数え方（isExpiringSoon）と同じ。
    const all = listSessions(db, [], { deviceId: 'd' });
    expect(all.filter((s) => s.transcriptMtime !== null && s.transcriptMtime + 30 * DAY <= NOW + 7 * DAY).length).toBe(r.soon);
  });
  it('/api/session-counts は days で保存期間を変えて数えられる', async () => {
    const { body } = await get('/api/session-counts?days=7');
    expect(body.retention.days).toBe(7);
    expect(body.total).toBe(listSessions(db, [], { deviceId: 'd' }).length);
  });
});

describe('起動時の取得', () => {
  it('sessionCounts と 1 頁目（最近の 50 件）を載せる。sessions はまだ全件のまま', async () => {
    const { body } = await get('/api/bootstrap');
    const all = listSessions(db, [], { deviceId: 'd' });
    expect(body.sessions).toHaveLength(all.length);
    expect(body.sessionCounts.total).toBe(all.length);
    const alive = new Set(t.deps.runs.listAlive().runs.filter((r) => r.endedAt === null).map((r) => r.sessionId));
    expect(body.firstPage).toEqual(listPageOf(all, {}, alive, 0, 50));
  });
});

describe('件数の配信（sessionCounts.update）', () => {
  it('会話の行が変わると、間引いて 1 秒に 1 回まで配る', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const sent: ServerEvent[] = [];
    const publisher = new Publisher({ db, deviceId: 'd', live: () => [], hub: { broadcast: (e) => { sent.push(e); } }, counts: true });
    try {
      const counts = () => sent.filter((e) => e.type === 'sessionCounts.update');
      setSessionState(db, 'd', 'p00', { status: 'done', setBy: 'user' });
      await Promise.resolve(); await Promise.resolve();
      expect(counts()).toHaveLength(1);
      setSessionState(db, 'd', 'p02', { status: 'done', setBy: 'user' });
      await Promise.resolve(); await Promise.resolve();
      setSessionState(db, 'd', 'p03', { status: 'done', setBy: 'user' });
      await Promise.resolve(); await Promise.resolve();
      expect(counts()).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      expect(counts()).toHaveLength(2);
      const last = counts().at(-1) as Extract<ServerEvent, { type: 'sessionCounts.update' }>;
      expect(last.counts.tabs.done).toBe(sessionCounts(db, { retentionDays: null, now: NOW }).tabs.done);
      // 会話でない行（プロジェクト）の変化では数え直さない。
      vi.advanceTimersByTime(5000);
      db.prepare("update projects set name = 'x' where id = ?").run(t.alphaProjectId());
      publisher.flush();
      expect(counts()).toHaveLength(2);
    } finally {
      publisher.stop();
      vi.useRealTimers();
    }
  });
});
