import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { openDb, type Db } from './open.ts';
import { softDeleteShared, upsertShared } from './shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { assignSessions, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_BETA, SESSION_OTHER } from '../../test/fixtures.ts';
import { proposeSessionState, rejectSessionState, setSessionState } from '../sessions/states.ts';
import { LOCK_STALE_MS, displayName, getProject, getSession, listDevices, listProjects, listSessions } from './queries.ts';

let dir: string;
let db: Db;
const live: LiveSessionDto[] = [
  { sessionId: SESSION_ALPHA, status: 'waiting', name: 'renamed', nameSource: 'user', cwd: '/Users/me/workspace/alpha', pid: 1 },
];

beforeEach(async () => {
  dir = copyFixtureClaudeDir();
  db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: '/Users/me/workspace/alpha', resolved: 1 }, 'd');
  assignSessions(db, 'd');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('listSessions', () => {
  it('新しい順に、要約と統計と実行状態を付けて返す', () => {
    const list = listSessions(db, live);
    expect(list.map((s) => s.providerSessionId)).toEqual([SESSION_BETA, SESSION_ALPHA, SESSION_OTHER]);
    const alpha = list[1]!;
    expect(alpha).toMatchObject({ projectId: 'p1', name: 'renamed', live: 'waiting', hasTranscript: true, cwd: '/Users/me/workspace/alpha' });
    expect(alpha.summary).toMatchObject({ title: '動画チャンネルの整理', source: 'baseline' });
    expect(alpha.stats).toMatchObject({ turns: 2, model: 'claude-fable-5-1', effort: 'high', filesChanged: 1, prUrl: 'https://github.com/me/alpha/pull/12' });
    const beta = list[0]!;
    expect(beta).toMatchObject({ hasTranscript: false, live: null, name: 'beta の README を書いて', projectId: null });
  });

  it('裏だけ動いている印を、登録から写す', () => {
    const aside = { shell: true, agents: 0 };
    const list = listSessions(db, [{ sessionId: SESSION_ALPHA, status: 'busy', name: null, nameSource: null, cwd: '/Users/me/workspace/alpha', pid: 1, aside }]);
    expect(list.find((s) => s.providerSessionId === SESSION_ALPHA)).toMatchObject({ live: 'busy', liveAside: aside });
    expect(list.find((s) => s.providerSessionId === SESSION_BETA)!.liveAside).toBeNull();
    expect(listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!.liveAside).toBeNull();
  });

  it('projectId と ids で絞る', () => {
    expect(listSessions(db, live, { projectId: 'p1' })).toHaveLength(1);
    const id = listSessions(db, live)[0]!.id;
    expect(listSessions(db, live, { ids: [id] }).map((s) => s.id)).toEqual([id]);
    expect(listSessions(db, live, { ids: [] })).toEqual([]);
  });

  it('論理削除したセッションは返さない', () => {
    const alpha = listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!;
    db.prepare('update sessions set deleted_at = ? where id = ?').run(Date.now(), alpha.id);
    expect(listSessions(db, live).map((s) => s.providerSessionId)).toEqual([SESSION_BETA, SESSION_OTHER]);
  });
});

describe('getSession', () => {
  it('無ければ null', () => {
    expect(getSession(db, live, 'nope')).toBeNull();
  });

  it('あれば listSessions と同じ形で返す', () => {
    const alpha = listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!;
    expect(getSession(db, live, alpha.id)).toEqual(alpha);
  });

  it('transcriptMtime は、この PC の主線の本文の更新時刻だけを見る', () => {
    const alpha = listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!;
    db.prepare('update transcript_files set mtime = 1234 where session_id = ? and agent_id is null').run(alpha.id);
    db.prepare('update transcript_files set mtime = 9999 where session_id = ? and agent_id is not null').run(alpha.id);
    db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version, device_id) values (?, ?, null, 1, 5555, 1, 1, ?)').run('/remote/x.jsonl', alpha.id, 'x');
    expect(getSession(db, live, alpha.id)!.transcriptMtime).toBe(1234);
    db.prepare('delete from transcript_files where session_id = ?').run(alpha.id);
    expect(getSession(db, live, alpha.id)!.transcriptMtime).toBeNull();
  });
});

