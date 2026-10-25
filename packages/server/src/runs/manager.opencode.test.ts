import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import type { LaunchParams } from '@agent-hangar/shared';
import { agentsOf } from '../agent/agents.ts';
import { claudeDriverFor } from '../boot/agents.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { AGENT_RUN_DROPPED_ENV } from '../launch/env.ts';
import { createOpencodeDriver } from '../provider/opencode/driver.ts';
import { ServeManager } from '../provider/opencode/serve/manager.ts';
import { isAlive, ServeRegistry } from '../provider/opencode/serve/registry.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { realProcOps } from '../provider/claude-code/process/procs.ts';
import type { PaneOps } from '../tmux/pane.ts';
import { readFakeOpencodeLog, writeFakeOpencode, type FakeOpencodeEvent, type FakeOpencodeOptions } from '../../test/fake-opencode.ts';
import { writeFakeClaude } from '../../test/fake-claude.ts';
import { liveSourceOf } from '../../test/fake-live.ts';
import { expectMode, posixDescribe, posixIt } from '../../test/platform.ts';
import { SECRET_ENV_DIR, secretEnvPath, writeSecretEnv } from '../launch/secretEnv.ts';
import { mcpSecretFor } from './secrets.ts';
import { RunManager } from './manager.ts';

const ev = <K extends FakeOpencodeEvent['ev']>(log: FakeOpencodeEvent[], k: K) => log.filter((e): e is Extract<FakeOpencodeEvent, { ev: K }> => e.ev === k);
type Row = { id: string; provider: string; provider_session_id: string; project_id: string | null; deleted_at: number | null };

