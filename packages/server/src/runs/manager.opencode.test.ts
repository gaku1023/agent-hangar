import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import type { LaunchParams, LaunchPrepDto } from '@agent-hangar/shared';
import { LaunchPreps } from './launchPrep.ts';
import { ProviderPreps } from '../provider/opencode/providerPrep.ts';
import { LocalModelListing } from '../provider/opencode/localModels/available.ts';
import { agentsOf } from '../agent/agents.ts';
import { claudeDriverFor } from '../boot/agents.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { AGENT_RUN_DROPPED_ENV } from '../launch/env.ts';
import { createOpencodeDriver } from '../provider/opencode/driver.ts';
import { ServeManager, serveSecrets } from '../provider/opencode/serve/manager.ts';
import { adoptableServes, isAlive, ServeRegistry } from '../provider/opencode/serve/registry.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { realProcOps } from '../provider/claude-code/process/procs.ts';
import type { PaneOps } from '../tmux/pane.ts';
import { readFakeOpencodeLog, writeFakeOpencode, type FakeOpencodeEvent, type FakeOpencodeOptions } from '../../test/fake-opencode.ts';
import { writeFakeClaude } from '../../test/fake-claude.ts';
import { liveSourceOf } from '../../test/fake-live.ts';
import { expectMode, posixDescribe, posixIt } from '../../test/platform.ts';
import { SECRET_ENV_DIR, secretEnvPath, writeSecretEnv } from '../launch/secretEnv.ts';
import { runLogPath } from '../launch/wrapper.ts';
import { mcpSecretFor } from './secrets.ts';
import { RunManager } from './manager.ts';
import type { CompatSink, Drift } from '../provider/claude-code/compat/types.ts';
import { until } from '../../test/fake-opencode-events.ts';

const ev = <K extends FakeOpencodeEvent['ev']>(log: FakeOpencodeEvent[], k: K) => log.filter((e): e is Extract<FakeOpencodeEvent, { ev: K }> => e.ev === k);
type Row = { id: string; provider: string; provider_session_id: string; project_id: string | null; deleted_at: number | null };