describe('displayName', () => {
  it('利用者が付けた名前、hangar の名前、ai-title、最初の発言の順', () => {
    const l = (nameSource: string): LiveSessionDto => ({ sessionId: 'x', status: 'idle', name: 'L', nameSource, cwd: '', pid: 1 });
    expect(displayName({ name: 'N', ai_title: 'T', first_prompt: 'P' }, l('user'))).toBe('L');
    expect(displayName({ name: 'N', ai_title: 'T', first_prompt: 'P' }, l('derived'))).toBe('N');
    expect(displayName({ name: null, ai_title: 'T', first_prompt: 'P' }, undefined)).toBe('T');
    expect(displayName({ name: null, ai_title: null, first_prompt: 'あ'.repeat(50) }, undefined)).toBe('あ'.repeat(40));
    expect(displayName({ name: null, ai_title: null, first_prompt: null }, undefined)).toBeNull();
  });
});

describe('listProjects', () => {
  it('パス、最終活動、実行中の数を付ける', () => {
    const [p] = listProjects(db, 'd', live);
    expect(p).toMatchObject({
      id: 'p1', name: 'alpha', status: 'active', isScratch: false,
      path: '/Users/me/workspace/alpha', resolved: true,
      runningCount: 1, openTodoCount: 0, memoHead: null,
      lastActivityAt: Date.parse('2026-09-01T10:04:00.000Z'),
    });
  });

  it('この端末にルートが無いプロジェクトは path が null で resolved が false', () => {
    upsertShared(db, 'projects', { id: 'p2', name: 'remote-only', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'r2', project_id: 'p2', device_id: 'other-device', path: '/elsewhere', resolved: 1 }, 'other-device');
    const p2 = listProjects(db, 'd', live).find((p) => p.id === 'p2')!;
    expect(p2).toMatchObject({ path: null, resolved: false, lastActivityAt: null, runningCount: 0 });
  });

  it('ワークスペース登録と組み合わせて動く', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws-test-'));
    try {
      const beta = path.join(ws, 'beta');
      fs.mkdirSync(beta, { recursive: true });
      upsertShared(db, 'sessions', { id: 'x', provider: 'claude-code', provider_session_id: 'x', cwd: beta, home_device: 'd' }, 'd');
      syncProjectsFromWorkspace(db, 'd', ws);
      expect(listProjects(db, 'd', live).map((p) => p.name).sort()).toEqual(['alpha', 'beta']);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('getProject', () => {
  it('無ければ null、あれば listProjects と同じ形で返す', () => {
    expect(getProject(db, 'd', live, 'nope')).toBeNull();
    expect(getProject(db, 'd', live, 'p1')).toEqual(listProjects(db, 'd', live)[0]);
  });
});

describe('フェーズ 3 の項目', () => {
  it('openTodoCount と memoHead はプロジェクトに付く', () => {
    upsertShared(db, 'todos', { id: 't1', project_id: 'p1', text: 'a', done: 0, position: 1, session_id: null }, 'd');
    upsertShared(db, 'todos', { id: 't2', project_id: 'p1', text: 'b', done: 1, position: 2, session_id: null }, 'd');
    upsertShared(db, 'todos', { id: 't3', project_id: 'p1', text: 'c', done: 0, position: 3, session_id: null }, 'd');
    db.prepare('update todos set deleted_at = 1 where id = ?').run('t3');
    upsertShared(db, 'project_memos', { project_id: 'p1', markdown: '\n\n# 見出し\n本文' }, 'd', 'project_id');
    const p = getProject(db, 'd', live, 'p1')!;
    expect(p.openTodoCount).toBe(1);
    expect(p.memoHead).toBe('# 見出し');
    expect(listProjects(db, 'd', live)[0]).toMatchObject({ openTodoCount: 1, memoHead: '# 見出し' });
  });
  it('statusline の値が stats に乗り、無ければ索引の値', () => {
    const alpha = listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!;
    expect(alpha.stats).toMatchObject({ model: 'claude-fable-5-1', effort: 'high', contextPercent: null, costUsd: null });
    db.prepare('insert into session_live_stats (provider_session_id, model, effort, context_used, context_size, cost_usd, updated_at) values (?,?,?,?,?,?,?)').run(SESSION_ALPHA, 'claude-opus-4-1', 'max', 50_000, 200_000, 0.1234, 1);
    const again = getSession(db, live, alpha.id)!;
    expect(again.stats).toMatchObject({ model: 'claude-opus-4-1', effort: 'max', contextPercent: 25, costUsd: 0.1234 });
  });
  it('cwd がちょうどスクラッチのルートなら fromScratch は偽', () => {
    upsertShared(db, 'projects', { id: 'scratch', name: 'スクラッチ', status: 'active', is_scratch: 1 }, 'd');
    upsertShared(db, 'project_roots', { id: 'rs', project_id: 'scratch', device_id: 'd', path: '/Users/me/.agent-hangar/scratch', resolved: 1 }, 'd');
    const alpha = listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!;
    // スクラッチの起動は必ず <root>/<yyyymmdd-HHmmss> に入るので、ルート自身は下に含めない。
    db.prepare('update sessions set cwd = ? where id = ?').run('/Users/me/.agent-hangar/scratch', alpha.id);
    expect(getSession(db, live, alpha.id)!.fromScratch).toBe(false);
    // 名前がルートで始まるだけの隣のディレクトリも下ではない。
    db.prepare('update sessions set cwd = ? where id = ?').run('/Users/me/.agent-hangar/scratchpad', alpha.id);
    expect(getSession(db, live, alpha.id)!.fromScratch).toBe(false);
  });
  it('別の端末のスクラッチのルートでは fromScratch が反転しない', () => {
    upsertShared(db, 'projects', { id: 'scratch', name: 'スクラッチ', status: 'active', is_scratch: 1 }, 'd');
    upsertShared(db, 'project_roots', { id: 'rs', project_id: 'scratch', device_id: 'd', path: '/Users/me/.agent-hangar/scratch', resolved: 1 }, 'd');
    upsertShared(db, 'projects', { id: 'scratch-other', name: 'スクラッチ', status: 'active', is_scratch: 1 }, 'other');
    upsertShared(db, 'project_roots', { id: 'rs-other', project_id: 'scratch-other', device_id: 'other', path: '/Users/other/.agent-hangar/scratch', resolved: 1 }, 'other');
    // 別の端末のルートの方が新しくても、この端末のセッションの判定には使わない。
    db.prepare('update project_roots set updated_at = ? where id = ?').run(Date.now() + 1000, 'rs-other');
    const alpha = listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!;
    db.prepare('update sessions set cwd = ? where id = ?').run('/Users/me/.agent-hangar/scratch/20260901-100000', alpha.id);
    expect(getSession(db, live, alpha.id)!.fromScratch).toBe(true);
    db.prepare('update sessions set cwd = ? where id = ?').run('/Users/other/.agent-hangar/scratch/20260901-100000', alpha.id);
    expect(getSession(db, live, alpha.id)!.fromScratch).toBe(false);
  });
  it('fromScratch はスクラッチの下にあって別のプロジェクトに属するときだけ真', () => {
    upsertShared(db, 'projects', { id: 'scratch', name: 'スクラッチ', status: 'active', is_scratch: 1 }, 'd');
    upsertShared(db, 'project_roots', { id: 'rs', project_id: 'scratch', device_id: 'd', path: '/Users/me/.agent-hangar/scratch', resolved: 1 }, 'd');
    const alpha = listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!;
    expect(alpha.fromScratch).toBe(false);
    db.prepare('update sessions set cwd = ? where id = ?').run('/Users/me/.agent-hangar/scratch/20260901-100000', alpha.id);
    expect(getSession(db, live, alpha.id)!.fromScratch).toBe(true);
    db.prepare("update sessions set project_id = 'scratch' where id = ?").run(alpha.id);
    expect(getSession(db, live, alpha.id)!.fromScratch).toBe(false);
  });
});

describe('ロックと remoteOnly と端末一覧', () => {
  const NOW = 1_700_000_000_000;
  const setup = (): Db => {
    const d2 = openDb(':memory:');
    upsertShared(d2, 'devices', { id: 'dev-a', name: 'mac', platform: 'darwin', last_seen_at: NOW }, 'dev-a');
    upsertShared(d2, 'devices', { id: 'dev-b', name: 'mini', platform: 'darwin', last_seen_at: NOW - 1000 }, 'dev-b');
    upsertShared(d2, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w/a', home_device: 'dev-b' }, 'dev-b');
    return d2;
  };
  const addRun = (d2: Db, o: { id: string; device: string; heartbeat: number; ended?: number | null }) =>
    upsertShared(d2, 'runs', { id: o.id, session_id: 's1', device_id: o.device, kind: 'start', tmux_name: `hangar-${o.id}`, pid: null, launch_params: '{}', started_at: NOW - 60_000, ended_at: o.ended ?? null, end_reason: o.ended ? 'exited' : null, heartbeat_at: o.heartbeat }, o.device);
  const one = (d2: Db) => listSessions(d2, [], { deviceId: 'dev-a', now: () => NOW })[0]!;

  it('他端末の生きた run をロックとして出し、自端末と終わった run は出さない', () => {
    const d2 = setup();
    expect(one(d2).lock).toBeNull();
    addRun(d2, { id: 'r-old', device: 'dev-b', heartbeat: NOW - 300_000, ended: NOW - 200_000 });
    expect(one(d2).lock).toBeNull();
    addRun(d2, { id: 'r-self', device: 'dev-a', heartbeat: NOW });
    expect(one(d2).lock).toBeNull();
    addRun(d2, { id: 'r-b', device: 'dev-b', heartbeat: NOW - 30_000 });
    expect(one(d2).lock).toEqual({ deviceId: 'dev-b', deviceName: 'mini', runId: 'r-b', heartbeatAt: NOW - 30_000, stale: false });
    expect(getSession(d2, [], 's1', { deviceId: 'dev-a', now: () => NOW })!.lock!.runId).toBe('r-b');
  });

  it('同じ端末に生きた run が複数あれば heartbeat が最新の 1 件を採る', () => {
    const d2 = setup();
    addRun(d2, { id: 'r-b1', device: 'dev-b', heartbeat: NOW - 90_000 });
    addRun(d2, { id: 'r-b2', device: 'dev-b', heartbeat: NOW - 10_000 });
    expect(one(d2).lock).toMatchObject({ runId: 'r-b2', heartbeatAt: NOW - 10_000 });
  });

  it('論理削除した run はロックにしない', () => {
    const d2 = setup();
    addRun(d2, { id: 'r-b', device: 'dev-b', heartbeat: NOW });
    expect(one(d2).lock).not.toBeNull();
    softDeleteShared(d2, 'runs', 'r-b', 'dev-b');
    expect(one(d2).lock).toBeNull();
  });

  it('devices に行が無ければ端末 ID をそのまま名前にする', () => {
    const d2 = setup();
    addRun(d2, { id: 'r-c', device: 'dev-c', heartbeat: NOW });
    expect(one(d2).lock).toMatchObject({ deviceId: 'dev-c', deviceName: 'dev-c' });
  });

  it('heartbeat が 2 分より古ければ stale', () => {
    const d2 = setup();
    addRun(d2, { id: 'r-b', device: 'dev-b', heartbeat: NOW - LOCK_STALE_MS - 1 });
    expect(one(d2).lock).toMatchObject({ stale: true });
    // ちょうど 2 分はまだ stale ではない。
    const d3 = setup();
    addRun(d3, { id: 'r-b', device: 'dev-b', heartbeat: NOW - LOCK_STALE_MS });
    expect(one(d3).lock).toMatchObject({ stale: false });
  });

  it('deviceId を渡さなければロックを計算しない', () => {
    const d2 = setup();
    addRun(d2, { id: 'r-b', device: 'dev-b', heartbeat: NOW });
    expect(listSessions(d2, [])[0]!.lock).toBeNull();
    expect(getSession(d2, [], 's1')!.lock).toBeNull();
  });

  it('写しだけのセッションは hasTranscript が true で remoteOnly も true', () => {
    const d2 = setup();
    const ins = d2.prepare('insert into transcript_files (path, session_id, agent_id, device_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?,?)');
    expect(one(d2)).toMatchObject({ hasTranscript: false, remoteOnly: false });
    ins.run('/h/remote/dev-b/projects/-w-a/u1.jsonl', 's1', null, 'dev-b', 10, 1, 10, 1);
    expect(one(d2)).toMatchObject({ hasTranscript: true, remoteOnly: true });
    ins.run('/h/.claude/projects/-w-a/u1.jsonl', 's1', null, null, 10, 1, 10, 1);
    expect(one(d2)).toMatchObject({ hasTranscript: true, remoteOnly: false });
  });

  it('副エージェントの写しだけでは hasTranscript を立てない', () => {
    const d2 = setup();
    d2.prepare('insert into transcript_files (path, session_id, agent_id, device_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?,?)')
      .run('/h/remote/dev-b/projects/-w-a/sub.jsonl', 's1', 'agent-1', 'dev-b', 10, 1, 10, 1);
    expect(one(d2)).toMatchObject({ hasTranscript: false, remoteOnly: false });
  });

  it('端末一覧は最終確認の新しい順で、自端末に印を付ける', () => {
    const d2 = setup();
    expect(listDevices(d2, 'dev-a')).toEqual([
      { id: 'dev-a', name: 'mac', platform: 'darwin', lastSeenAt: NOW, self: true, shell: null },
      { id: 'dev-b', name: 'mini', platform: 'darwin', lastSeenAt: NOW - 1000, self: false, shell: null },
    ]);
    softDeleteShared(d2, 'devices', 'dev-b', 'dev-a');
    expect(listDevices(d2, 'dev-a').map((d) => d.id)).toEqual(['dev-a']);
  });
  it('端末ごとの包み方の状態を読み、知らない値と古い端末は null にする', () => {
    const d2 = setup();
    d2.prepare("update devices set shell_hook = 'on' where id = 'dev-a'").run();
    d2.prepare("update devices set shell_hook = 'garbage' where id = 'dev-b'").run();
    expect(listDevices(d2, 'dev-a').map((d) => d.shell)).toEqual(['on', null]);
  });

  it('last_seen_at が null の端末は末尾で、同順位は名前順', () => {
    const d2 = setup();
    upsertShared(d2, 'devices', { id: 'dev-z', name: 'zulu', platform: 'linux', last_seen_at: null }, 'dev-z');
    upsertShared(d2, 'devices', { id: 'dev-c', name: 'charlie', platform: 'linux', last_seen_at: null }, 'dev-c');
    expect(listDevices(d2, 'dev-a').map((d) => d.id)).toEqual(['dev-a', 'dev-b', 'dev-c', 'dev-z']);
    expect(listDevices(d2, 'dev-a').find((d) => d.id === 'dev-z')).toMatchObject({ lastSeenAt: null, self: false, shell: null });
  });
});

describe('実行中のセッションの activity', () => {
  const put = () => db.prepare('insert or replace into session_activity (session_id, tool, summary, tool_id, question, updated_at) values (?,?,?,?,?,?)');
  it('実行中なら最後の呼び出しと問いを載せ、実行中でなければ欄ごと載せない', () => {
    const all = listSessions(db, live);
    const alpha = all.find((s) => s.providerSessionId === SESSION_ALPHA)!;
    const beta = all.find((s) => s.providerSessionId === SESSION_BETA)!;
    put().run(alpha.id, 'AskUserQuestion', 'AskUserQuestion', 'q1', 'どちらにしますか？', 1);
    put().run(beta.id, 'Edit', 'b.ts', 't1', null, 1);
    const again = listSessions(db, live);
    expect(again.find((s) => s.id === alpha.id)!.activity).toEqual({ tool: 'AskUserQuestion', summary: 'AskUserQuestion', question: 'どちらにしますか？' });
    expect('activity' in again.find((s) => s.id === beta.id)!).toBe(false);
  });
  it('実行中でも、呼び出しがまだ無ければ null', () => {
    db.prepare('delete from session_activity').run();
    expect(listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!.activity).toBeNull();
  });
});

describe('セッションの状態', () => {
  const alphaId = () => (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  it('行が無ければ null、あれば状態と提案を載せ、rejected_at は載せない', () => {
    expect(getSession(db, [], alphaId())!.state).toBeNull();
    proposeSessionState(db, 'd', alphaId(), { status: 'paused', note: '明日 CPU を見る', returnOn: '2026-10-02', source: 'exit', now: 500 });
    expect(getSession(db, [], alphaId())!.state).toEqual({ status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: { status: 'paused', note: '明日 CPU を見る', returnOn: '2026-10-02', returnTime: null, source: 'exit', at: 500 } });
    rejectSessionState(db, 'd', alphaId(), 600);
    const rejected = getSession(db, [], alphaId())!.state!;
    expect(rejected.candidate).toBeNull();
    expect(Object.keys(rejected)).not.toContain('rejectedAt');
    setSessionState(db, 'd', alphaId(), { status: 'done', note: '直した', setBy: 'conversation', now: 700 });
    expect(listSessions(db, []).find((s) => s.id === alphaId())!.state).toEqual({ status: 'done', note: '直した', returnOn: null, returnTime: null, setBy: 'conversation', setAt: 700, candidate: null });
  });
  it('状態を付けても一覧の件数と並びは変わらない', () => {
    const before = listSessions(db, []).map((s) => s.id);
    setSessionState(db, 'd', alphaId(), { status: 'archived', setBy: 'user' });
    expect(listSessions(db, []).map((s) => s.id)).toEqual(before);
  });
});

describe('区切りを付けて休みのまま残っているセッション（parked）', () => {
  const alphaId = () => (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  // 登録の procStart は UTC の ps の lstart で、秒までしか持たない。
  const PROC_START = 'Fri Oct  2 02:30:05 2026';
  const STARTED = Date.UTC(2026, 9, 2, 2, 30, 5);
  const idle = (o: Partial<LiveSessionDto> = {}): LiveSessionDto[] => [{ sessionId: SESSION_ALPHA, status: 'idle', name: null, nameSource: null, cwd: '/Users/me/workspace/alpha', pid: 1, procStart: PROC_START, ...o }];
  const addRun = (o: { id: string; started: number; ended?: number; reason?: string }) =>
    upsertShared(db, 'runs', { id: o.id, session_id: alphaId(), device_id: 'd', kind: 'start', tmux_name: `hangar-${o.id}`, pid: null, launch_params: '{}', started_at: o.started, ended_at: o.ended ?? null, end_reason: o.reason ?? null, heartbeat_at: o.started }, 'd');

  it('印が付いていて、休みで、プロセスの起動が印より前なら真', () => {
    setSessionState(db, 'd', alphaId(), { status: 'paused', note: '明日見る', returnOn: '2026-10-03', setBy: 'conversation', now: STARTED + 60_000 });
    expect(getSession(db, idle(), alphaId())!.parked).toBe(true);
    expect(listSessions(db, idle()).find((s) => s.id === alphaId())!.parked).toBe(true);
  });
  it('印なし、作業中、入力待ち、動いていないものは偽', () => {
    expect(getSession(db, idle(), alphaId())!.parked).toBe(false);
    setSessionState(db, 'd', alphaId(), { status: 'done', setBy: 'user', now: STARTED + 60_000 });
    expect(getSession(db, idle({ status: 'busy' }), alphaId())!.parked).toBe(false);
    expect(getSession(db, idle({ status: 'waiting' }), alphaId())!.parked).toBe(false);
    expect(getSession(db, [], alphaId())!.parked).toBe(false);
  });
  it('印より後に起動したプロセス（再開したもの）は偽', () => {
    setSessionState(db, 'd', alphaId(), { status: 'paused', note: '明日見る', returnOn: '2026-10-03', setBy: 'user', now: STARTED - 60_000 });
    expect(getSession(db, idle(), alphaId())!.parked).toBe(false);
  });
  it('登録に起動時刻が無ければ、生きた run の始まりで比べる', () => {
    setSessionState(db, 'd', alphaId(), { status: 'paused', note: '明日見る', returnOn: '2026-10-03', setBy: 'user', now: 5000 });
    const noStart = idle();
    delete noStart[0]!.procStart;
    // run も無ければ分からないので偽。
    expect(getSession(db, noStart, alphaId())!.parked).toBe(false);
    addRun({ id: 'r-old', started: 1000, ended: 2000, reason: 'exited' });
    expect(getSession(db, noStart, alphaId())!.parked).toBe(false);
    addRun({ id: 'r-alive', started: 3000 });
    expect(getSession(db, noStart, alphaId())!.parked).toBe(true);
  });
  it('生きた run の始まりは、この端末の run だけを見る。他の端末に残った行で止めない', () => {
    setSessionState(db, 'd', alphaId(), { status: 'paused', note: '明日見る', returnOn: '2026-10-03', setBy: 'user', now: 5000 });
    const noStart = idle();
    delete noStart[0]!.procStart;
    upsertShared(db, 'runs', { id: 'r-other', session_id: alphaId(), device_id: 'other', kind: 'start', tmux_name: 'hangar-r-other', pid: null, launch_params: '{}', started_at: 3000, ended_at: null, end_reason: null, heartbeat_at: 3000 }, 'other');
    expect(getSession(db, noStart, alphaId(), { deviceId: 'd' })!.parked).toBe(false);
    expect(listSessions(db, noStart, { deviceId: 'd' }).find((s) => s.id === alphaId())!.parked).toBe(false);
    addRun({ id: 'r-mine', started: 3000 });
    expect(getSession(db, noStart, alphaId(), { deviceId: 'd' })!.parked).toBe(true);
  });
  it('導入時の一括 Done は偽', () => {
    db.prepare("insert into session_states (session_id, status, set_by, set_at, updated_at, origin_device) values (?, 'done', 'import', ?, ?, 'import')").run(alphaId(), STARTED + 60_000, STARTED + 60_000);
    expect(getSession(db, idle(), alphaId())!.state!.status).toBe('done');
    expect(getSession(db, idle(), alphaId())!.parked).toBe(false);
  });
  it('再開した run が生きていれば、登録に起動時刻が無くても偽', () => {
    setSessionState(db, 'd', alphaId(), { status: 'paused', note: '明日見る', returnOn: '2026-10-03', setBy: 'user', now: 5000 });
    addRun({ id: 'r-resumed', started: 6000 });
    const noStart = idle();
    delete noStart[0]!.procStart;
    expect(getSession(db, noStart, alphaId())!.parked).toBe(false);
  });
});

describe('区切りを付けたので止めたセッション（stoppedByStatus）', () => {
  const alphaId = () => (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  const addRun = (o: { id: string; started: number; ended?: number; reason?: string }) =>
    upsertShared(db, 'runs', { id: o.id, session_id: alphaId(), device_id: 'd', kind: 'start', tmux_name: `hangar-${o.id}`, pid: null, launch_params: '{}', started_at: o.started, ended_at: o.ended ?? null, end_reason: o.reason ?? null, heartbeat_at: o.started }, 'd');

  it('最後の run が parked で終わり、印が残っていれば真', () => {
    setSessionState(db, 'd', alphaId(), { status: 'paused', note: '明日見る', returnOn: '2026-10-03', setBy: 'user', now: 1500 });
    addRun({ id: 'r1', started: 1000, ended: 2000, reason: 'parked' });
    expect(getSession(db, [], alphaId())!.stoppedByStatus).toBe(true);
  });
  it('印が無ければ偽', () => {
    addRun({ id: 'r1', started: 1000, ended: 2000, reason: 'parked' });
    expect(getSession(db, [], alphaId())!.stoppedByStatus).toBe(false);
  });
  it('止めた後に付け直した印では偽。その印のために止めたのではない', () => {
    setSessionState(db, 'd', alphaId(), { status: 'paused', note: '明日見る', returnOn: '2026-10-03', setBy: 'user', now: 1500 });
    addRun({ id: 'r1', started: 1000, ended: 2000, reason: 'parked' });
    setSessionState(db, 'd', alphaId(), { status: null, setBy: 'user', now: 2500 });
    setSessionState(db, 'd', alphaId(), { status: 'done', setBy: 'user', now: 3000 });
    expect(getSession(db, [], alphaId())!.stoppedByStatus).toBe(false);
  });
  it('ほかの理由で終わった run と、その後に起こした run では偽', () => {
    setSessionState(db, 'd', alphaId(), { status: 'done', setBy: 'user', now: 1500 });
    addRun({ id: 'r1', started: 1000, ended: 2000, reason: 'killed' });
    expect(getSession(db, [], alphaId())!.stoppedByStatus).toBe(false);
    addRun({ id: 'r2', started: 3000, ended: 4000, reason: 'parked' });
    expect(getSession(db, [], alphaId())!.stoppedByStatus).toBe(true);
    addRun({ id: 'r3', started: 5000 });
    expect(getSession(db, [], alphaId())!.stoppedByStatus).toBe(false);
  });
});
