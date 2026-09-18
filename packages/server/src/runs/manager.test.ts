import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shortId, type TabDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { mangleCwd } from '../provider/claude-code/discover.ts';
import { readArgs, writeFakeClaude } from '../../test/fake-claude.ts';
import { TMUX, removeTestSocket, testSocketPath, waitFor } from '../../test/tmux.ts';
import { Tmux } from '../tmux/tmux.ts';
import { RunError, RunManager } from './manager.ts';

let db: Db;
let home: string;
let cwd: string;
let fake: { bin: string; argsFile: string };
let tmux: Tmux | null;
let claudeDir: string;
const socketPath = testSocketPath();

beforeEach(() => {
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-cwd-'));
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-claude-'));
  fake = writeFakeClaude(home);
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'pr1', project_id: 'p1', device_id: 'd', path: cwd, resolved: 1 }, 'd');
  upsertShared(db, 'projects', { id: 'p2', name: 'lost', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'pr2', project_id: 'p2', device_id: 'd', path: '/nonexistent', resolved: 0 }, 'd');
  tmux = TMUX ? new Tmux({ tmuxPath: TMUX, socketPath }) : null;
});
afterAll(() => removeTestSocket(socketPath));
afterEach(() => {
  tmux?.killServer();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

const make = (over: Partial<ConstructorParameters<typeof RunManager>[0]> = {}) =>
  new RunManager({ db, deviceId: 'd', home, tmux, claudeBin: fake.bin, claudeDir, port: 4177, token: 'tok', shell: 'sh', ...over });

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
  it('tmux の失敗を返すときはトークンを伏せ、1 行に切り詰める', () => {
    // argv には --mcp-config の中にトークンが入るので、stderr をそのまま応答に載せない。
    const noisy = path.join(home, 'noisy-tmux.sh');
    fs.writeFileSync(noisy, '#!/bin/sh\necho "new-session failed: Authorization: Bearer SECRET-TOKEN-123" >&2\necho "2 行目" >&2\nexit 1\n', { mode: 0o755 });
    const rm = make({ tmux: new Tmux({ tmuxPath: noisy }), token: 'SECRET-TOKEN-123' });
    let message = '';
    try { rm.start({ projectId: 'p1' }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('tmux の起動に失敗しました');
    expect(message).not.toContain('SECRET-TOKEN-123');
    expect(message).not.toContain('\n');
    expect(message).not.toContain('2 行目');
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

  it('tick は tmux が無ければ何も閉じない。観測できないことと動いていないことは違う', () => {
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd, home_device: 'd' }, 'd');
    upsertShared(db, 'runs', { id: 'r1', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-nope', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, 'd');
    upsertShared(db, 'run_tabs', { id: 't1', run_id: 'r1', tmux_name: 'hangar-nope-t1', title: 'シェル 1', created_at: 1, closed_at: null }, 'd');
    const rm = make({ tmux: null });
    const ended: string[] = [];
    rm.on({ runEnded: (r) => ended.push(r.id) });
    expect(rm.tick()).toEqual({ ended: [], closedTabs: [] });
    expect(ended).toEqual([]);
    expect(rm.getRun('r1')?.endedAt).toBeNull();
    expect(rm.getTab('t1')?.closedAt).toBeNull();
    // 起動時の回復は別である。サーバが落ちている間の tmux は本当に失われている。
    expect(rm.recoverAtStartup().map((r) => r.id)).toEqual(['r1']);
    expect(rm.getTab('t1')).toBeNull();
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

describe.skipIf(!TMUX)('シェルタブ（tmux 上）', () => {
  it('openTab は連番の tmux セッションを作り、closeTab は閉じ、番号は再利用しない', async () => {
    const rm = make();
    const tabs: TabDto[] = [];
    rm.on({ tabChanged: (t) => tabs.push(t) });
    const r = rm.start({ projectId: 'p1' });
    const t1 = rm.openTab(r.run.id);
    expect(t1).toMatchObject({ runId: r.run.id, sessionId: r.sessionId, kind: 'shell', title: 'シェル 1', tmuxName: `${r.run.tmuxName}-t1`, closedAt: null });
    expect(tmux!.hasSession(t1.tmuxName)).toBe(true);
    expect(tmux!.run('show-options', '-t', `=${t1.tmuxName}:`, 'status').stdout.trim()).toBe('status off');
    const t2 = rm.openTab(r.run.id);
    expect(t2.tmuxName).toBe(`${r.run.tmuxName}-t2`);
    expect(rm.listAlive().tabs.map((t) => t.id)).toEqual([r.run.id, t1.id, t2.id]);
    const closed = rm.closeTab(t1.id);
    expect(closed.closedAt).not.toBeNull();
    await waitFor(() => !tmux!.hasSession(t1.tmuxName));
    expect(rm.getTab(t1.id)).toBeNull();
    expect(rm.openTab(r.run.id).tmuxName).toBe(`${r.run.tmuxName}-t3`);
    expect(tabs.map((t) => [t.title, t.closedAt === null])).toEqual([['シェル 1', true], ['シェル 2', true], ['シェル 1', false], ['シェル 3', true]]);
  });

  it('tick は利用者が exit したタブを閉じ、kill はタブごと片付ける', async () => {
    const rm = make();
    const r = rm.start({ projectId: 'p1' });
    const t1 = rm.openTab(r.run.id);
    tmux!.killSession(t1.tmuxName);
    await waitFor(() => !tmux!.hasSession(t1.tmuxName));
    expect(rm.tick().closedTabs.map((t) => t.id)).toEqual([t1.id]);
    expect(rm.tick().closedTabs).toEqual([]);
    const t2 = rm.openTab(r.run.id);
    rm.kill(r.run.id);
    await waitFor(() => !tmux!.hasSession(t2.tmuxName) && !tmux!.hasSession(r.run.tmuxName));
    expect(rm.getTab(t2.id)).toBeNull();
    expect(rm.listAlive()).toEqual({ runs: [], tabs: [] });
  });

  it('recoverAtStartup は run を残したまま、消えたタブだけを閉じる', async () => {
    const rm = make();
    const r = rm.start({ projectId: 'p1' });
    const t1 = rm.openTab(r.run.id);
    const t2 = rm.openTab(r.run.id);
    tmux!.killSession(t1.tmuxName);
    await waitFor(() => !tmux!.hasSession(t1.tmuxName));
    const rm2 = make();
    expect(rm2.recoverAtStartup()).toEqual([]);
    expect(rm2.getTab(t1.id)).toBeNull();
    expect(rm2.listAlive().tabs.map((t) => t.id)).toEqual([r.run.id, t2.id]);
  });

  it('無い run には 404、Claude のタブは閉じられない', () => {
    const rm = make();
    expect(() => rm.openTab('nope')).toThrow(expect.objectContaining({ status: 404 }));
    const r = rm.start({ projectId: 'p1' });
    expect(() => rm.closeTab(r.run.id)).toThrow(expect.objectContaining({ status: 400 }));
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

  it('cwd が無ければ fork も 400 で、セッションの行は増えない', () => {
    const id = seedOldSession();
    db.prepare('update sessions set cwd = ? where id = ?').run('/nonexistent/cwd', id);
    const before = db.prepare('select count(*) c from sessions').get() as { c: number };
    expect(() => make().fork(id)).toThrow(expect.objectContaining({ status: 400 }));
    expect(db.prepare('select count(*) c from sessions').get()).toEqual(before);
  });
});

/** 行だけを作って生きている run にする。tmux を使わずに寿命の処理を見るために使う。 */
function seedRun(o: { runId?: string; sessionId?: string; kind?: 'start' | 'resume' | 'fork'; tabId?: string; endedAt?: number } = {}): { runId: string; sessionId: string; tabId: string } {
  const sessionId = o.sessionId ?? 's1';
  const runId = o.runId ?? 'r1';
  const tabId = o.tabId ?? 't1';
  const cur = db.prepare('select id from sessions where id = ?').get(sessionId) as { id: string } | undefined;
  if (!cur) upsertShared(db, 'sessions', { id: sessionId, provider: 'claude-code', provider_session_id: `u-${sessionId}`, cwd, home_device: 'd', last_activity_at: 1 }, 'd');
  upsertShared(db, 'runs', { id: runId, session_id: sessionId, device_id: 'd', kind: o.kind ?? 'start', tmux_name: `hangar-${runId}`, pid: null, launch_params: '{}', started_at: 1, ended_at: o.endedAt ?? null, end_reason: o.endedAt ? 'exited' : null, heartbeat_at: 1 }, 'd');
  upsertShared(db, 'run_tabs', { id: tabId, run_id: runId, tmux_name: `hangar-${runId}-t1`, title: 'シェル 1', created_at: 1, closed_at: null }, 'd');
  return { runId, sessionId, tabId };
}

/** 決まった終了コードと出力を返す偽の tmux を書く。 */
function fakeTmux(body: string): Tmux {
  const bin = path.join(home, `fake-tmux-${Math.random().toString(16).slice(2)}.sh`);
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return new Tmux({ tmuxPath: bin });
}

describe('tmux を呼べないとき（tmux 不要）', () => {
  it('tick は tmux の呼び出しが失敗したら何も閉じない', () => {
    // tmuxPath のバイナリが消えている状態。brew upgrade の symlink の張り替えでも起きる。
    seedRun();
    const rm = make({ tmux: new Tmux({ tmuxPath: path.join(home, 'gone-tmux') }) });
    const ended: string[] = [];
    rm.on({ runEnded: (r) => ended.push(r.id) });
    expect(rm.tick()).toEqual({ ended: [], closedTabs: [] });
    expect(ended).toEqual([]);
    expect(rm.getRun('r1')?.endedAt).toBeNull();
    expect(rm.getTab('t1')?.closedAt).toBeNull();
  });

  it('recoverAtStartup も tmux の呼び出しが失敗したら何も閉じない', () => {
    seedRun();
    const rm = make({ tmux: fakeTmux('echo "lost server" >&2\nexit 1') });
    expect(rm.recoverAtStartup()).toEqual([]);
    expect(rm.getRun('r1')?.endedAt).toBeNull();
    expect(rm.getTab('t1')?.closedAt).toBeNull();
  });

  it('tmux サーバが動いていないだけなら、run もタブも閉じる', () => {
    // 呼び出しは成功していて、本当にセッションが 1 つも無い。これは観測できている。
    seedRun();
    const rm = make({ tmux: fakeTmux('echo "no server running on /tmp/tmux-501/default" >&2\nexit 1') });
    const r = rm.tick();
    expect(r.ended.map((x) => x.id)).toEqual(['r1']);
    expect(r.closedTabs.map((x) => x.id)).toEqual(['t1']);
  });
});

describe('起動に失敗した run の後始末（tmux 不要）', () => {
  const deletedAt = (sessionId: string) => (db.prepare('select deleted_at from sessions where id = ?').get(sessionId) as { deleted_at: number | null }).deleted_at;

  it('本文の無い start の run が終わったら、空のセッション行も消す', () => {
    // claude がフラグ違いなどで起動できないと、本文は永久に生まれない。
    // 消さないと、名前も本文も無いセッションが一覧の先頭に居座り、再開もフォークも削除もできない。
    const { runId, sessionId } = seedRun();
    const rm = make({ tmux: null });
    rm.kill(runId);
    expect(deletedAt(sessionId)).not.toBeNull();
  });

  it('本文のあるセッションは残す', () => {
    const { runId, sessionId } = seedRun();
    addTranscript(sessionId);
    const rm = make({ tmux: null });
    rm.kill(runId);
    expect(deletedAt(sessionId)).toBeNull();
  });

  it('索引がまだでも、jsonl があるセッションは残す', () => {
    // claude が本文を書いた直後に run が終わると、transcript_files の行はまだ無い。
    // DB だけを見て消すと、本文のあるセッションが UI から永久に見えなくなる。
    const { runId, sessionId } = seedRun();
    const uuid = (db.prepare('select provider_session_id p from sessions where id = ?').get(sessionId) as { p: string }).p;
    const dir = path.join(claudeDir, 'projects', mangleCwd(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${uuid}.jsonl`), '{}\n');
    const rm = make({ tmux: null });
    rm.kill(runId);
    expect(deletedAt(sessionId)).toBeNull();
  });

  it('サブエージェントの jsonl しか無くても残す', () => {
    const { runId, sessionId } = seedRun();
    const uuid = (db.prepare('select provider_session_id p from sessions where id = ?').get(sessionId) as { p: string }).p;
    // 本体の jsonl と揃いの場所に置かれるとは限らないので、別のプロジェクトディレクトリに置く。
    const sub = path.join(claudeDir, 'projects', 'other-project', uuid, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-abc123.jsonl'), '{}\n');
    const rm = make({ tmux: null });
    rm.kill(runId);
    expect(deletedAt(sessionId)).toBeNull();
  });

  it('他に run が残っているセッションは残す', () => {
    const { runId, sessionId } = seedRun();
    seedRun({ runId: 'r2', tabId: 't2' });
    const rm = make({ tmux: null });
    rm.kill(runId);
    expect(deletedAt(sessionId)).toBeNull();
  });

  it('再開やフォークの run では消さない。元の本文が読めなくなる', () => {
    const { runId, sessionId } = seedRun({ kind: 'resume' });
    const rm = make({ tmux: null });
    rm.kill(runId);
    expect(deletedAt(sessionId)).toBeNull();
  });
});

describe('端末に繋いでよいタブ（tmux 不要）', () => {
  it('終了した run の Claude のタブは繋がせず、シェルタブは繋げる', () => {
    // run が終わってもシェルタブは残る。Claude のタブだけは繋ぎ先が消えていて、
    // 素の名前で attach するとそのシェルタブに落ちるので、ここで塞ぐ。
    const { runId, tabId } = seedRun({ endedAt: 2 });
    const rm = make({ tmux: null });
    expect(rm.getTab(runId)?.kind).toBe('agent');
    expect(rm.attachTarget(runId)).toBeNull();
    expect(rm.attachTarget(tabId)?.tmuxName).toBe(`hangar-${runId}-t1`);
    expect(rm.attachTarget('nope')).toBeNull();
  });

  it('生きている run の Claude のタブは繋げる', () => {
    const { runId } = seedRun();
    const rm = make({ tmux: null });
    expect(rm.attachTarget(runId)?.kind).toBe('agent');
  });
});

describe('addDirs の検査（tmux 不要）', () => {
  it('- で始まる値は 400 で弾き、行を作らない', () => {
    // --add-dir は可変長オプションなので、値がそのまま claude のフラグとして食われる。
    const rm = make({ tmux: null });
    expect(() => rm.start({ projectId: 'p1', addDirs: ['--dangerously-skip-permissions'] })).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('addDirs') }));
    expect(() => rm.start({ projectId: 'p1', addDirs: ['-p'] })).toThrow(/addDirs/);
    // 普通のディレクトリはここでは弾かない。先の検査に進んで tmux で止まる。
    expect(() => rm.start({ projectId: 'p1', addDirs: [cwd] })).toThrow(/tmux/);
    expect(db.prepare('select count(*) c from sessions').get()).toEqual({ c: 0 });
    expect(db.prepare('select count(*) c from runs').get()).toEqual({ c: 0 });
  });
});

describe.skipIf(!TMUX)('tmux が一瞬消えたとき（tmux 上）', () => {
  it('tmuxPath の symlink が外れても、生きている run とタブを閉じない', async () => {
    // brew upgrade tmux は symlink を張り替えるので、2 秒周期の tick に十分入る。
    const link = path.join(home, 'tmux-link');
    fs.symlinkSync(TMUX!, link);
    const rm = make({ tmux: new Tmux({ tmuxPath: link, socketPath }) });
    const r = rm.start({ projectId: 'p1' });
    const t = rm.openTab(r.run.id);

    fs.unlinkSync(link);
    expect(rm.tick()).toEqual({ ended: [], closedTabs: [] });
    expect(rm.recoverAtStartup()).toEqual([]);
    expect(rm.listAlive().runs.map((x) => x.id)).toEqual([r.run.id]);
    expect(rm.listAlive().tabs.map((x) => x.id)).toEqual([r.run.id, t.id]);

    // 戻ってきたら、また観測できる。tmux の上ではどちらも動き続けている。
    fs.symlinkSync(TMUX!, link);
    expect(rm.tick()).toEqual({ ended: [], closedTabs: [] });
    expect(tmux!.hasSession(r.run.tmuxName)).toBe(true);
    expect(tmux!.hasSession(t.tmuxName)).toBe(true);
    rm.kill(r.run.id);
    await waitFor(() => !tmux!.hasSession(r.run.tmuxName));
  });
});