// 偽の opencode の serve を本当に起こす。画面（tmux）は開いた中身を記録するだけの口にする。
// 起動のコマンド（bash の包みと env -u）を macOS と Linux の形で確かめるので、Windows では飛ばす。
// serve の起こし方と止め方そのものの Windows の試験は provider/opencode/serve/ の試験が受け持つ。
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
  // listed は tmux の一覧に載せる名前（既定は空。開いた画面を載せたいときは試験が足す）。closed は閉じた画面の名前。
  // touched は画面を読んだか、キーや文字を送った記録（名前と中身）。screen は capture が返す画面。
  const recordingPanes = (logFile: string, o: { fail?: boolean; screen?: string } = {}) => {
    const opened: { name: string; cwd: string; command: string[]; env: Record<string, string>; rows: Row[]; log: FakeOpencodeEvent[] }[] = [];
    const listed: string[] = [];
    const closed: string[] = [];
    const touched: string[][] = [];
    const panes: PaneOps = {
      open: (p) => {
        if (o.fail) throw new Error('no room');
        opened.push({ ...p, env: p.env ?? {}, rows: sessions(), log: readFakeOpencodeLog(logFile) });
      },
      close: (name) => { closed.push(name); const i = listed.indexOf(name); if (i >= 0) listed.splice(i, 1); },
      list: () => [...listed],
      capture: (name) => { touched.push([name, 'capture']); return o.screen ?? ''; },
      sendText: (name, text) => { touched.push([name, 'text', text]); },
      sendKey: (name, key) => { touched.push([name, 'key', key]); },
      prepareForOutsideTerminals: () => {},
    };
    return { panes, opened, listed, closed, touched };
  };

  const make = (o: { secrets?: boolean; fake?: FakeOpencodeOptions; enabled?: boolean; enabledFn?: () => boolean; bin?: string | null; injection?: 'minimal' | 'claude' | 'none'; failOpen?: boolean; pidAlive?: (pid: number) => boolean; startTimeOf?: (pid: number) => string | null; intercept?: boolean; platform?: NodeJS.Platform; screen?: string; compat?: CompatSink; claudeBin?: string | null; providerPreps?: ProviderPreps; preps?: LaunchPreps; localListing?: LocalModelListing } = {}) => {
    const enabled = o.enabledFn ?? (() => o.enabled !== false);
    const { bin, logFile } = writeFakeOpencode(path.join(home, 'oc'), o.fake ?? {});
    const registry = new ServeRegistry(path.join(home, 'serves.json'));
    const manager = new ServeManager({ enabled, bin: () => bin, version: async () => '2.1.4', registry, killGraceMs: 300, watchMs: 50, ...(o.secrets ? { secrets: serveSecrets(home) } : {}) });
    serves.push(manager);
    // ensure が呼ばれた時点の行と、偽の opencode の記録を残す（仮の行が serve より先に在ることを見る）。
    const ensured: { rows: Row[]; log: FakeOpencodeEvent[] }[] = [];
    const watched = {
      ensure: (id: string, x?: { configContent?: string }) => { ensured.push({ rows: sessions(), log: readFakeOpencodeLog(logFile) }); return manager.ensure(id, x); },
      get: (id: string) => manager.get(id),
      stop: (id: string) => manager.stop(id),
    };
    const opencode = createOpencodeDriver({ serves: () => watched, droppedEnv: AGENT_RUN_DROPPED_ENV, mcpPollMs: 10, mcpWaitMs: 2000, report: () => {}, ...(o.providerPreps ? { providerPreps: o.providerPreps } : {}), ...(o.localListing ? { localListing: o.localListing } : {}) });
    const fakeClaude = writeFakeClaude(home);
    const claude = claudeDriverFor({ home, token: 'tok', language: () => 'ja', claudeBin: () => fakeClaude.bin, live: liveSourceOf(), transcript: claudeTranscriptSource({ claudeDir: home }), procs: () => realProcOps });
    const { panes, opened, listed, closed, touched } = recordingPanes(logFile, { fail: o.failOpen, screen: o.screen });
    const rm = new RunManager({
      db, deviceId: 'd', home, panes, claudeBin: o.claudeBin === undefined ? fakeClaude.bin : o.claudeBin, claudeDir: home, port: 4177, token: 'tok', shell: 'sh', language: () => 'ja',
      ...(o.platform ? { platform: o.platform } : {}),
      ...(o.compat ? { compat: o.compat } : {}),
      procs: { ...realProcOps, listJobs: () => [], ...(o.startTimeOf ? { startTimeOf: o.startTimeOf } : {}) },
      ...(o.pidAlive ? { pidAlive: o.pidAlive } : {}),
      agents: agentsOf([claude, opencode]), claude,
      agentEnabled: (k) => k === 'claude-code' || enabled(),
      agentBin: (k) => (k === 'opencode' ? (o.bin === undefined ? bin : o.bin) : null),
      injection: () => ({ askStatusAtEnd: true, liveHints: true, notifyUser: false, opencode: o.injection ?? 'minimal' }),
      terminalIntercept: (k) => k === 'opencode' && o.intercept !== false,
      ...(o.preps ? { preps: o.preps } : {}),
    });
    return { rm, opened, ensured, manager, registry, bin, opencode, claude, fakeClaude, listed, closed, touched, log: () => readFakeOpencodeLog(logFile) };
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

  // npm の包み（opencode.cmd）が .exe を指していなければ、読み替えられずに .cmd のまま届く。.cmd は tmux（psmux）から直に起こせない。
  posixIt('Windows で opencode が .cmd のままなら、起動の入口で理由を添えて断り、行も serve も作らない', async () => {
    const cmd = 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd';
    const { rm, log, opened } = make({ bin: cmd, platform: 'win32' });
    const err = (await rm.start(params()).then(() => null, (e: unknown) => e)) as Error & { status: number };
    expect(err).toMatchObject({ status: 400 });
    expect(err.message).toBe(`opencode を起動できませんでした: ${cmd} は .cmd のため使えません。opencode.exe が PATH から見つかるようにしてください`);
    expect(sessions()).toEqual([]);
    expect(log()).toEqual([]);
    expect(opened).toEqual([]);
  });

  posixIt('driver がまだ無い codex は、設定で有効にしても起動を断り、行も serve も作らない', async () => {
    const { rm, log } = make();
    const err = (await rm.start(params({ agent: 'codex' })).then(() => null, (e: unknown) => e)) as Error & { status: number };
    expect(err).toMatchObject({ status: 400 });
    expect(err.message).toBe('知らないエージェントです: codex');
    expect(sessions()).toEqual([]);
    expect(log()).toEqual([]);
  });

  posixIt('知らないエージェントと、opencode に無い指定（アカウント、effort、権限モード、追加ディレクトリ、worktree）は、行を作らずに断る', async () => {
    const { rm, log } = make();
    await expect(rm.start(params({ agent: 'gemini' as never }))).rejects.toMatchObject({ status: 400 });
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

  /** この PC の LM Studio の偽物。models は持っているモデル、down はつながらないこと。 */
  const lmListing = (o: { models?: string[]; down?: boolean }) => new LocalModelListing({
    fetch: (async (url: string | URL) => {
      if (o.down) throw new TypeError('fetch failed');
      return new URL(String(url)).pathname === '/api/v1/models' ? Response.json({ models: (o.models ?? []).map((key) => ({ type: 'llm', key })) }) : new Response('?', { status: 404 });
    }) as typeof fetch,
  });
  const lmFake: FakeOpencodeOptions = { providers: [{ id: 'opencode', name: 'OpenCode' }, { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1' }] };

  posixIt('この PC の LM Studio に無いモデルは、会話を作る前に、使えるモデルを添えて 400 で断る。行は残さず、serve を止める', async () => {
    const { rm, log, opened } = make({ fake: lmFake, preps: new LaunchPreps({ broadcast: () => {} }), localListing: lmListing({ models: ['gemma-4-26b-a4b-it-heretic', 'qwen3.8-27b-mlx'] }) });
    await expect(rm.start(params({ model: 'lmstudio/qwen3.6-35b-a3b' }))).rejects.toMatchObject({
      status: 400,
      message: 'opencode を起動できませんでした: lmstudio/qwen3.6-35b-a3b はこの PC にありません。使えるのは: lmstudio/gemma-4-26b-a4b-it-heretic、lmstudio/qwen3.8-27b-mlx',
    });
    expect(ev(log(), 'create')).toEqual([]);
    expect(sessions().filter((s) => s.deleted_at === null)).toEqual([]);
    expect(db.prepare('select count(*) c from runs').get()).toEqual({ c: 0 });
    expect(opened).toEqual([]);
    expect(isAlive(ev(log(), 'start')[0]!.pid)).toBe(false);
  });

  posixIt('この PC の LM Studio にあるモデルは、これまでどおり起こす', async () => {
    const { rm, log, opened } = make({ fake: lmFake, preps: new LaunchPreps({ broadcast: () => {} }), localListing: lmListing({ models: ['qwen3.8-27b-mlx'] }) });
    await rm.start(params({ model: 'lmstudio/qwen3.8-27b-mlx' }));
    expect(ev(log(), 'create')).toHaveLength(1);
    expect(opened).toHaveLength(1);
  });

  posixIt('LM Studio につながらなければ、起動していないことを言って 400 で断る', async () => {
    const { rm, log } = make({ fake: lmFake, preps: new LaunchPreps({ broadcast: () => {} }), localListing: lmListing({ down: true }) });
    await expect(rm.start(params({ model: 'lmstudio/qwen3.8-27b-mlx' }))).rejects.toMatchObject({
      status: 400,
      message: 'opencode を起動できませんでした: LM Studio の API サーバー（http://127.0.0.1:1234）に接続できません。サーバーを起動して再試行してください。',
    });
    expect(ev(log(), 'create')).toEqual([]);
  });

  posixIt('準備の無い起動（外のターミナル）は、モデルの有無を確かめずに起こす（TUI の /models で替えられる）', async () => {
    const { rm, log } = make({ fake: lmFake, localListing: lmListing({ models: ['gemma'] }) });
    await rm.start(params({ model: 'lmstudio/qwen3.6-35b-a3b' }));
    expect(ev(log(), 'create')).toHaveLength(1);
  });

  posixIt('この PC でない接続先のモデルは、LM Studio が止まっていても確かめずに起こす', async () => {
    const { rm, log } = make({ fake: lmFake, preps: new LaunchPreps({ broadcast: () => {} }), localListing: lmListing({ down: true }) });
    await rm.start(params({ model: 'opencode/big-pickle' }));
    expect(ev(log(), 'create')).toHaveLength(1);
  });

  posixIt('画面を開けなければ 400 で断り、serve を止めて行を消す', async () => {
    const { rm, manager, log } = make({ failOpen: true });
    await expect(rm.start(params())).rejects.toMatchObject({ status: 400 });
    const id = sessions()[0]?.id;
    expect(sessions().filter((s) => s.deleted_at === null)).toEqual([]);
    expect(id === undefined || manager.get(id) === null).toBe(true);
    expect(isAlive(ev(log(), 'start')[0]!.pid)).toBe(false);
  });

  posixIt('Claude だけの操作（フォーク、attach、引き取り、アカウントの切り替え）と、同期の再開（ターミナルの包み方、この PC で再開）は、opencode の会話では入口で断る', async () => {
    const { rm, log } = make();
    upsertShared(db, 'sessions', { id: 'h-oc', provider: 'opencode', provider_session_id: 'ses_old', cwd, home_device: 'd', project_id: 'p1' }, 'd');
    const unsupported = expect.objectContaining({ status: 400, message: expect.stringContaining('opencode のセッションでは使えません') });
    expect(() => rm.fork('h-oc')).toThrow(unsupported);
    expect(() => rm.attach('h-oc')).toThrow(unsupported);
    expect(() => rm.resume('h-oc')).toThrow(unsupported);
    await expect(rm.adopt('h-oc')).rejects.toThrow(unsupported);
    await expect(rm.switchAccount('h-oc', 'primary')).rejects.toThrow(unsupported);
    expect(db.prepare('select count(*) c from runs').get()).toEqual({ c: 0 });
    expect(log()).toEqual([]);
  });

  const runRow = (id: string) => db.prepare('select ended_at, end_reason, pid from runs where id = ?').get(id) as { ended_at: number | null; end_reason: string | null; pid: number | null };

  posixIt('TUI が閉じたら（tmux から消えたら）exited で閉じ、作業を interrupt して serve を止める。serve の pid を run の pid に書かない', async () => {
    const { rm, manager, opencode, log } = make({ fake: { activeIds: ['ses_busy'] } });
    const r = await rm.start(params());
    const pid = manager.get(r.sessionId)!.pid;
    // 状態の面の行（pid は serve の pid）が届いても、run の pid にはしない。TUI の生き死にとは別だからである。
    expect(opencode.live.current()).toEqual([expect.objectContaining({ pid, agent: 'opencode' })]);
    rm.linkRegistry(opencode.live.current());
    expect(runRow(r.run.id).pid).toBeNull();
    // 一覧から消えた（listed は空）。2 回の見回りで閉じる。
    rm.tick();
    expect(runRow(r.run.id).ended_at).toBeNull();
    const { ended } = rm.tick();
    expect(ended.map((e) => [e.id, e.endReason])).toEqual([[r.run.id, 'exited']]);
    await until(() => !isAlive(pid));
    const l = log();
    expect(ev(l, 'interrupt').map((e) => e.id)).toEqual(['ses_busy']);
    expect(manager.get(r.sessionId)).toBeNull();
    expect(opencode.live.current()).toEqual([]);
  });

  /** 起動時刻を Windows の書式（1601 年からの 100 ナノ秒）で書く。parseProcStart はどの OS でもこれを読む。 */
  const fileTime = (ms: number): string => String((BigInt(ms) + 11_644_473_600_000n) * 10_000n);
  /** 包み（hangar-run.sh、hangar-run.mjs）が run のログの頭に書く行を、包みの代わりに書く。 */
  const writeWrapperLog = (runId: string, pid: number): void => {
    const log = runLogPath(home, runId);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, `2026-10-25T00:00:00Z start pid=${pid} cmd=opencode\n`);
  };

  // Windows の psmux は、混んだときに一覧からセッションが一瞬抜ける（issue #258）。opencode の run には pid が無いので、包みの pid で守る。
  posixIt('一覧から抜けても、TUI の包み（run のログの start pid）が動いていれば閉じない。包みが終われば閉じて serve を止める', async () => {
    const wrapper = 777_771;
    let alive = true;
    const asked: number[] = [];
    const { rm, manager } = make({
      pidAlive: (pid) => pid === wrapper && alive,
      startTimeOf: (pid) => { asked.push(pid); return pid === wrapper ? fileTime(Date.now()) : null; },
    });
    const r = await rm.start(params());
    writeWrapperLog(r.run.id, wrapper);
    const pid = manager.get(r.sessionId)!.pid;
    for (let i = 0; i < 4; i++) expect(rm.tick().ended).toEqual([]);
    expect(runRow(r.run.id).ended_at).toBeNull();
    expect(isAlive(pid)).toBe(true);
    // 起動時刻は run ごとに 1 回だけ聞く（Windows では PowerShell を起こすため）。
    expect(asked).toEqual([wrapper]);
    alive = false;
    expect(rm.tick().ended.map((e) => [e.id, e.endReason])).toEqual([[r.run.id, 'exited']]);
    await until(() => !isAlive(pid));
  });

  posixIt('包みの pid が使い回されていたら（起動が run より前）、守らずに 2 回で閉じる', async () => {
    const wrapper = 777_772;
    const { rm } = make({ pidAlive: (pid) => pid === wrapper, startTimeOf: () => fileTime(Date.now() - 3_600_000) });
    const r = await rm.start(params());
    writeWrapperLog(r.run.id, wrapper);
    rm.tick();
    expect(rm.tick().ended.map((e) => e.id)).toEqual([r.run.id]);
  });

  // opencode の TUI が閉じても登録は変わらないので、stir されず、待機の周期（10 秒）で 2 回抜けるのを待っていた（5〜19 秒）。
  posixIt('TUI の包みが終わったら、包みの見張りで気づき、一覧から 1 回抜けただけで閉じて serve を止める', async () => {
    const wrapper = 777_773;
    let alive = true;
    const { rm, manager } = make({ pidAlive: (pid) => pid === wrapper && alive, startTimeOf: () => fileTime(Date.now()) });
    const r = await rm.start(params());
    writeWrapperLog(r.run.id, wrapper);
    const pid = manager.get(r.sessionId)!.pid;
    expect(rm.watchWrappers()).toEqual([]);
    alive = false;
    expect(rm.watchWrappers()).toEqual([r.run.id]);
    // 2 回目からは知らせ直さない。
    expect(rm.watchWrappers()).toEqual([]);
    expect(rm.tick().ended.map((e) => [e.id, e.endReason])).toEqual([[r.run.id, 'exited']]);
    await until(() => !isAlive(pid));
  });

  posixIt('包みのログがまだ無い間は見張れず、書かれたら見張る', async () => {
    const wrapper = 777_774;
    let alive = true;
    const { rm } = make({ pidAlive: (pid) => pid === wrapper && alive });
    const r = await rm.start(params());
    expect(rm.watchWrappers()).toEqual([]);
    writeWrapperLog(r.run.id, wrapper);
    expect(rm.watchWrappers()).toEqual([]);
    alive = false;
    expect(rm.watchWrappers()).toEqual([r.run.id]);
  });

  posixIt('startPolling の間は、包みが終わってから待機の周期を待たずに閉じる', async () => {
    const wrapper = 777_775;
    let alive = true;
    const { rm, manager } = make({ pidAlive: (pid) => pid === wrapper && alive, startTimeOf: () => fileTime(Date.now()) });
    const r = await rm.start(params());
    writeWrapperLog(r.run.id, wrapper);
    const pid = manager.get(r.sessionId)!.pid;
    // 起動の stir の短い周期が過ぎた後を作るため、どちらの周期も長くする。
    rm.startPolling(60_000, 60_000);
    try {
      alive = false;
      await until(() => runRow(r.run.id).ended_at !== null, 2000);
      expect(runRow(r.run.id).end_reason).toBe('exited');
      await until(() => !isAlive(pid));
    } finally {
      rm.stop();
    }
  });

  posixIt('止めた（killed）ときと区切りで止めた（parked）ときも、interrupt して serve を止める', async () => {
    const { rm, manager, log, listed, closed } = make({ fake: { activeIds: ['ses_busy'] } });
    const a = await rm.start(params());
    const pidA = manager.get(a.sessionId)!.pid;
    rm.kill(a.run.id);
    await until(() => !isAlive(pidA));
    expect(runRow(a.run.id).end_reason).toBe('killed');

    const b = await rm.start(params());
    const pidB = manager.get(b.sessionId)!.pid;
    listed.push(b.run.tmuxName);
    expect(rm.park(b.sessionId)).toBe(true);
    expect(closed).toContain(b.run.tmuxName);
    await until(() => !isAlive(pidB));
    expect(runRow(b.run.id).end_reason).toBe('parked');
    expect(ev(log(), 'interrupt')).toHaveLength(2);
  });

  posixIt('「再開」でも接続先の準備のコマンドを走らせ、進みを再開の鍵で配る。失敗したら再開せずに 400 で断る', async () => {
    const runs: string[] = [];
    let code = 0;
    const providerPreps = new ProviderPreps({
      preps: () => ({ lmstudio: { start: 'gpu up', stop: '', stopAfter: 15 } }),
      run: async (command) => { runs.push(command); return { code, tail: code ? 'no route to host' : '' }; },
      exitReason: (c) => `exit ${c}`, timeoutReason: (m) => `timeout ${m}`,
    });
    const sent: LaunchPrepDto[] = [];
    const preps = new LaunchPreps({ broadcast: (e) => { sent.push(structuredClone(e.prep)); } });
    const { rm, manager } = make({ providerPreps, preps });
    const r = await rm.start(params({ model: 'lmstudio/qwen3.8' }));
    rm.tick(); rm.tick();
    await until(() => manager.get(r.sessionId) === null);
    runs.length = 0;
    const again = await rm.resumeWith(r.sessionId, { prepKey: 'resume-key-01' });
    expect(again.run.kind).toBe('resume');
    expect(runs).toEqual(['gpu up']);
    expect(sent.filter((p) => p.key === 'resume-key-01').at(-1)).toMatchObject({ phase: 'ready', steps: [{ kind: 'command', action: 'run', state: 'done' }] });
    rm.tick(); rm.tick();
    await until(() => manager.get(r.sessionId) === null);
    code = 10;
    await expect(rm.resumeWith(r.sessionId, { prepKey: 'resume-key-02' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('no route to host') });
    expect(sent.filter((p) => p.key === 'resume-key-02').at(-1)).toMatchObject({ phase: 'failed', reason: 'no route to host' });
    expect(manager.get(r.sessionId)).toBeNull();
  });

  posixIt('準備の間は onPending で仮の行の ID を知らせ、prepRunning が真になる。進みには会話の ID を載せる（#545）', async () => {
    let release: (() => void) | null = null;
    const providerPreps = new ProviderPreps({
      preps: () => ({ lmstudio: { start: 'gpu up', stop: '', stopAfter: 15 } }),
      run: () => new Promise((res) => { release = () => res({ code: 0, tail: '' }); }),
      exitReason: (c) => `exit ${c}`, timeoutReason: (m) => `timeout ${m}`,
    });
    const sent: LaunchPrepDto[] = [];
    const preps = new LaunchPreps({ broadcast: (e) => { sent.push(structuredClone(e.prep)); } });
    const { rm } = make({ providerPreps, preps });
    let pending: string | null = null;
    const p = rm.start(params({ model: 'lmstudio/qwen3.8', prepKey: 'mcp-key-0001' }), { onPending: (id) => { pending = id; } });
    await until(() => release !== null);
    expect(pending).not.toBeNull();
    expect(rm.prepRunning('mcp-key-0001')).toBe(true);
    expect(sent.at(-1)).toMatchObject({ key: 'mcp-key-0001', sessionId: pending });
    release!();
    const r = await p;
    expect(r.sessionId).toBe(pending);
    expect(rm.prepRunning('mcp-key-0001')).toBe(false);
  });

  posixIt('「再開」は serve を新しい秘密で起こし直し、追記を PUT し直し、MCP を待ってから、-s で同じ会話につなぐ。秘密は argv に無い', async () => {
    const { rm, manager, opencode, opened, log } = make();
    const r = await rm.start(params({ prompt: '直して', autoApprove: true }));
    const id = ev(log(), 'create')[0]!.id;
    rm.tick(); rm.tick();
    await until(() => manager.get(r.sessionId) === null);
    const secret1 = ev(log(), 'start')[0]!.env.OPENCODE_CONFIG_CONTENT!;

    const again = await rm.resumeWith(r.sessionId);
    expect(again.sessionId).toBe(r.sessionId);
    expect(again.run.kind).toBe('resume');
    const l = log();
    const starts = ev(l, 'start');
    expect(starts).toHaveLength(2);
    // 新しい run の MCP の秘密で起こし直す（前の run の秘密は run の終わりで無効にしてある）。
    const config = JSON.parse(starts[1]!.env.OPENCODE_CONFIG_CONTENT!) as { mcp: { servers: { hangar: { headers: { Authorization: string } } } } };
    expect(config.mcp.servers.hangar.headers.Authorization).toBe(`Bearer ${mcpSecretFor(db, r.sessionId)!}`);
    expect(starts[1]!.env.OPENCODE_CONFIG_CONTENT).not.toBe(secret1);
    // 会話は作らない。追記を同じ会話に PUT し直し、MCP の connected を待ってから画面を開く。
    expect(ev(l, 'create')).toHaveLength(1);
    expect(ev(l, 'instructions').map((e) => e.id)).toEqual([id, id]);
    const o = opened.at(-1)!;
    expect(ev(o.log, 'mcp').filter((m) => m.pid === starts[1]!.pid).at(-1)?.status).toBe('connected');
    // -s で同じ会話につなぐ。初期プロンプトと自動承認は持ち越さない。パスワードは argv にも tmux の環境にも無い。
    const info = manager.get(r.sessionId)!;
    expect(info.pid).toBe(starts[1]!.pid);
    expect(o.command.slice(-6)).toEqual([expect.any(String), cwd, '--server', info.url, '-s', id]);
    expect(o.command.join('\n')).not.toContain(info.password);
    expect(JSON.stringify(o.env)).not.toContain(info.password);
    expect(fs.readFileSync(secretEnvPath(home, again.run.id), 'utf8')).toBe(`OPENCODE_PASSWORD=${info.password}\n`);
    // 状態の面に新しい serve で載せ直す。
    expect(opencode.live.current()).toEqual([expect.objectContaining({ sessionId: id, pid: info.pid })]);
    expect(JSON.parse((db.prepare('select launch_params from runs where id = ?').get(again.run.id) as { launch_params: string }).launch_params)).toMatchObject({ agent: 'opencode' });
  });

  posixIt('「再開」は、動いている run があれば 409、設定が切なら 400 で断り、serve を起こさない', async () => {
    let enabled = true;
    const { rm, manager, log } = make({ enabledFn: () => enabled });
    const r = await rm.start(params());
    await expect(rm.resumeWith(r.sessionId)).rejects.toMatchObject({ status: 409 });
    expect(ev(log(), 'start')).toHaveLength(1);
    rm.tick(); rm.tick();
    await until(() => manager.get(r.sessionId) === null);
    enabled = false;
    await expect(rm.resumeWith(r.sessionId)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('opencode は有効になっていません') });
    expect(ev(log(), 'start')).toHaveLength(1);
    expect(db.prepare("select count(*) c from runs where kind = 'resume'").get()).toEqual({ c: 0 });
  });

  posixIt('「この PC で再開」の取り込みの前の用意（prepareResumeDir）は、再開と同じ理由で断り、通れば場所を返す。serve は起こさない', async () => {
    let enabled = true;
    const { rm, manager, log } = make({ enabledFn: () => enabled });
    const r = await rm.start(params());
    expect(() => rm.prepareResumeDir(r.sessionId)).toThrow(expect.objectContaining({ status: 409 }) as Error);
    rm.tick(); rm.tick();
    await until(() => manager.get(r.sessionId) === null);
    const starts = ev(log(), 'start').length;
    expect(rm.prepareResumeDir(r.sessionId)).toBe((db.prepare('select cwd from sessions where id = ?').get(r.sessionId) as { cwd: string }).cwd);
    expect(ev(log(), 'start')).toHaveLength(starts);
    enabled = false;
    expect(() => rm.prepareResumeDir(r.sessionId)).toThrow(expect.objectContaining({ status: 400 }) as Error);
  });

  posixIt('引き継ぎの前の確かめ（assertCanStart）は会話のエージェントで見る。claude の無い PC でも opencode の会話は通し、opencode が切か無ければ opencode の文で断る', async () => {
    const add = (id: string, provider: string) => upsertShared(db, 'sessions', { id, provider, provider_session_id: provider === 'opencode' ? `ses_${id}` : '22222222-2222-4222-8222-222222222222', cwd, home_device: 'other', project_id: 'p1', started_at: 1, last_activity_at: 1 }, 'other');
    add('oc1', 'opencode');
    add('cc1', 'claude-code');
    // claude の無い PC（opencode だけ入れた PC）。opencode の会話は通し、Claude の会話は今までどおり claude の文で断る。
    const noClaude = make({ claudeBin: null });
    expect(() => noClaude.rm.assertCanStart('oc1')).not.toThrow();
    expect(() => noClaude.rm.assertCanStart('cc1')).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('claude が見つかりません') }) as Error);
    expect(() => noClaude.rm.assertCanStart()).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('claude が見つかりません') }) as Error);
    // opencode が切か、見つからなければ、起動と同じ文で断る。
    expect(() => make({ claudeBin: null, enabled: false }).rm.assertCanStart('oc1')).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('opencode は有効になっていません') }) as Error);
    expect(() => make({ claudeBin: null, bin: null }).rm.assertCanStart('oc1')).toThrow(expect.objectContaining({ status: 400, message: 'opencode が見つかりません（PATH を確認してください）' }) as Error);
    // 確かめるだけで、run も serve も起こさない。
    expect(db.prepare('select count(*) c from runs').get()).toEqual({ c: 0 });
    expect(ev(noClaude.log(), 'start')).toEqual([]);
  });

  posixIt('設定を切にしても、動いている会話は止めない', async () => {
    let enabled = true;
    const { rm, manager } = make({ enabledFn: () => enabled });
    const r = await rm.start(params());
    enabled = false;
    rm.linkRegistry([]);
    expect(manager.get(r.sessionId)).not.toBeNull();
    expect(runRow(r.run.id).ended_at).toBeNull();
  });

  posixIt('「再開」で serve を起こせなければ 400 で断り、run を作らず、行は消さない', async () => {
    const { rm, manager } = make();
    const r = await rm.start(params());
    rm.tick(); rm.tick();
    await until(() => manager.get(r.sessionId) === null);
    const ensure = manager.ensure.bind(manager);
    manager.ensure = () => Promise.reject(new Error('boom'));
    await expect(rm.resumeWith(r.sessionId)).rejects.toMatchObject({ status: 400 });
    manager.ensure = ensure;
    expect(sessions().filter((s) => s.deleted_at === null)).toHaveLength(1);
    expect(db.prepare("select count(*) c from runs where kind = 'resume'").get()).toEqual({ c: 0 });
    expect(mcpSecretFor(db, r.sessionId)).toBeNull();
  });

  posixIt('hangar を起こし直したあと、開いていない会話の serve を起こさない。serve を失った TUI の画面は閉じて lost にする', async () => {
    const first = make();
    const open = await first.rm.start(params());
    const closedOne = await first.rm.start(params());
    first.rm.kill(closedOne.run.id);
    // hangar の終わりで serve を全部止める（boot/opencode.ts の stop）。tmux の画面は残る。
    await first.manager.stopAll();
    const before = first.log().filter((e) => e.ev === 'start').length;

    const second = make();
    second.listed.push(open.run.tmuxName);
    const lost = second.rm.recoverAtStartup();
    expect(lost.map((e) => [e.id, e.endReason])).toEqual([[open.run.id, 'lost']]);
    expect(second.closed).toContain(open.run.tmuxName);
    second.rm.tick(); second.rm.tick();
    second.rm.linkRegistry(second.opencode.live.current());
    await new Promise((res) => setTimeout(res, 100));
    expect(second.log().filter((e) => e.ev === 'start').length).toBe(before);
    expect(second.manager.get(open.sessionId)).toBeNull();
    expect(second.manager.get(closedOne.sessionId)).toBeNull();
    // 再開すれば、その会話の serve だけを起こす。
    await second.rm.resumeWith(open.sessionId);
    expect(second.log().filter((e) => e.ev === 'start').length).toBe(before + 1);
    expect(second.manager.get(open.sessionId)).not.toBeNull();
  });

  posixIt('hangar を閉じても動いている会話の serve は残り、起こし直した hangar が引き継いで同じ会話につなぎ直す', async () => {
    const first = make({ secrets: true, fake: { activeIds: [] } });
    const open = await first.rm.start(params());
    const closedOne = await first.rm.start(params());
    first.rm.kill(closedOne.run.id);
    await until(() => first.manager.get(closedOne.sessionId) === null);
    const pid = first.manager.get(open.sessionId)!.pid;
    // hangar の終わり（boot/opencode.ts の stop）。動いている run の会話の serve は止めない。
    await first.manager.stopAll({ keep: (id) => id === open.sessionId });
    expect(isAlive(pid)).toBe(true);
    const before = first.log().filter((e) => e.ev === 'start').length;
    expect(first.log().filter((e) => e.ev === 'interrupt')).toEqual([]);

    const second = make({ secrets: true });
    expect(second.manager.adopt(adoptableServes(second.registry, (id) => id === open.sessionId))).toEqual([open.sessionId]);
    second.listed.push(open.run.tmuxName);
    const lost = second.rm.recoverAtStartup();
    expect(lost).toEqual([]);
    expect(second.closed).not.toContain(open.run.tmuxName);
    expect(runRow(open.run.id).ended_at).toBeNull();
    // 同じ serve に、作り直した合言葉でつながる。状態の面にも載り直す。
    expect(second.manager.get(open.sessionId)?.pid).toBe(pid);
    const { provider_session_id: ocId } = db.prepare('select provider_session_id from sessions where id = ?').get(open.sessionId) as { provider_session_id: string };
    await until(() => second.opencode.live.current().some((l) => l.sessionId === ocId));
    expect(second.log().filter((e) => e.ev === 'start').length).toBe(before);
    // TUI が閉じたら、引き継いだ serve もいつもどおり止める。
    second.listed.splice(0);
    second.rm.tick(); second.rm.tick();
    await until(() => !isAlive(pid));
    expect(second.manager.get(open.sessionId)).toBeNull();
    expect(second.registry.list()).toEqual([]);
  });

  posixIt('引き継いだ serve の TUI の画面が起こし直しの間に閉じていたら、run を lost で閉じて serve も止める', async () => {
    const first = make({ secrets: true });
    const open = await first.rm.start(params());
    const pid = first.manager.get(open.sessionId)!.pid;
    await first.manager.stopAll({ keep: () => true });
    const second = make({ secrets: true });
    second.manager.adopt(adoptableServes(second.registry, () => true));
    const lost = second.rm.recoverAtStartup();
    expect(lost.map((e) => [e.id, e.endReason])).toEqual([[open.run.id, 'lost']]);
    await until(() => !isAlive(pid));
    expect(second.manager.get(open.sessionId)).toBeNull();
  });

  posixIt('閉じた opencode の run の画面が一覧に戻っても生き返らせず、画面を閉じる（serve はもう無い）', async () => {
    const { rm, manager, listed, closed } = make();
    const r = await rm.start(params());
    rm.tick(); rm.tick();
    await until(() => manager.get(r.sessionId) === null);
    listed.push(r.run.tmuxName);
    rm.tick();
    expect(runRow(r.run.id).end_reason).toBe('exited');
    expect(closed).toContain(r.run.tmuxName);
  });

  posixIt('Claude の run の終わり方は変わらない（TUI が閉じても claude stop を呼ばない）', async () => {
    const { rm, listed } = make();
    const calls: string[][] = [];
    const r = await rm.start({ projectId: 'p1' });
    (rm as unknown as { deps: { procs: { runClaude: (b: string, a: string[]) => Promise<unknown> } } }).deps.procs.runClaude = async (_b, a) => { calls.push(a); return undefined; };
    expect(listed).toEqual([]);
    rm.tick(); rm.tick();
    expect(runRow(r.run.id).end_reason).toBe('exited');
    expect(calls).toEqual([]);
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

  // 外のターミナルの opencode（シェルの包みからの起動、段 D2）。端末の環境変数は届いても使わない。
  const term = (args: string[], at = cwd) => ({ cwd: at, args, env: { OPENCODE_CONFIG: '/x/opencode.json', PATH: '/from-terminal' } });

  posixIt('外のターミナルの opencode は、作業ディレクトリのプロジェクトで新しい会話を起こし、--auto と --prompt を写す。端末の環境は使わない', async () => {
    const { rm, opened, manager, bin, log } = make();
    const r = await rm.startOpencodeFromTerminal(term(['--auto', '--prompt', '直して']));
    expect(r.attached).toBe(false);
    expect(r.run.kind).toBe('start');
    const create = ev(log(), 'create');
    expect(create).toHaveLength(1);
    expect(create[0]!.body).not.toHaveProperty('id');
    expect(create[0]!.body).toMatchObject({ location: { directory: cwd } });
    expect(sessions()).toEqual([expect.objectContaining({ id: r.sessionId, provider: 'opencode', provider_session_id: create[0]!.id, project_id: 'p1', deleted_at: null })]);
    const info = manager.get(r.sessionId)!;
    expect(opened[0]!.command.slice(-9)).toEqual([bin, cwd, '--server', info.url, '-s', create[0]!.id, '--auto', '--prompt', '直して']);
    expect(JSON.stringify(opened[0]!.env)).not.toContain('/from-terminal');
    expect(opened[0]!.command.join('\n')).not.toContain('OPENCODE_CONFIG=');
    expect(ev(log(), 'start')[0]!.env.OPENCODE_CONFIG).toBeUndefined();
    expect(JSON.parse((db.prepare('select launch_params from runs where id = ?').get(r.run.id) as { launch_params: string }).launch_params)).toMatchObject({ agent: 'opencode', projectId: 'p1', autoApprove: true });
  });

  posixIt('ディレクトリの引数は作業ディレクトリからの相対で読む。プロジェクトの外なら未分類で起こす', async () => {
    fs.mkdirSync(path.join(cwd, 'sub'));
    const { rm, opened, log } = make();
    await rm.startOpencodeFromTerminal(term(['sub']));
    const sub = fs.realpathSync(path.join(cwd, 'sub'));
    expect(ev(log(), 'create')[0]!.body).toMatchObject({ location: { directory: sub } });
    expect(opened[0]!.cwd).toBe(sub);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-oc-out-'));
    try {
      const r = await rm.startOpencodeFromTerminal(term([], outside));
      expect(sessions().find((x) => x.id === r.sessionId)).toMatchObject({ provider: 'opencode', project_id: null, deleted_at: null });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  posixIt('-s の hangar の会話は、動いていればその run につなぐだけにし、止まっていれば再開して --prompt と --auto を写す', async () => {
    const { rm, opened, manager, log } = make();
    const r = await rm.start(params());
    const id = ev(log(), 'create')[0]!.id;
    const same = await rm.startOpencodeFromTerminal(term(['-s', id]));
    expect(same).toMatchObject({ attached: true, sessionId: r.sessionId, run: { id: r.run.id } });
    expect(ev(log(), 'start')).toHaveLength(1);
    rm.tick(); rm.tick();
    await until(() => manager.get(r.sessionId) === null);
    const again = await rm.startOpencodeFromTerminal(term(['--session', id, '--prompt', '続けて', '--auto']));
    expect(again).toMatchObject({ attached: false, sessionId: r.sessionId });
    expect(again.run.kind).toBe('resume');
    expect(ev(log(), 'create')).toHaveLength(1);
    const info = manager.get(r.sessionId)!;
    expect(opened.at(-1)!.command.slice(-9)).toEqual([expect.any(String), cwd, '--server', info.url, '-s', id, '--auto', '--prompt', '続けて']);
  });

  posixIt('hangar の会話でない -s は 404、知らないフラグは 400 で断り、行も serve も作らない', async () => {
    const { rm, log } = make();
    upsertShared(db, 'sessions', { id: 'h-cc', provider: 'claude-code', provider_session_id: 'ses_fromclaude', cwd, home_device: 'd', project_id: 'p1' }, 'd');
    await expect(rm.startOpencodeFromTerminal(term(['-s', 'ses_unknown']))).rejects.toMatchObject({ status: 404 });
    // Claude Code の会話は、ID が同じでも opencode の会話として開かない。
    await expect(rm.startOpencodeFromTerminal(term(['-s', 'ses_fromclaude']))).rejects.toMatchObject({ status: 404 });
    for (const a of [['-c'], ['--server', 'http://x'], ['--model', 'x']]) {
      await expect(rm.startOpencodeFromTerminal(term(a)), a.join(' ')).rejects.toMatchObject({ status: 400 });
    }
    expect(sessions().filter((x) => x.provider === 'opencode')).toEqual([]);
    expect(log()).toEqual([]);
  });

  posixIt('設定の opencode か、コマンドの横取りが切なら 400 で断る（包み方は素の opencode に回す）', async () => {
    const off = make({ enabled: false });
    await expect(off.rm.startOpencodeFromTerminal(term([]))).rejects.toMatchObject({ status: 400, message: expect.stringContaining('opencode は有効になっていません') });
    const noIntercept = make({ intercept: false });
    await expect(noIntercept.rm.startOpencodeFromTerminal(term([]))).rejects.toMatchObject({ status: 400, message: expect.stringContaining('opencode コマンドを hangar 経由で起動') });
    expect(sessions()).toEqual([]);
    expect(noIntercept.log()).toEqual([]);
  });
  posixIt('opencode の画面には目次の跳び方のキーを送らず、Claude Code の画面の互換のずれとしても数えない', async () => {
    // 跳び方（ctrl+o、G、{）は Claude Code の画面の操作である。opencode の TUI に送ると、opencode の別の小窓が開く。
    // 画面は Claude の transcript に見えるものにしておく。読みに行けば、指示の行の記号が見つからないことを 3 回目に互換のずれとして記録してしまう。
    const seen: Drift[] = [];
    const { rm, touched } = make({ screen: '  返答だけが見えている\n\n  Showing detailed transcript · ctrl+o to toggle', compat: { note: (d) => seen.push(d) } });
    upsertShared(db, 'sessions', { id: 'h-oc', provider: 'opencode', provider_session_id: 'ses_oc', cwd, home_device: 'd', project_id: 'p1' }, 'd');
    upsertShared(db, 'runs', { id: 'r-oc', session_id: 'h-oc', device_id: 'd', kind: 'start', tmux_name: 'hangar-r-oc', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, 'd');
    for (let i = 0; i < 3; i++) expect(() => rm.jumpToPrompt('r-oc', ['a'], 0, 'bottom')).toThrow(expect.objectContaining({ status: 400 }));
    expect(await rm.leaveTranscript('r-oc')).toEqual({ left: false });
    expect(touched).toEqual([]);
    expect(seen).toEqual([]);

    // 同じ RunManager でも、Claude Code の会話には今までどおり送る。
    upsertShared(db, 'sessions', { id: 'h-cc', provider: 'claude-code', provider_session_id: 'u-cc', cwd, home_device: 'd', project_id: 'p1' }, 'd');
    upsertShared(db, 'runs', { id: 'r-cc', session_id: 'h-cc', device_id: 'd', kind: 'start', tmux_name: 'hangar-r-cc', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, 'd');
    expect(await rm.jumpToPrompt('r-cc', ['a'], 0, 'bottom')).toEqual({ found: false, reason: 'notFound' });
    expect(touched.filter((t) => t[1] !== 'capture')).toContainEqual(['hangar-r-cc', 'text', 'G']);
  });
});
