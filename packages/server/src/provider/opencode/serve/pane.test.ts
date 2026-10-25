import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFakeOpencodeLog, writeFakeOpencode, type FakeOpencodeEvent } from '../../../../test/fake-opencode.ts';
import { removeTestSocket, testSocketPath, TMUX } from '../../../../test/tmux.ts';
import { tmuxPaneOps } from '../../../tmux/pane.ts';
import { Tmux } from '../../../tmux/tmux.ts';
import { serveEnv } from './env.ts';
import { ServeManager, serveSecrets, type ServeStarter } from './manager.ts';
import { disposeServePane, ensureServeWrapper, paneServeFiles, servePaneName, startServeInPane, type PaneServeHost } from './pane.ts';
import { adoptableServes, isAlive, ServeRegistry } from './registry.ts';
import { authHeader, killGroup, ServeStartError } from './spawn.ts';

const starts = (log: FakeOpencodeEvent[]): Extract<FakeOpencodeEvent, { ev: 'start' }>[] => log.filter((e): e is Extract<FakeOpencodeEvent, { ev: 'start' }> => e.ev === 'start');

describe('servePaneName', () => {
  it('run の画面とシェルタブの形に当たらず、名前に使えない文字を - にする', () => {
    expect(servePaneName('01a17483-d1ff-7147-980e-24c4b6f54aa5')).toBe('hangar-serve-01a17483-d1ff-7147-980e-24c4b6f54aa5');
    expect(servePaneName(':options')).toBe('hangar-serve--options');
    expect(/^hangar-[0-9a-f]+(?:-t\d+)?$/.test(servePaneName('abc'))).toBe(false);
  });
});

// 本物の tmux の画面の中で、偽の opencode を包みごと起こす。Windows の psmux でも同じ口で通る（実機で確かめる）。
describe.skipIf(!TMUX)('startServeInPane（本物の tmux）', () => {
  const socketPath = testSocketPath();
  const tmux = new Tmux({ tmuxPath: TMUX ?? 'tmux', socketPath });
  const panes = tmuxPaneOps(tmux);
  let dir: string;
  let host: PaneServeHost;
  const pids: number[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-serve-pane-'));
    host = { panes: () => panes, node: process.execPath, wrapper: () => ensureServeWrapper(dir), dir: path.join(dir, 'panes') };
  });
  afterEach(() => {
    for (const pid of pids.splice(0)) killGroup(pid, 'SIGKILL');
    for (const n of tmux.listSessions() ?? []) tmux.killSession(n);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  afterAll(() => {
    tmux.killServer();
    removeTestSocket(socketPath);
  });

  it('画面の中で serve を起こして応答を待つ。環境は渡したものだけで、指定のファイルは残さない', async () => {
    const { bin, logFile } = writeFakeOpencode(path.join(dir, 'oc'));
    const dirty = { ...process.env, CLAUDECODE: '1', HANGAR_TOKEN: 'secret' };
    const s = await startServeInPane({ key: 'a', bin, env: serveEnv(bin, dirty), directory: dir, host });
    pids.push(s.pid);
    expect(s.pane).toBe('hangar-serve-a');
    expect(tmux.listSessions()).toContain('hangar-serve-a');
    expect(isAlive(s.pid)).toBe(true);
    const r = await fetch(`${s.url}/api/session/active`, { headers: { authorization: authHeader(s.password) } });
    expect(r.status).toBe(200);
    const [start] = starts(readFakeOpencodeLog(logFile));
    expect(start?.pid).toBe(s.pid);
    expect(fs.realpathSync(start!.cwd)).toBe(fs.realpathSync(dir));
    const keys = Object.keys(start?.env ?? {});
    expect(keys.filter((k) => k.startsWith('CLAUDE') || k.startsWith('HANGAR_'))).toEqual([]);
    expect(start?.env.OPENCODE_SERVER_PASSWORD).toBe(s.password);
    expect(fs.existsSync(paneServeFiles(host.dir, 'hangar-serve-a').spec)).toBe(false);
  });

  it('database is locked で落ちたら理由を読み、画面を片付けて投げる', async () => {
    const { bin } = writeFakeOpencode(path.join(dir, 'oc'), { failLockTimes: 1 });
    const err = await startServeInPane({ key: 'a', bin, env: serveEnv(bin), host }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServeStartError);
    expect((err as ServeStartError).reason).toBe('locked');
    expect(tmux.listSessions() ?? []).not.toContain('hangar-serve-a');
  });

  it('包みを起こせなければ、時間切れを待たずに諦める', async () => {
    const { bin } = writeFakeOpencode(path.join(dir, 'oc'));
    const t0 = Date.now();
    const err = await startServeInPane({ key: 'a', bin, env: serveEnv(bin), host: { ...host, node: path.join(dir, 'no-node') }, readyTimeoutMs: 15_000 }).catch((e: unknown) => e);
    expect((err as ServeStartError).reason).toBe('spawn');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('hangar を閉じても画面の serve は残り、起こし直した hangar が引き継いで止めると、画面もファイルも片付く', async () => {
    const { bin } = writeFakeOpencode(path.join(dir, 'oc'));
    const registry = new ServeRegistry(path.join(dir, 'serves.json'));
    const deps = {
      enabled: () => true, bin: () => bin, version: async () => '2.1.4', registry, killGraceMs: 300, watchMs: 50,
      secrets: serveSecrets(dir),
      start: ((x) => startServeInPane({ ...x, host })) satisfies ServeStarter,
      disposePane: (n: string) => disposeServePane(host, n),
    };
    const first = new ServeManager(deps);
    const info = await first.ensure('a', { directory: dir });
    pids.push(info.pid);
    expect(registry.list()[0]).toMatchObject({ sessionId: 'a', pane: 'hangar-serve-a' });
    await first.stopAll({ keep: () => true });
    expect(isAlive(info.pid)).toBe(true);
    expect(tmux.listSessions()).toContain('hangar-serve-a');

    const second = new ServeManager(deps);
    expect(second.adopt(adoptableServes(registry, () => true))).toEqual(['a']);
    expect(second.get('a')).toMatchObject({ pid: info.pid, password: info.password });
    await second.stop('a');
    expect(isAlive(info.pid)).toBe(false);
    for (let i = 0; i < 50 && (tmux.listSessions() ?? []).includes('hangar-serve-a'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(tmux.listSessions() ?? []).not.toContain('hangar-serve-a');
    expect(fs.existsSync(paneServeFiles(host.dir, 'hangar-serve-a').log)).toBe(false);
    expect(registry.list()).toEqual([]);
  });
});