// 偽の opencode の serve を本当に起こす。画面（tmux）は開いた中身を記録するだけの口にする。止め方が POSIX のものなので、Windows では飛ばす。
posixDescribe('RunManager.start で opencode を起こす（materialize）', () => {
  let db: Db;
  let home: string;
  let cwd: string;
  let serves: ServeManager[];
  beforeEach(() => {
    db = openDb(':memory:');
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-oc-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-oc-cwd-'));
    serves = [];
    upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'pr1', project_id: 'p1', device_id: 'd', path: cwd, resolved: 1 }, 'd');
  });
  afterEach(async () => {
    for (const s of serves) await s.stopAll();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const sessions = (): Row[] => db.prepare('select id, provider, provider_session_id, project_id, deleted_at from sessions').all() as Row[];

  /** 開いた画面と、開いたときの sessions の行と偽の opencode の記録を残す口。 */
  const recordingPanes = (logFile: string, o: { fail?: boolean } = {}) => {
    const opened: { name: string; cwd: string; command: string[]; env: Record<string, string>; rows: Row[]; log: FakeOpencodeEvent[] }[] = [];
    const panes: PaneOps = {
      open: (p) => {
        if (o.fail) throw new Error('no room');
        opened.push({ ...p, env: p.env ?? {}, rows: sessions(), log: readFakeOpencodeLog(logFile) });
      },
      close: () => {}, list: () => [], capture: () => '', sendText: () => {}, sendKey: () => {}, prepareForOutsideTerminals: () => {},
    };
    return { panes, opened };
  };

  const make = (o: { fake?: FakeOpencodeOptions; enabled?: boolean; bin?: string | null; injection?: 'minimal' | 'claude' | 'none'; failOpen?: boolean } = {}) => {
    const { bin, logFile } = writeFakeOpencode(path.join(home, 'oc'), o.fake ?? {});
    const registry = new ServeRegistry(path.join(home, 'serves.json'));
    const manager = new ServeManager({ enabled: () => o.enabled !== false, bin: () => bin, version: async () => '2.1.4', registry, killGraceMs: 300 });
    serves.push(manager);
    // ensure が呼ばれた時点の行と、偽の opencode の記録を残す（仮の行が serve より先に在ることを見る）。
    const ensured: { rows: Row[]; log: FakeOpencodeEvent[] }[] = [];
    const watched = {
      ensure: (id: string, x?: { configContent?: string }) => { ensured.push({ rows: sessions(), log: readFakeOpencodeLog(logFile) }); return manager.ensure(id, x); },
      get: (id: string) => manager.get(id),
      stop: (id: string) => manager.stop(id),
    };
    const opencode = createOpencodeDriver({ serves: () => watched, droppedEnv: AGENT_RUN_DROPPED_ENV, mcpPollMs: 10, mcpWaitMs: 2000, report: () => {} });
    const fakeClaude = writeFakeClaude(home);
    const claude = claudeDriverFor({ home, token: 'tok', language: () => 'ja', claudeBin: () => fakeClaude.bin, live: liveSourceOf(), transcript: claudeTranscriptSource({ claudeDir: home }), procs: () => realProcOps });
    const { panes, opened } = recordingPanes(logFile, { fail: o.failOpen });
    const rm = new RunManager({
      db, deviceId: 'd', home, panes, claudeBin: fakeClaude.bin, claudeDir: home, port: 4177, token: 'tok', shell: 'sh', language: () => 'ja',
      procs: { ...realProcOps, listJobs: () => [] },
      agents: agentsOf([claude, opencode]), claude,
      agentEnabled: (k) => k === 'claude-code' || o.enabled !== false,
      agentBin: (k) => (k === 'opencode' ? (o.bin === undefined ? bin : o.bin) : null),
      injection: () => ({ askStatusAtEnd: true, liveHints: true, opencode: o.injection ?? 'minimal' }),
    });
    return { rm, opened, ensured, manager, bin, log: () => readFakeOpencodeLog(logFile) };
  };

  const params = (over: Partial<LaunchParams> = {}): LaunchParams => ({ agent: 'opencode', projectId: 'p1', ...over });

  posixIt('仮の行 → serve → ID なしの作成 → ID の記録 → 追記の PUT → MCP の connected → 画面、の順で起こす', async () => {
    const { rm, opened, ensured, manager, bin, log } = make({ fake: { mcpPendingPolls: 1 } });
    const r = await rm.start(params({ name: 'しごと', prompt: '直して', autoApprove: true }));

    // serve を頼んだ時点で、仮の行が在り、まだ会話は作られていない。
    expect(ensured).toHaveLength(1);
    expect(ensured[0]!.rows).toEqual([expect.objectContaining({ id: r.sessionId, provider: 'opencode', project_id: 'p1', deleted_at: null })]);
    expect(ensured[0]!.rows[0]!.provider_session_id).toMatch(/^pending:/);
    expect(ev(ensured[0]!.log, 'create')).toEqual([]);

    const l = log();
    const create = ev(l, 'create');
    expect(create).toHaveLength(1);
    expect(create[0]!.body).not.toHaveProperty('id');
    expect(create[0]!.body).toMatchObject({ location: { directory: cwd }, title: 'しごと' });

    // 画面を開く時点で、返った ID が行に書かれ、PUT と MCP の connected が済んでいる。
    expect(opened).toHaveLength(1);
    const o = opened[0]!;
    expect(o.rows).toEqual([expect.objectContaining({ id: r.sessionId, provider: 'opencode', provider_session_id: create[0]!.id })]);
    expect(ev(o.log, 'instructions')).toHaveLength(1);
    expect(ev(o.log, 'mcp').at(-1)?.status).toBe('connected');

    // TUI は返った ID の会話を serve につなぐ。パスワードは環境で渡し、コマンドに載せない。
    const info = manager.get(r.sessionId)!;
    const cmd = o.command;
    expect(cmd.slice(-9)).toEqual([bin, cwd, '--server', info.url, '-s', create[0]!.id, '--auto', '--prompt', '直して']);
    expect(cmd.join('\n')).not.toContain(info.password);
    expect(cmd.join('\n')).not.toContain(mcpSecretFor(db, r.sessionId)!);
    // パスワードは tmux の環境（new-session の -e）にも載せない。0600 のファイルに置き、場所だけを包みに渡す。包みが読んで消す。
    expect(o.env).not.toHaveProperty('OPENCODE_PASSWORD');
    expect(JSON.stringify(o.env)).not.toContain(info.password);
    const secret = secretEnvPath(home, r.run.id);
    expect(cmd.slice(0, cmd.indexOf('bash'))).toContain(`HANGAR_SECRET_ENV=${secret}`);
    expect(fs.readFileSync(secret, 'utf8')).toBe(`OPENCODE_PASSWORD=${info.password}\n`);
    expectMode(secret, 0o600);
    // CLAUDE 系と HANGAR_* を env -u で外す。
    for (const n of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'HANGAR_HOME']) expect(cmd.slice(cmd.indexOf('-u'), cmd.indexOf('bash'))).toContain(n);

    expect(sessions()).toEqual([expect.objectContaining({ provider: 'opencode', provider_session_id: create[0]!.id, deleted_at: null })]);
    expect(r.run.kind).toBe('start');
    expect(JSON.parse((db.prepare('select launch_params from runs where id = ?').get(r.run.id) as { launch_params: string }).launch_params)).toMatchObject({ agent: 'opencode', autoApprove: true });
    expect((db.prepare('select launch_params from runs where id = ?').get(r.run.id) as { launch_params: string }).launch_params).not.toContain(info.password);
  });

  posixIt('包みが読まずに run が終わっても、秘密の環境のファイルは run の終わりで消す', async () => {
    const { rm } = make();
    const r = await rm.start(params());
    const secret = secretEnvPath(home, r.run.id);
    expect(fs.existsSync(secret)).toBe(true);
    rm.kill(r.run.id);
    expect(fs.existsSync(secret)).toBe(false);
  });

  posixIt('画面を開けなかったときも、秘密の環境のファイルを残さない', async () => {
    const { rm } = make({ failOpen: true });
    await expect(rm.start(params())).rejects.toMatchObject({ status: 400 });
    const dir = path.join(home, SECRET_ENV_DIR);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  posixIt('起動時の回復と次の起動で、生きている run のもの以外の秘密の環境のファイルを消す', async () => {
    const { rm } = make();
    const stale = writeSecretEnv(home, 'stale1', { OPENCODE_PASSWORD: 'old' });
    rm.recoverAtStartup();
    expect(fs.existsSync(stale)).toBe(false);
    const stale2 = writeSecretEnv(home, 'stale2', { OPENCODE_PASSWORD: 'old' });
    const r = await rm.start(params());
    expect(fs.existsSync(stale2)).toBe(false);
    expect(fs.existsSync(secretEnvPath(home, r.run.id))).toBe(true);
  });

  posixIt('追記は設定の選択で組む。既定の最小限は条件 d の文、追記しないなら PUT しない', async () => {
    const minimal = make();
    await minimal.rm.start(params());
    const value = (ev(minimal.log(), 'instructions')[0]!.body as { value: string }).value;
    expect(value).toContain('各ターンの最初の一手で、他のツールより先に');
    expect(value).toContain('tools.hangar.set_turn_intent');
    expect(value).not.toContain('AskUserQuestion');
    await minimal.manager.stopAll();
    fs.rmSync(path.join(home, 'oc'), { recursive: true, force: true });

    const none = make({ injection: 'none' });
    await none.rm.start(params());
    expect(ev(none.log(), 'instructions')).toEqual([]);
  });

  posixIt('Claude Code と同じ追記なら、状態の問いと、時機を書き直した意図の段を送る', async () => {
    const { rm, log } = make({ injection: 'claude' });
    await rm.start(params());
    const value = (ev(log(), 'instructions')[0]!.body as { value: string }).value;
    expect(value).toContain('あなたは agent-hangar から起動されたセッションです。\nプロジェクト：alpha');
    expect(value).toContain('AskUserQuestion');
    expect(value).toContain('各ターンの最初の一手で、他のツールより先に、set_turn_intent に');
    expect(value).not.toContain('ターンを始めたときと方針を変えたときは');
  });

  posixIt('設定が切なら、行も serve も作らずに断る', async () => {
    const { rm, log, opened } = make({ enabled: false });
    await expect(rm.start(params())).rejects.toMatchObject({ status: 400 });
    expect(sessions()).toEqual([]);
    expect(log()).toEqual([]);
    expect(opened).toEqual([]);
  });

  posixIt('opencode が見つからなければ、行を作らずに断る', async () => {
    const { rm, log } = make({ bin: null });
    await expect(rm.start(params())).rejects.toMatchObject({ status: 400, message: expect.stringContaining('opencode が見つかりません') });
    expect(sessions()).toEqual([]);
    expect(log()).toEqual([]);
  });

  posixIt('知らないエージェントと、opencode に無い指定（アカウント、effort、権限モード、追加ディレクトリ、worktree）は、行を作らずに断る', async () => {
    const { rm, log } = make();
    await expect(rm.start(params({ agent: 'codex' as never }))).rejects.toMatchObject({ status: 400 });
    for (const bad of [{ account: 'primary' }, { effort: 'high' }, { permissionMode: 'plan' }, { addDirs: ['/a'] }, { worktree: 'w' }] satisfies Partial<LaunchParams>[]) {
      await expect(rm.start(params(bad))).rejects.toMatchObject({ status: 400 });
    }
    expect(sessions()).toEqual([]);
    expect(log()).toEqual([]);
  });

  posixIt('会話を作れなければ 400 で断り、仮の行を消し、serve を止める', async () => {
    const { rm, log, opened } = make({ fake: { failCreate: true } });
    await expect(rm.start(params())).rejects.toMatchObject({ status: 400, message: expect.stringContaining('opencode を起動できませんでした') });
    expect(sessions().filter((s) => s.deleted_at === null)).toEqual([]);
    expect(db.prepare('select count(*) c from runs').get()).toEqual({ c: 0 });
    expect(opened).toEqual([]);
    expect(isAlive(ev(log(), 'start')[0]!.pid)).toBe(false);
  });

  posixIt('画面を開けなければ 400 で断り、serve を止めて行を消す', async () => {
    const { rm, manager, log } = make({ failOpen: true });
    await expect(rm.start(params())).rejects.toMatchObject({ status: 400 });
    const id = sessions()[0]?.id;
    expect(sessions().filter((s) => s.deleted_at === null)).toEqual([]);
    expect(id === undefined || manager.get(id) === null).toBe(true);
    expect(isAlive(ev(log(), 'start')[0]!.pid)).toBe(false);
  });

  posixIt('Claude だけの操作（フォーク、attach、引き取り、アカウントの切り替え）と、まだ無い再開は、opencode の会話では入口で断る', async () => {
    const { rm, log } = make();
    upsertShared(db, 'sessions', { id: 'h-oc', provider: 'opencode', provider_session_id: 'ses_old', cwd, home_device: 'd', project_id: 'p1' }, 'd');
    const unsupported = expect.objectContaining({ status: 400, message: expect.stringContaining('opencode のセッションでは使えません') });
    expect(() => rm.fork('h-oc')).toThrow(unsupported);
    expect(() => rm.attach('h-oc')).toThrow(unsupported);
    expect(() => rm.resume('h-oc')).toThrow(unsupported);
    await expect(rm.adopt('h-oc')).rejects.toThrow(unsupported);
    await expect(rm.resumeWith('h-oc')).rejects.toThrow(unsupported);
    await expect(rm.switchAccount('h-oc', 'primary')).rejects.toThrow(unsupported);
    expect(db.prepare('select count(*) c from runs').get()).toEqual({ c: 0 });
    expect(log()).toEqual([]);
  });

  posixIt('agent を付けない起動は今までどおり Claude で起こし、opencode には触らない', async () => {
    const { rm, opened, log } = make();
    const r = await rm.start({ projectId: 'p1' });
    expect(sessions()).toEqual([expect.objectContaining({ id: r.sessionId, provider: 'claude-code' })]);
    expect(opened[0]!.command.join(' ')).toContain('--session-id');
    // Claude の起動は秘密の環境のファイルを使わない。
    expect(opened[0]!.command.join(' ')).not.toContain('HANGAR_SECRET_ENV');
    expect(fs.existsSync(path.join(home, SECRET_ENV_DIR))).toBe(false);
    expect(log()).toEqual([]);
  });
});
