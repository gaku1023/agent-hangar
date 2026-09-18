import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shortId } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { readArgs, writeFakeClaude } from '../../test/fake-claude.ts';
import { TMUX, testSocketName, waitFor } from '../../test/tmux.ts';
import { Tmux } from '../tmux/tmux.ts';
import { RunError, RunManager } from './manager.ts';

let db: Db;
let home: string;
let cwd: string;
let fake: { bin: string; argsFile: string };
let tmux: Tmux | null;

beforeEach(() => {
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-cwd-'));
  fake = writeFakeClaude(home);
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'pr1', project_id: 'p1', device_id: 'd', path: cwd, resolved: 1 }, 'd');
  upsertShared(db, 'projects', { id: 'p2', name: 'lost', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'pr2', project_id: 'p2', device_id: 'd', path: '/nonexistent', resolved: 0 }, 'd');
  tmux = TMUX ? new Tmux({ tmuxPath: TMUX, socketName: testSocketName() }) : null;
});
afterEach(() => {
  tmux?.killServer();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const make = (over: Partial<ConstructorParameters<typeof RunManager>[0]> = {}) =>
  new RunManager({ db, deviceId: 'd', home, tmux, claudeBin: fake.bin, port: 4177, token: 'tok', shell: 'sh', ...over });

/** 偽の claude が記録した引数を待って読む。最後の要素は HANGAR_RUN_ID の値である。 */
const launchedArgs = async (runId: string) => {
  await waitFor(() => fs.existsSync(fake.argsFile) && readArgs(fake.argsFile).at(-1) === runId);
  return readArgs(fake.argsFile);
};

describe('RunManager.start の入力検査（tmux 不要）', () => {
  it('scratch、projectId 無し、無いプロジェクト、未解決のプロジェクトを拒む', () => {
    const rm = make({ tmux: null });
    expect(() => rm.start({ scratch: true })).toThrow(RunError);
    expect(() => rm.start({})).toThrow(/projectId/);
    expect(() => rm.start({ projectId: 'nope' })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => rm.start({ projectId: 'p2' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => rm.start({ projectId: 'p1' })).toThrow(/tmux/);
    expect(db.prepare('select count(*) c from sessions').get()).toEqual({ c: 0 });
    expect(db.prepare('select count(*) c from runs').get()).toEqual({ c: 0 });
  });
});

describe.skipIf(!TMUX)('RunManager.start（tmux 上）', () => {
  it('sessions 行と runs 行を作り、ラッパー経由で起動し、status off にする', async () => {
    const rm = make();
    const started: unknown[] = [];
    rm.on({ runStarted: (r) => started.push(r) });
    const r = rm.start({ projectId: 'p1', name: 'first', prompt: 'やって', model: 'opus' });
    expect(r.run).toMatchObject({ kind: 'start', sessionId: r.sessionId, deviceId: 'd', endedAt: null, endReason: null, pid: null });
    expect(r.run.tmuxName).toBe(`hangar-${shortId(r.run.id)}`);
    expect(r.tabs).toEqual([{ id: r.run.id, runId: r.run.id, sessionId: r.sessionId, kind: 'agent', title: 'Claude', tmuxName: r.run.tmuxName, createdAt: r.run.startedAt, closedAt: null }]);
    expect(started).toHaveLength(1);
    expect(tmux!.hasSession(r.run.tmuxName)).toBe(true);
    expect(tmux!.run('show-options', '-t', `=${r.run.tmuxName}:`, 'status').stdout.trim()).toBe('status off');

    const args = await launchedArgs(r.run.id);
    expect(args[0]).toBe('--mcp-config');
    expect(JSON.parse(args[1]!).mcpServers.hangar.url).toBe(`http://127.0.0.1:4177/mcp/s/${r.sessionId}`);
    expect(JSON.parse(args[1]!).mcpServers.hangar.headers.Authorization).toBe('Bearer tok');
    expect(args.at(-2)).toBe('やって');
    expect(args).toContain('--model');
    const uuid = args[args.indexOf('--session-id') + 1]!;
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);

    const s = db.prepare('select * from sessions where id = ?').get(r.sessionId) as Record<string, unknown>;
    expect(s).toMatchObject({ provider_session_id: uuid, project_id: 'p1', name: 'first', cwd });
    expect(typeof s.started_at).toBe('number');
    const sys = args[args.indexOf('--append-system-prompt') + 1]!;
    expect(sys).toContain('プロジェクト：alpha（' + cwd + '）');
    expect(fs.existsSync(path.join(home, 'bin', 'hangar-run.sh'))).toBe(true);
    expect(rm.listAlive().runs.map((x) => x.id)).toEqual([r.run.id]);
    expect(rm.getRun(r.run.id)?.tmuxName).toBe(r.run.tmuxName);
    expect(rm.getTab(r.run.id)?.kind).toBe('agent');
  });

  it('ディレクトリが無ければ 400 で、run の行は残らない', () => {
    fs.rmSync(cwd, { recursive: true, force: true });
    const rm = make();
    expect(() => rm.start({ projectId: 'p1' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(rm.listAlive().runs).toEqual([]);
    expect(db.prepare('select count(*) c from sessions').get()).toEqual({ c: 0 });
    fs.mkdirSync(cwd);
  });
});

describe('RunManager の回復と結びつけ（tmux 不要）', () => {
  it('recoverAtStartup は tmux の無い run を lost で閉じる', () => {
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd, home_device: 'd' }, 'd');
    upsertShared(db, 'runs', { id: 'r1', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-nope', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, 'd');
    const rm = make({ tmux: null });
    const ended: string[] = [];
    rm.on({ runEnded: (r) => ended.push(r.endReason ?? '') });
    expect(rm.recoverAtStartup().map((r) => r.id)).toEqual(['r1']);
    expect(ended).toEqual(['lost']);
    expect(rm.getRun('r1')).toMatchObject({ endReason: 'lost' });
    expect(rm.recoverAtStartup()).toEqual([]);
  });

  it('linkRegistry は Claude の UUID で run を引いて pid を書く', () => {
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd, home_device: 'd' }, 'd');
    upsertShared(db, 'runs', { id: 'r1', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-x', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, 'd');
    const rm = make({ tmux: null });
    const updated: number[] = [];
    rm.on({ runUpdated: (r) => updated.push(r.pid ?? -1) });
    const live = (pid: number) => [{ sessionId: 'u1', status: 'busy' as const, name: null, nameSource: null, cwd, pid }];
    rm.linkRegistry(live(4242));
    expect(rm.getRun('r1')?.pid).toBe(4242);
    rm.linkRegistry(live(4242));
    expect(updated).toEqual([4242]);
    rm.linkRegistry([]);
    expect(rm.getRun('r1')?.pid).toBe(4242);
  });

  it('kill は無い run に 404、閉じた run に 409', () => {
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd, home_device: 'd' }, 'd');
    upsertShared(db, 'runs', { id: 'r0', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-x', pid: null, launch_params: '{}', started_at: 1, ended_at: 2, end_reason: 'exited', heartbeat_at: 1 }, 'd');
    const rm = make({ tmux: null });
    expect(() => rm.kill('nope')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => rm.kill('r0')).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('startPolling は tick が投げてもサーバを落とさず、stop で止まる', async () => {
    const rm = make({ tmux: null });
    const boom = vi.spyOn(rm, 'tick').mockImplementation(() => {
      throw new Error('tmux が壊れた');
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      rm.startPolling(1);
      await waitFor(() => boom.mock.calls.length >= 2);
      rm.stop();
      const seen = boom.mock.calls.length;
      await new Promise((r) => setTimeout(r, 20));
      expect(boom.mock.calls.length).toBe(seen);
      expect(quiet.mock.calls.length).toBeGreaterThan(0);
    } finally {
      rm.stop();
      boom.mockRestore();
      quiet.mockRestore();
    }
  });
});

describe.skipIf(!TMUX)('RunManager の寿命（tmux 上）', () => {
  it('tick は tmux セッションが消えた run を exited で閉じる', async () => {
    fake = writeFakeClaude(home, { sleepSec: 0 });
    const rm = make();
    const ended: string[] = [];
    rm.on({ runEnded: (r) => ended.push(r.id) });
    const r = rm.start({ projectId: 'p1' });
    await waitFor(() => !tmux!.hasSession(r.run.tmuxName));
    expect(rm.tick().ended.map((x) => x.id)).toEqual([r.run.id]);
    expect(ended).toEqual([r.run.id]);
    expect(rm.getRun(r.run.id)).toMatchObject({ endReason: 'exited' });
    expect(rm.tick().ended).toEqual([]);
  });

  it('tick は 30 秒ごとに heartbeat を更新する', () => {
    let t = 1_000_000;
    const rm = make({ now: () => t });
    const r = rm.start({ projectId: 'p1' });
    t += 10_000;
    expect(rm.tick().ended).toEqual([]);
    expect(rm.getRun(r.run.id)?.heartbeatAt).toBe(1_000_000);
    t += 21_000;
    rm.tick();
    expect(rm.getRun(r.run.id)?.heartbeatAt).toBe(1_031_000);
  });

  it('kill は tmux を殺して killed で閉じる', async () => {
    const rm = make();
    const r = rm.start({ projectId: 'p1' });
    const k = rm.kill(r.run.id);
    expect(k).toMatchObject({ id: r.run.id, endReason: 'killed' });
    await waitFor(() => !tmux!.hasSession(r.run.tmuxName));
    expect(rm.listAlive().runs).toEqual([]);
  });

  it('recoverAtStartup は tmux が生きている run を残す', () => {
    const rm = make();
    const r = rm.start({ projectId: 'p1' });
    const rm2 = make();
    expect(rm2.recoverAtStartup()).toEqual([]);
    expect(rm2.getRun(r.run.id)?.endedAt).toBeNull();
  });
});

/** 既に本文のあるセッションを作る。再開とフォークの元になる。 */
function seedOldSession(withTranscript = true): string {
  const id = ensureSession(db, 'u-old', cwd, 'd');
  const cur = db.prepare('select * from sessions where id = ?').get(id) as Record<string, unknown>;
  upsertShared(db, 'sessions', { ...cur, project_id: 'p1', name: 'old' }, 'd');
  if (withTranscript) addTranscript(id);
  return id;
}

/** そのセッションに本文の jsonl があることにする。 */
function addTranscript(sessionId: string): void {
  db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?)').run('/x/u-old.jsonl', sessionId, null, 10, 1, 10, 1);
}

describe('resume と fork の入力検査（tmux 不要）', () => {
  it('無いセッション、本文なし、実行中は拒む', () => {
    const rm = make({ tmux: null, isLive: (u) => u === 'u-old' });
    expect(() => rm.resume('nope')).toThrow(expect.objectContaining({ status: 404 }));
    const noBody = seedOldSession(false);
    expect(() => rm.resume(noBody)).toThrow(expect.objectContaining({ status: 400 }));
    addTranscript(noBody);
    expect(() => rm.resume(noBody)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => rm.fork(noBody)).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe.skipIf(!TMUX)('resume と fork（tmux 上）', () => {
  it('resume は同じセッションに kind = resume の run を作り、-r で起動する', async () => {
    const id = seedOldSession();
    const rm = make();
    const r = rm.resume(id);
    expect(r.sessionId).toBe(id);
    expect(r.run.kind).toBe('resume');
    const args = await launchedArgs(r.run.id);
    expect(args.slice(0, 1)).toEqual(['--mcp-config']);
    expect(args.indexOf('-r')).toBe(2);
    expect(args[3]).toBe('u-old');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('-n');
    expect(args.at(-2)).toBe(args[args.indexOf('--append-system-prompt') + 1]);
    expect(() => rm.resume(id)).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('fork は新しいセッション行と kind = fork の run を作る', async () => {
    const id = seedOldSession();
    const rm = make();
    const f = rm.fork(id);
    expect(f.sessionId).not.toBe(id);
    expect(f.run).toMatchObject({ kind: 'fork', sessionId: f.sessionId });
    const args = await launchedArgs(f.run.id);
    const i = args.indexOf('--fork-session');
    expect(args.slice(i - 2, i + 3)).toEqual(['-r', 'u-old', '--fork-session', '--session-id', args[i + 2]]);
    const s = db.prepare('select * from sessions where id = ?').get(f.sessionId) as Record<string, unknown>;
    expect(s).toMatchObject({ provider_session_id: args[i + 2], project_id: 'p1', cwd, name: null });
    expect(JSON.parse(args[1]!).mcpServers.hangar.url).toBe(`http://127.0.0.1:4177/mcp/s/${f.sessionId}`);
  });

  it('cwd が無ければ 400', () => {
    const id = seedOldSession();
    db.prepare('update sessions set cwd = ? where id = ?').run('/nonexistent/cwd', id);
    expect(() => make().resume(id)).toThrow(expect.objectContaining({ status: 400 }));
  });
});
