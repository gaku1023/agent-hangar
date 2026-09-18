import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shortId } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
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
