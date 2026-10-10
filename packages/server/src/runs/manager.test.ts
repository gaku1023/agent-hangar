import { getSessionNote, setSessionName } from '../sessions/notes.ts';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../config/accounts.ts';
import { authMiddleware } from '../http/auth.ts';
import { runTmuxId, type RunDto, type TabDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { errorText } from '../i18n/message.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { mangleCwd } from '../provider/claude-code/transcript/discover.ts';
import { readArgs, writeFakeClaude } from '../../test/fake-claude.ts';
import { TMUX, removeDirsWhenIdle, removeTestSocket, testSocketPath, waitFor } from '../../test/tmux.ts';
import { tmuxPaneOps, type PaneOps } from '../tmux/pane.ts';
import { Tmux } from '../tmux/tmux.ts';
import { RUN_DROPPED_ENV } from '../launch/env.ts';
import { MAX_RUN_LOGS } from '../launch/wrapper.ts';
import { createMcpApp } from '../mcp/app.ts';
import { MemoStore } from '../projects/memo.ts';
import type { Drift } from '../provider/claude-code/compat/types.ts';
import type { LiveSession } from '../provider/claude-code/types.ts';
import { RunAccounts } from './accounts.ts';
import { RunManager } from './manager.ts';
import { realProcOps, type ProcOps } from '../provider/claude-code/process/procs.ts';
import { issueMcpSecret, mcpSecretFor } from './secrets.ts';
import { expectMode } from '../../test/platform.ts';

let db: Db;
let home: string;
let cwd: string;
let fake: { bin: string; argsFile: string; envFile: string };
let tmux: Tmux | null;
let claudeDir: string;
const socketPath = testSocketPath();

beforeEach(() => {
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-cwd-'));
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-claude-'));
  fs.mkdirSync(path.join(claudeDir, 'projects'));
  fake = writeFakeClaude(home);
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'pr1', project_id: 'p1', device_id: 'd', path: cwd, resolved: 1 }, 'd');
  upsertShared(db, 'projects', { id: 'p2', name: 'lost', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'pr2', project_id: 'p2', device_id: 'd', path: '/nonexistent', resolved: 0 }, 'd');
  tmux = TMUX ? new Tmux({ tmuxPath: TMUX, socketPath }) : null;
});
afterAll(() => removeTestSocket(socketPath));
afterEach(async () => {
  tmux?.killServer();
  // kill-server はペインのプロセスの終わりを待たない。起動の途中の包みがログを作るのと、消すのがぶつからないよう、書き手が居なくなってから消す。
  await removeDirsWhenIdle([home, cwd, claudeDir]);
});

/** バックグラウンドのサービスの一覧は既定で空にする。実物の口のままだと、偽の claude を一覧のために起こしてしまう。 */
const noJobs: ProcOps = { ...realProcOps, listJobs: () => [] };
type Deps = ConstructorParameters<typeof RunManager>[0];
/**
 * 試験は tmux とアカウントの一覧をそのまま渡す。RunManager が受け取る口（PaneOps、RunAccounts）へは、ここで包む。
 * panes を渡したときは、tmux を使わずにその口をそのまま使う。
 */
const make = (over: Partial<Omit<Deps, 'accounts'>> & { tmux?: Tmux | null; accounts?: AccountStore } = {}) => {
  const { tmux: t = tmux, accounts, ...rest } = over;
  return new RunManager({
    db, deviceId: 'd', home, panes: t ? tmuxPaneOps(t) : null, claudeBin: fake.bin, claudeDir, port: 4177, token: 'tok', shell: 'sh', procs: noJobs, language: () => 'ja',
    accounts: accounts ? new RunAccounts({ db, claudeDir, store: accounts }) : undefined,
    ...rest,
  });
};
/** そのセッションを最後に動かしたアカウント。 */
const accountFor = (accounts: AccountStore, sessionId: string) => new RunAccounts({ db, claudeDir, store: accounts }).accountFor(sessionId);

/** 偽の claude が記録した引数を待って読む。最後の要素は HANGAR_RUN_ID の値である。 */
const launchedArgs = async (runId: string) => {
  await waitFor(() => fs.existsSync(fake.argsFile) && readArgs(fake.argsFile).at(-1) === runId);
  return readArgs(fake.argsFile);
};

describe('RunManager.start の入力検査（tmux 不要）', () => {
  it('projectId 無し、無いプロジェクト、未解決のプロジェクトを拒む', () => {
    const rm = make({ tmux: null });
    // 文は画面のトーストに出るので、内部のキー名ではなく画面の語で書く。
    expect(() => rm.start({})).toThrow('プロジェクトを選んでください');
    expect(() => rm.start({ projectId: 'nope' })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => rm.start({ projectId: 'p2' })).toThrow(expect.objectContaining({ status: 400, message: 'プロジェクトのディレクトリがこの PC で見つかりません' }));
    expect(() => rm.start({ projectId: 'p1' })).toThrow('tmux が見つかりません。設定の「tmux のパス」を入力してください');
    expect(db.prepare('select count(*) c from sessions').get()).toEqual({ c: 0 });
    expect(db.prepare('select count(*) c from runs').get()).toEqual({ c: 0 });
  });
  it('失敗は鍵と引数で投げるので、境目は英語でも出せる', () => {
    const rm = make({ tmux: null });
    const caught = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } throw new Error('投げなかった'); };
    expect(errorText('en', caught(() => rm.start({})))).toBe('Select a project');
    expect(errorText('en', caught(() => rm.start({ projectId: 'p2' })))).toBe('The project directory was not found on this computer');
    // 文の中の設定の欄の名前も、同じ言語になる。
    expect(errorText('en', caught(() => rm.start({ projectId: 'p1' })))).toBe('tmux was not found. Enter the "tmux path" in Settings');
    expect(errorText('ja', caught(() => rm.start({ projectId: 'p1' })))).toBe('tmux が見つかりません。設定の「tmux のパス」を入力してください');
    expect(errorText('en', caught(() => rm.kill('nope')))).toBe('The Claude that was started was not found');
  });
  it('claude の場所が分からなければ、tmux を起こす前に断る', () => {
    // .app を Finder から起こすと PATH は /usr/bin:/bin:/usr/sbin:/sbin だけになり、
    // 裸の `claude` は引けない。それを tmux に渡すと、ペインの中で 127 で落ちるだけで
    // 応答は成功になり、利用者はターミナルを開くまで理由が分からない。
    // tmux はある前提にする。実物の tmux を使わない OS でも、claude の検査まで進ませる。
    const rm = make({ claudeBin: null, tmux: fakeTmux({ status: 0 }) });
    expect(() => rm.start({ projectId: 'p1' })).toThrow('claude が見つかりません。設定の「claude のパス」を入力してください');
    expect(() => rm.start({ projectId: 'p1' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => rm.start({ scratch: true })).toThrow(/claude/);
    // 断ったのだから、行も使い捨てのディレクトリも残ってはならない。
    expect(db.prepare('select count(*) c from sessions').get()).toEqual({ c: 0 });
    expect(db.prepare('select count(*) c from runs').get()).toEqual({ c: 0 });
    expect(db.prepare('select count(*) c from projects where is_scratch = 1').get()).toEqual({ c: 0 });
    expect(fs.existsSync(path.join(home, 'scratch'))).toBe(false);
  });
  it('Settings で claudePath が変わったら、次の run は新しい場所を使う', () => {
    const rm = make({ claudeBin: null });
    expect(() => rm.start({ projectId: 'p1' })).toThrow(/claude/);
    rm.setClaudeBin(fake.bin);
    expect(() => rm.start({ projectId: 'p1' })).not.toThrow(/claude/);
  });
  it('tmux が無ければ scratch は擬似プロジェクトも使い捨てディレクトリも作らない', () => {
    // 検査はすべて行を作る前に済ませる。tmux の無い端末で何度失敗しても、
    // 擬似プロジェクトの行と空のディレクトリが溜まってはならない。
    const rm = make({ tmux: null });
    for (let i = 0; i < 3; i++) expect(() => rm.start({ scratch: true })).toThrow(/tmux/);
    expect(db.prepare('select count(*) c from projects where is_scratch = 1').get()).toEqual({ c: 0 });
    expect(db.prepare('select count(*) c from project_roots').get()).toEqual({ c: 2 });
    expect(fs.existsSync(path.join(home, 'scratch'))).toBe(false);
    expect(db.prepare('select count(*) c from sessions').get()).toEqual({ c: 0 });
    expect(db.prepare('select count(*) c from runs').get()).toEqual({ c: 0 });
  });

  it('tmux new-session が失敗したら run 行は exited で閉じ、400 を投げる', () => {
    // 事前検査は通るが、tmux のバイナリが無い。行を作った後に失敗する唯一の経路である。
    const rm = make({ tmux: new Tmux({ tmuxPath: path.join(home, 'gone-tmux') }) });
    const ended: string[] = [];
    rm.on({ runEnded: (r) => ended.push(r.endReason ?? '') });
    expect(() => rm.start({ projectId: 'p1' })).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('tmux の起動に失敗しました') }));
    // 行は消さずに閉じる。起動を試みた事実は残す。
    const rows = db.prepare('select id, ended_at, end_reason from runs').all() as { id: string; ended_at: number | null; end_reason: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.end_reason).toBe('exited');
    expect(rows[0]!.ended_at).not.toBeNull();
    expect(ended).toEqual(['exited']);
    expect(rm.listAlive()).toEqual({ runs: [], tabs: [] });
    // 本文の生まれなかったセッション行は、後始末で消える。
    expect((db.prepare('select deleted_at from sessions').get() as { deleted_at: number | null }).deleted_at).not.toBeNull();
  });

  // npm で入れた古い Claude Code は claude.cmd になる。.cmd はシェル越しでしか起こせず、改行や引用符を含む引数を安全に渡せない。
  it('Windows で claude が .cmd なら、起こす前に断ってネイティブ版を案内する', () => {
    const rm = make({ claudeBin: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', tmux: fakeTmux({ status: 0 }), platform: 'win32' });
    expect(() => rm.start({ projectId: 'p1' })).toThrow(expect.objectContaining({ status: 400, message: expect.stringMatching(/claude\.exe/) }));
    expect(rm.listAlive()).toEqual({ runs: [], tabs: [] });
    // ほかの OS では .cmd という名前でも断らない。
    expect(() => make({ claudeBin: '/x/claude.cmd', tmux: fakeTmux({ status: 0 }), platform: 'darwin' }).start({ projectId: 'p1' })).not.toThrow(/claude\.exe/);
  });

  it('tmux の失敗を返すときはトークンを伏せ、1 行に切り詰める', () => {
    // 外部コマンドの stderr には何が混じるか分からないので、そのまま応答に載せない。
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
  it('続けて起こした 2 つの run は、tmux の名前が重ならず、どちらも動く', () => {
    // 名前が run の id の先頭 8 桁だけだったときは、約 65 秒の窓の中の 2 つ目が duplicate session で落ちていた。
    const rm = make();
    const a = rm.start({ projectId: 'p1', name: 'a' });
    const b = rm.start({ projectId: 'p1', name: 'b' });
    expect(a.run.tmuxName).not.toBe(b.run.tmuxName);
    expect(tmux!.hasSession(a.run.tmuxName)).toBe(true);
    expect(tmux!.hasSession(b.run.tmuxName)).toBe(true);
  });

  it('sessions 行と runs 行を作り、ラッパー経由で起動し、status off にする', async () => {
    const rm = make();
    const started: unknown[] = [];
    rm.on({ runStarted: (r) => started.push(r) });
    const r = rm.start({ projectId: 'p1', name: 'first', prompt: 'やって', model: 'opus' });
    expect(r.run).toMatchObject({ kind: 'start', sessionId: r.sessionId, deviceId: 'd', endedAt: null, endReason: null, pid: null });
    expect(r.run.tmuxName).toBe(`hangar-${runTmuxId(r.run.id)}`);
    expect(r.tabs).toEqual([{ id: r.run.id, runId: r.run.id, sessionId: r.sessionId, kind: 'agent', title: 'Claude', tmuxName: r.run.tmuxName, createdAt: r.run.startedAt, closedAt: null }]);
    expect(started).toHaveLength(1);
    expect(tmux!.hasSession(r.run.tmuxName)).toBe(true);
    expect(tmux!.run('show-options', '-t', `=${r.run.tmuxName}:`, 'status').stdout.trim()).toBe('status off');

    const args = await launchedArgs(r.run.id);
    expect(args[0]).toBe('--mcp-config');
    // 渡すのは JSON ではなくファイルのパスである。中身にトークンが入るので argv には載せない。
    expect(args[1]).toBe(path.join(home, 'mcp', `${r.sessionId}.json`));
    const cfg = JSON.parse(fs.readFileSync(args[1]!, 'utf8')) as { mcpServers: { hangar: { url: string; headers: { Authorization: string } } } };
    expect(cfg.mcpServers.hangar.url).toBe(`http://127.0.0.1:4177/mcp/s/${r.sessionId}`);
    // 渡すのは本体のトークンではなく、この run 専用の秘密である。
    expect(cfg.mcpServers.hangar.headers.Authorization).toBe(`Bearer ${mcpSecretFor(db, r.sessionId)}`);
    expect(cfg.mcpServers.hangar.headers.Authorization).not.toContain('tok');
    expect(args.at(-2)).toBe('やって');
    expect(args).toContain('--model');
    const uuid = args[args.indexOf('--session-id') + 1]!;
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);

    const s = db.prepare('select * from sessions where id = ?').get(r.sessionId) as Record<string, unknown>;
    expect(s).toMatchObject({ provider_session_id: uuid, project_id: 'p1', cwd });
    // 起動のときの名前は session_notes に入る。sessions の行には載らない。
    expect(getSessionNote(db, r.sessionId)).toEqual({ name: 'first', memo: null });
    expect(typeof s.started_at).toBe('number');
    const sys = args[args.indexOf('--append-system-prompt') + 1]!;
    expect(sys).toContain('プロジェクト：alpha（' + cwd + '）');
    expect(fs.existsSync(path.join(home, 'bin', 'hangar-run.sh'))).toBe(true);
    expect(rm.listAlive().runs.map((x) => x.id)).toEqual([r.run.id]);
    expect(rm.getRun(r.run.id)?.tmuxName).toBe(r.run.tmuxName);
    expect(rm.getTab(r.run.id)?.kind).toBe('agent');
  });

  it('選んだ権限モードは run の DTO に載り、選ばなかった起動には載らない（列は足さず、launch_params から読む）', () => {
    const rm = make();
    const chosen = rm.start({ projectId: 'p1', permissionMode: 'acceptEdits' });
    const plain = rm.start({ projectId: 'p1' });
    expect(chosen.run.permissionMode).toBe('acceptEdits');
    expect(rm.getRun(chosen.run.id)?.permissionMode).toBe('acceptEdits');
    expect(rm.listAlive().runs.find((x) => x.id === chosen.run.id)?.permissionMode).toBe('acceptEdits');
    expect(plain.run).not.toHaveProperty('permissionMode');
  });

  it('run を起こすと、外の端末からつなぐための設定を tmux サーバに入れる', () => {
    const r = make().start({ projectId: 'p1' });
    expect(tmux!.hasSession(r.run.tmuxName)).toBe(true);
    expect(tmux!.run('show-options', '-s', '-v', 'extended-keys').stdout.trim()).not.toBe('off');
    expect(tmux!.run('list-keys', '-T', 'root', 'S-Enter').stdout).toContain('hangar-');
  });

  it('run の claude には UTF-8 のロケールを渡す。tmux サーバの環境には LANG が無く、claude が日本語を写すとクリップボードが空になる', async () => {
    fake = writeFakeClaude(home, { recordEnv: ['LC_CTYPE'] });
    const r = make().start({ projectId: 'p1' });
    await launchedArgs(r.run.id);
    await waitFor(() => fs.existsSync(fake.envFile));
    expect(fs.readFileSync(fake.envFile, 'utf8')).toContain('LC_CTYPE=UTF-8\n');
  });

  it('ターミナルのシェルが文字のロケールを決めていれば、そちらを渡す', async () => {
    fake = writeFakeClaude(home, { recordEnv: ['LC_CTYPE'] });
    const r = make().startFromTerminal({ cwd, args: [], env: { LC_CTYPE: 'ja_JP.UTF-8' } });
    await launchedArgs(r.run.id);
    await waitFor(() => fs.existsSync(fake.envFile));
    expect(fs.readFileSync(fake.envFile, 'utf8')).toContain('LC_CTYPE=ja_JP.UTF-8\n');
  });

  it('シェルタブにも UTF-8 のロケールを渡す', async () => {
    const r = make().start({ projectId: 'p1' });
    const tab = make().openTab(r.run.id);
    expect(tmux!.run('show-environment', '-t', `=${tab.tmuxName}`, 'LC_CTYPE').stdout.trim()).toBe('LC_CTYPE=UTF-8');
  });

  it('scratch は新しいディレクトリを作り、スクラッチのプロジェクトに属するセッションを起動する', async () => {
    const rm = make();
    // projectId が一緒に来ても scratch を優先する。
    const r = rm.start({ scratch: true, projectId: 'p1', name: 'scratchy' });
    const s = { ...(db.prepare('select cwd, project_id from sessions where id = ?').get(r.sessionId) as { cwd: string; project_id: string }), name: getSessionNote(db, r.sessionId)?.name };
    expect(s.cwd.startsWith(path.join(home, 'scratch') + path.sep)).toBe(true);
    expect(fs.statSync(s.cwd).isDirectory()).toBe(true);
    expect(s.name).toBe('scratchy');
    expect(db.prepare('select is_scratch, name from projects where id = ?').get(s.project_id)).toEqual({ is_scratch: 1, name: 'スクラッチ' });
    const args = await launchedArgs(r.run.id);
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('プロジェクト：スクラッチ（' + s.cwd + '）');
    expect(tmux!.hasSession(r.run.tmuxName)).toBe(true);
  });

  describe('添付のある初期プロンプトは、置き場を --add-dir で渡す', () => {
    const addDirsOf = (args: string[]) => args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]!] : []));
    const attach = () => path.join(home, 'drops', '1000-0-a.png');

    it('プロンプトに置き場の直下のパスの行があれば、置き場を 1 つ渡す', async () => {
      const r = make().start({ projectId: 'p1', prompt: `見て\n\n${attach()}` });
      const args = await launchedArgs(r.run.id);
      expect(addDirsOf(args)).toEqual([path.join(home, 'drops')]);
      // 可変長のオプションが位置引数（プロンプト）を飲まない。
      expect(args.at(-2)).toBe(`見て\n\n${attach()}`);
    });
    it('利用者の addDirs が先で、置き場は後ろに 1 度だけ足す', async () => {
      const r = make().start({ projectId: 'p1', prompt: `見て\n\n'${attach()}'`, addDirs: [cwd] });
      expect(addDirsOf(await launchedArgs(r.run.id))).toEqual([cwd, path.join(home, 'drops')]);
    });
    it('すでに置き場を渡していれば重ねない', async () => {
      const r = make().start({ projectId: 'p1', prompt: attach(), addDirs: [path.join(home, 'drops')] });
      expect(addDirsOf(await launchedArgs(r.run.id))).toEqual([path.join(home, 'drops')]);
    });
    it('添付の無いプロンプトには足さない', async () => {
      const r = make().start({ projectId: 'p1', prompt: `${attach()} を見て`, addDirs: [cwd] });
      expect(addDirsOf(await launchedArgs(r.run.id))).toEqual([cwd]);
    });
    it('プロンプトが無ければ --add-dir は付かない', async () => {
      const r = make().start({ projectId: 'p1' });
      expect(addDirsOf(await launchedArgs(r.run.id))).toEqual([]);
    });
    it('run に残る起動の指定は、送られたままで、足した置き場を含まない', () => {
      const params = { projectId: 'p1', prompt: attach(), addDirs: [cwd] };
      const r = make().start(params);
      const row = db.prepare('select launch_params from runs where id = ?').get(r.run.id) as { launch_params: string };
      expect(JSON.parse(row.launch_params)).toEqual(params);
      expect(JSON.stringify(r)).not.toContain(path.join(home, 'drops'));
    });
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
    expect(() => rm.kill('nope')).toThrow(expect.objectContaining({ status: 404, message: '起動した Claude が見つかりません' }));
    expect(() => rm.kill('r0')).toThrow(expect.objectContaining({ status: 409, message: 'この Claude はもう終了しています' }));
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

  it('Claude だけが落ちても、生きているシェルタブとセッションは残る', async () => {
    const rm = make();
    const r = rm.start({ projectId: 'p1' });
    const t = rm.openTab(r.run.id);
    tmux!.killSession(r.run.tmuxName);
    await waitFor(() => !tmux!.hasSession(r.run.tmuxName));
    expect(rm.tick().ended.map((x) => x.id)).toEqual([r.run.id]);
    expect(rm.getTab(t.id)?.closedAt).toBeNull();
    expect(tmux!.hasSession(t.tmuxName)).toBe(true);
    expect((db.prepare('select deleted_at from sessions where id = ?').get(r.sessionId) as { deleted_at: number | null }).deleted_at).toBeNull();
    rm.closeTab(t.id);
    await waitFor(() => !tmux!.hasSession(t.tmuxName));
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
  it('英語では、Claude に渡す指示とシェルタブの名前が英語になる', async () => {
    const rm = make({ language: () => 'en' });
    const r = rm.start({ projectId: 'p1' });
    // 偽の claude が起ききってから閉じる。起動の途中で片付けると、後始末がログの書き込みとぶつかる。
    const args = await launchedArgs(r.run.id);
    const sys = args[args.indexOf('--append-system-prompt') + 1]!;
    expect(sys).toContain('You are a session started from agent-hangar.');
    expect(sys).toContain('Project: alpha (' + cwd + ')');
    expect(sys).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
    expect(rm.openTab(r.run.id).title).toBe('Shell 1');
    rm.kill(r.run.id);
  });
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
    expect(() => rm.openTab('nope')).toThrow(expect.objectContaining({ status: 404, message: '起動した Claude が見つかりません' }));
    const r = rm.start({ projectId: 'p1' });
    expect(() => rm.closeTab(r.run.id)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

/** 既に本文のあるセッションを作る。再開とフォークの元になる。 */
function seedOldSession(withTranscript = true): string {
  const id = ensureSession(db, 'u-old', cwd, 'd');
  const cur = db.prepare('select * from sessions where id = ?').get(id) as Record<string, unknown>;
  upsertShared(db, 'sessions', { ...cur, project_id: 'p1' }, 'd');
  setSessionName(db, 'd', id, 'old');
  if (withTranscript) addTranscript(id);
  return id;
}

/** そのセッションに本文の jsonl があることにする。 */
function addTranscript(sessionId: string): void {
  db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?)').run('/x/u-old.jsonl', sessionId, null, 10, 1, 10, 1);
}

const TERM_UUID = '480a20da-0b1b-4e20-b8f5-2b5c82124ecb';
const b64 = (x: string) => Buffer.from(x, 'utf8').toString('base64');
/** 包み方が送るのと同じ形の頼み。 */
const fromTerminal = (dir: string, args: string[], env: Record<string, string> = {}) => ({ cwd: dir, args, env });

describe('RunManager.startFromTerminal の入力検査（tmux 不要）', () => {
  it('hangar が組み立てる引数と重なるものは 400、hangar に無い会話の再開は 404 で断る', () => {
    const rm = make({ tmux: null });
    expect(() => rm.startFromTerminal(fromTerminal(cwd, ['--session-id', 'x']))).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => rm.startFromTerminal(fromTerminal(cwd, ['-r', TERM_UUID]))).toThrow(expect.objectContaining({ status: 404 }));
  });
  it('同じ会話が hangar の外で動いていれば 409 で断る。二重に開かない', () => {
    const id = ensureSession(db, TERM_UUID, cwd, 'd');
    addTranscript(id);
    const rm = make({ tmux: null, isLive: (u) => u === TERM_UUID });
    expect(() => rm.startFromTerminal(fromTerminal(cwd, ['-r', TERM_UUID]))).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe.skipIf(!TMUX)('RunManager.startFromTerminal（tmux 上）', () => {
  it('作業ディレクトリを含む最も深いプロジェクトで起動し、利用者の引数を最後に足し、環境変数を渡す', async () => {
    fake = writeFakeClaude(home, { recordEnv: ['AGENT_TEST_FROM_SHELL', 'TERM_PROGRAM'] });
    const sub = path.join(cwd, 'sub');
    fs.mkdirSync(sub);
    const rm = make();
    const r = rm.startFromTerminal(fromTerminal(sub, ['--model', 'opus', '直して'], { AGENT_TEST_FROM_SHELL: 'a b', TERM_PROGRAM: 'iTerm.app' }));
    expect(r.attached).toBe(false);
    expect(r.run.kind).toBe('start');
    const args = await launchedArgs(r.run.id);
    expect(args[0]).toBe('--mcp-config');
    expect(args).toContain('--session-id');
    expect(args.slice(-4, -1)).toEqual(['--model', 'opus', '直して']);
    const s = db.prepare('select * from sessions where id = ?').get(r.sessionId) as Record<string, unknown>;
    expect(s).toMatchObject({ project_id: 'p1', cwd: sub, provider_session_id: args[args.indexOf('--session-id') + 1] });
    await waitFor(() => fs.existsSync(fake.envFile) && fs.readFileSync(fake.envFile, 'utf8').includes('TERM_PROGRAM='));
    const env = fs.readFileSync(fake.envFile, 'utf8');
    expect(env).toContain('AGENT_TEST_FROM_SHELL=a b');
    // 外の端末の名前は渡さない。tmux の中では tmux が自分の名前を入れる。
    expect(env).not.toContain('TERM_PROGRAM=iTerm.app');
  });

  it('どのプロジェクトにも入らない作業ディレクトリは未分類で起動する', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-outside-'));
    const r = make().startFromTerminal(fromTerminal(outside, []));
    const args = await launchedArgs(r.run.id);
    const s = db.prepare('select project_id, cwd from sessions where id = ?').get(r.sessionId) as Record<string, unknown>;
    expect(s).toEqual({ project_id: null, cwd: outside });
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('未分類');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('-r <id> の会話の run が動いていれば、新しく起こさずにその run を返す', () => {
    const rm = make();
    const first = rm.startFromTerminal(fromTerminal(cwd, []));
    const uuid = (db.prepare('select provider_session_id from sessions where id = ?').get(first.sessionId) as { provider_session_id: string }).provider_session_id;
    const again = rm.startFromTerminal(fromTerminal(cwd, ['-r', uuid, '--model', 'opus']));
    expect(again.attached).toBe(true);
    expect(again.run.id).toBe(first.run.id);
    expect(rm.listAlive().runs).toHaveLength(1);
  });

  it('-r <id> の会話がバックグラウンドで動いていれば、hangar の tmux の中の claude attach でつなぐ', async () => {
    const id = ensureSession(db, TERM_UUID, cwd, 'd');
    addTranscript(id);
    const live = [{ sessionId: TERM_UUID, status: 'idle' as const, name: null, nameSource: null, cwd, pid: 777, background: { jobId: 'abcd1234' } }];
    const r = make({ live: () => live, isLive: (u) => live.some((l) => l.sessionId === u) }).startFromTerminal(fromTerminal(cwd, ['-r', TERM_UUID]));
    expect(r.attached).toBe(false);
    expect((await launchedArgs(r.run.id)).slice(0, -1)).toEqual(['attach', 'abcd1234']);
  });

  it('-r <id> の会話が止まっていれば再開し、利用者の引数を足す', async () => {
    const id = ensureSession(db, TERM_UUID, cwd, 'd');
    addTranscript(id);
    const r = make().startFromTerminal(fromTerminal(cwd, ['-r', TERM_UUID, '--effort', 'high']));
    expect(r.attached).toBe(false);
    expect(r.sessionId).toBe(id);
    expect(r.run.kind).toBe('resume');
    const args = await launchedArgs(r.run.id);
    expect(args[args.indexOf('-r') + 1]).toBe(TERM_UUID);
    expect(args.slice(-3, -1)).toEqual(['--effort', 'high']);
  });
});

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
    // 添付の置き場を渡すのは新規の起動だけで、再開には足さない。
    expect(args).not.toContain('--add-dir');
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
    expect(args).not.toContain('--add-dir');
    const s = db.prepare('select * from sessions where id = ?').get(f.sessionId) as Record<string, unknown>;
    expect(s).toMatchObject({ provider_session_id: args[i + 2], project_id: 'p1', cwd });
    // 元のセッションの名前は引き継がない。名前は Claude が本文から引き継ぎ、索引が sessions.custom_title に拾う。
    expect(getSessionNote(db, f.sessionId)).toBeNull();
    expect(args[1]).toBe(path.join(home, 'mcp', `${f.sessionId}.json`));
    expect(JSON.parse(fs.readFileSync(args[1]!, 'utf8')).mcpServers.hangar.url).toBe(`http://127.0.0.1:4177/mcp/s/${f.sessionId}`);
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

/** レジストリの 1 件。既定は VS Code などで動く対話の claude で、入力待ちである。 */
const liveEntry = (over: Partial<LiveSession> = {}): LiveSession => ({ sessionId: 'u-old', status: 'waiting', name: null, nameSource: null, cwd, pid: 4242, procStart: 'Wed Sep 30 03:01:55 2026', entrypoint: 'cli', ...over });

/** 外のプロセスに触る口の偽物。runClaude の --bg でレジストリにバックグラウンドの項目を足す。 */
function fakeProcs(live: LiveSession[], o: { startTime?: string | null; terminated?: boolean; lingers?: boolean; bgOut?: string; bgSessionId?: string; bgFails?: boolean; agentsFails?: boolean; jobs?: { id: string; sessionId: string }[] } = {}) {
  const calls: { terminate: number[]; claude: { args: string[]; cwd: string }[] } = { terminate: [], claude: [] };
  const procs: ProcOps = {
    listJobs: () => o.jobs ?? [],
    startTimeOf: () => (o.startTime === undefined ? 'Wed Sep 30 03:01:55 2026' : o.startTime),
    terminate: async (pid) => {
      calls.terminate.push(pid);
      const ok = o.terminated ?? true;
      // 止まった claude はレジストリから消える。lingers ならいつまでも残る。
      if (ok && !o.lingers) { const i = live.findIndex((l) => l.pid === pid); if (i >= 0) live.splice(i, 1); }
      return ok;
    },
    runClaude: async (_bin, args, cwd) => {
      calls.claude.push({ args, cwd });
      if (args[0] === 'agents') { if (o.agentsFails) throw new Error("'claude agents --json' is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW."); return '[]'; }
      if (args[0] !== '--bg') return '';
      if (o.bgFails) throw new Error('boom');
      const i = live.findIndex((l) => l.sessionId === 'u-old');
      if (i >= 0) live.splice(i, 1);
      live.push(liveEntry({ sessionId: o.bgSessionId ?? 'u-old', status: 'idle', pid: 5151, background: { jobId: 'abcd1234' } }));
      return o.bgOut ?? 'backgrounded · abcd1234 (idle — send a prompt to start)\n';
    },
  };
  return { procs, calls };
}

describe('attach と引き取りの入力検査（tmux 不要）', () => {
  it('attach は無いセッションに 404、バックグラウンドでないものと実行中に 409', () => {
    const live: LiveSession[] = [];
    const rm = make({ tmux: null, live: () => live });
    expect(() => rm.attach('nope')).toThrow(expect.objectContaining({ status: 404 }));
    const id = seedOldSession();
    expect(() => rm.attach(id)).toThrow(expect.objectContaining({ status: 409 }));
    live.push(liveEntry());
    expect(() => rm.attach(id)).toThrow(expect.objectContaining({ status: 409 }));
    live[0] = liveEntry({ background: { jobId: 'abcd1234' } });
    seedRun({ sessionId: id });
    expect(() => rm.attach(id)).toThrow(/実行中/);
  });

  it('動いていないもの、作業中のもの、起動時刻が合わないものは止めずに断る', async () => {
    const id = seedOldSession();
    const live: LiveSession[] = [];
    const f = fakeProcs(live, { startTime: 'Thu Oct  1 00:00:00 2026' });
    const rm = make({ tmux: null, live: () => live, procs: f.procs });
    await expect(rm.adopt(id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/実行中ではありません/) });
    live.push(liveEntry({ status: 'busy' }));
    await expect(rm.adopt(id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/作業中/) });
    // VS Code の拡張やアプリの中の claude は、止めるとその画面の側が壊れる。
    live[0] = liveEntry({ entrypoint: 'claude-vscode' });
    await expect(rm.adopt(id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/拡張/) });
    live[0] = liveEntry({ entrypoint: undefined });
    await expect(rm.adopt(id)).rejects.toMatchObject({ status: 409 });
    live[0] = liveEntry();
    // tmux が無ければ移した後につなげないので、止める前に断る。
    await expect(rm.adopt(id)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/tmux/) });
    expect(f.calls.terminate).toEqual([]);
  });

  it('pid の起動時刻がレジストリの記録と違えば止めない。古い Claude で記録が無いときも同じ', async () => {
    if (!TMUX) return;
    const id = seedOldSession();
    const live = [liveEntry()];
    const other = fakeProcs(live, { startTime: 'Thu Oct  1 00:00:00 2026' });
    await expect(make({ live: () => live, procs: other.procs }).adopt(id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/確認できませんでした/) });
    const gone = fakeProcs(live, { startTime: null });
    await expect(make({ live: () => live, procs: gone.procs }).adopt(id)).rejects.toMatchObject({ status: 409 });
    live[0] = liveEntry({ procStart: undefined });
    const old = fakeProcs(live);
    await expect(make({ live: () => live, procs: old.procs }).adopt(id)).rejects.toMatchObject({ status: 409 });
    expect([...other.calls.terminate, ...gone.calls.terminate, ...old.calls.terminate]).toEqual([]);
  });
});

describe.skipIf(!TMUX)('attach と引き取り（tmux 上）', () => {
  it('attach は tmux の中で claude attach <jobId> を起こし、指示も MCP も付けない', async () => {
    const id = seedOldSession();
    const live = [liveEntry({ status: 'idle', background: { jobId: 'abcd1234' } })];
    const r = make({ live: () => live }).attach(id);
    expect(r.sessionId).toBe(id);
    expect(r.run.kind).toBe('resume');
    expect((await launchedArgs(r.run.id)).slice(0, -1)).toEqual(['attach', 'abcd1234']);
    expect(fs.existsSync(path.join(home, 'mcp', `${id}.json`))).toBe(false);
  });

  it('引き取りは元の claude を止め、同じ id で hangar の tmux の中で再開する', async () => {
    const id = seedOldSession();
    const live = [liveEntry()];
    const f = fakeProcs(live);
    const r = await make({ live: () => live, isLive: (u) => live.some((l) => l.sessionId === u), procs: f.procs, sleep: async () => {} }).adopt(id);
    expect(f.calls.terminate).toEqual([4242]);
    // バックグラウンドには移さない。Claude Code はバックグラウンドのセッションを上限の後に自動で続けない。
    expect(f.calls.claude).toEqual([]);
    expect(r.sessionId).toBe(id);
    expect(r.run.kind).toBe('resume');
    const args = await launchedArgs(r.run.id);
    expect(args[0]).toBe('--mcp-config');
    expect(args[args.indexOf('-r') + 1]).toBe('u-old');
  });

  it('すでにバックグラウンドのセッションは止めずにつなぐだけにする', async () => {
    const id = seedOldSession();
    const live = [liveEntry({ status: 'busy', background: { jobId: 'abcd1234' } })];
    const f = fakeProcs(live);
    const r = await make({ live: () => live, procs: f.procs }).adopt(id);
    expect(f.calls.terminate).toEqual([]);
    expect((await launchedArgs(r.run.id)).slice(0, -1)).toEqual(['attach', 'abcd1234']);
  });

  it('止めてもレジストリから消えなければ、再開せずに開き直す手を添えて断る', async () => {
    const id = seedOldSession();
    const live = [liveEntry()];
    const f = fakeProcs(live, { lingers: true });
    // 待つ間は時計だけを進める。実時間で待たない。
    let t = Date.now();
    const rm = make({ live: () => live, isLive: (u) => live.some((l) => l.sessionId === u), procs: f.procs, now: () => t, sleep: async (ms) => { t += ms; } });
    await expect(rm.adopt(id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('claude --resume u-old') });
    expect(rm.listAlive().runs).toEqual([]);
  });

  it('元の claude が終わらなければ断り、再開もしない', async () => {
    const id = seedOldSession();
    const g = fakeProcs([liveEntry()], { terminated: false });
    const rm = make({ live: () => [liveEntry()], procs: g.procs });
    await expect(rm.adopt(id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/終了しませんでした/) });
    expect(rm.listAlive().runs).toEqual([]);
  });

  it('本文の無いセッションは、止める前に断る。止めた後で再開できずに終わらないようにする', async () => {
    const id = seedOldSession(false);
    const live = [liveEntry()];
    const f = fakeProcs(live);
    await expect(make({ live: () => live, procs: f.procs }).adopt(id)).rejects.toMatchObject({ status: 400 });
    expect(f.calls.terminate).toEqual([]);
  });

  it('バックグラウンドのサービスが持っていたセッションの再開は、claude attach で起こす', async () => {
    const id = seedOldSession();
    const f = fakeProcs([], { jobs: [{ id: 'abcd1234', sessionId: 'u-old' }, { id: 'ffff0000', sessionId: 'u-other' }] });
    const r = make({ live: () => [], procs: f.procs }).resume(id);
    expect(r.run.kind).toBe('resume');
    expect((await launchedArgs(r.run.id)).slice(0, -1)).toEqual(['attach', 'abcd1234']);
  });

  it('停止はバックグラウンドの本体も claude stop で止める', async () => {
    const id = seedOldSession();
    const live = [liveEntry({ status: 'idle', background: { jobId: 'abcd1234' } })];
    const f = fakeProcs(live);
    const rm = make({ live: () => live, procs: f.procs });
    const r = rm.attach(id);
    await launchedArgs(r.run.id);
    rm.kill(r.run.id);
    expect(f.calls.claude).toEqual([{ args: ['stop', 'abcd1234'], cwd }]);
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

/** 決まった終了コードと出力を返す偽の tmux。sh のスクリプトにすると Windows で起こせないので、起こす口を差し替える。 */
function fakeTmux(r: { status: number; stdout?: string; stderr?: string }): Tmux {
  return new Tmux({ tmuxPath: 'tmux', exec: () => ({ status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }) });
}

describe('アカウントの置き場と tmux サーバの環境（tmux 不要）', () => {
  // tmux の新しいセッションは、tmux サーバを起こしたシェルの環境を継ぐ。
  // 大学のアカウントのシェルから tmux サーバが起きていると、何も足さない最初のアカウントの起動まで、その置き場で動いてしまう。
  let userHome: string;
  beforeEach(() => { userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-env-')); });
  afterEach(() => fs.rmSync(userHome, { recursive: true, force: true }));
  /** new-session に渡したコマンドを拾う偽の tmux。 */
  const capture = () => {
    const calls: string[][] = [];
    const t = new Tmux({ tmuxPath: 'tmux', exec: (_file, args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; } });
    return { t, calls, launched: () => calls.find((a) => a[0] === 'new-session')! };
  };
  /**
   * new-session の引数から、claude やシェルに渡さない名前を読む。
   * 起動のコマンドは動いている OS で組む（launch/command.ts）。macOS と Linux は env -u、Windows は包みへ HANGAR_UNSET_ENV で渡す。
   */
  const unsetOf = (args: string[]): string[] => {
    if (process.platform === 'win32') return (args.find((x) => x.startsWith('HANGAR_UNSET_ENV='))?.slice('HANGAR_UNSET_ENV='.length) ?? '').split(';').filter(Boolean);
    return args.flatMap((x, i) => (x === '-u' ? [args[i + 1]!] : []));
  };

  it('最初のアカウントで起こすときは、CLAUDE_CONFIG_DIR を env -u で外す', () => {
    const accounts = new AccountStore({ home, primaryDir: claudeDir, homeDir: userHome });
    const c = capture();
    make({ accounts, tmux: c.t }).start({ projectId: 'p1' });
    expect(unsetOf(c.launched())).toContain('CLAUDE_CONFIG_DIR');
  });
  it('別のアカウントで起こすときは外さず、その置き場を渡す', () => {
    const accounts = new AccountStore({ home, primaryDir: claudeDir, homeDir: userHome });
    const a = accounts.add({ name: '大学' });
    const c = capture();
    make({ accounts, tmux: c.t }).start({ projectId: 'p1', account: a.id });
    const args = c.launched();
    expect(unsetOf(args)).not.toContain('CLAUDE_CONFIG_DIR');
    expect(args).toContain(`CLAUDE_CONFIG_DIR=${a.dir}`);
  });
  // tmux サーバを Claude Code のセッションの中から起こしていると、全体の環境にそのセッションの印が残る。
  // 印を持った claude は子のセッションと見なされ、再開の一覧から外れ、別のセッションのソケットへ話しかける。
  it('Claude Code の印と、サーバが読み終えた hangar の変数を、どのアカウントでも外す', () => {
    const accounts = new AccountStore({ home, primaryDir: claudeDir, homeDir: userHome });
    const a = accounts.add({ name: '大学' });
    for (const account of [undefined, a.id]) {
      const c = capture();
      make({ accounts, tmux: c.t }).start({ projectId: 'p1', account });
      const unset = unsetOf(c.launched());
      for (const n of RUN_DROPPED_ENV) expect(unset, n).toContain(n);
      // statusline の台本と hangar の CLI が読む置き場、run の印、包みへの合図は外さない。
      for (const n of ['HANGAR_HOME', 'HANGAR_RUN_ID', 'HANGAR_UNSET_ENV']) expect(unset, n).not.toContain(n);
    }
  });
  it('シェルのタブも、同じ名前を外してからシェルを起こす', () => {
    const c = capture();
    const rm = make({ tmux: c.t });
    const r = rm.start({ projectId: 'p1' });
    rm.openTab(r.run.id);
    const tab = c.calls.filter((x) => x[0] === 'new-session').at(-1)!;
    const command = tab.slice(tab.indexOf('--') + 1);
    // Windows の PowerShell の前には env コマンドを置けない（launch/command.ts）。
    if (process.platform === 'win32') expect(command).toEqual(['sh', '-NoLogo']);
    else {
      expect(command[0]).toBe('env');
      expect(command.slice(-2)).toEqual(['sh', '-l']);
      for (const n of RUN_DROPPED_ENV) expect(unsetOf(tab), n).toContain(n);
    }
  });
});

describe.skipIf(!TMUX)('tmux サーバの全体の環境が汚れているとき（tmux 上）', () => {
  // 専用のソケットの tmux サーバを、Claude Code のセッションの印を持った環境から起こす。
  // 2026-10-08 に、利用者の既定の tmux サーバがこの状態になっていた。値は形だけである。
  const dirty = { ...Object.fromEntries(RUN_DROPPED_ENV.map((n) => [n, 'leak'])), CLAUDE_CODE_USE_BEDROCK: '1', HANGAR_HOME: '/leak/home' };
  beforeEach(() => {
    new Tmux({ tmuxPath: TMUX!, socketPath, env: dirty }).newSession({ name: 'hangar-test-dirty', cwd, command: ['sh', '-c', 'sleep 30'] });
  });
  const lines = (file: string): Map<string, string> =>
    new Map(fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  it('claude には印を渡さず、利用者の設定と hangar の置き場は渡す', async () => {
    fake = writeFakeClaude(home, { recordEnv: [...RUN_DROPPED_ENV, 'CLAUDE_CODE_USE_BEDROCK', 'HANGAR_HOME'] });
    const r = make().start({ projectId: 'p1' });
    expect(await launchedArgs(r.run.id)).toContain(r.run.id);
    await waitFor(() => fs.existsSync(fake.envFile) && lines(fake.envFile).has('HANGAR_HOME'));
    const env = lines(fake.envFile);
    for (const n of RUN_DROPPED_ENV) expect(env.get(n), n).toBe('');
    expect(env.get('CLAUDE_CODE_USE_BEDROCK')).toBe('1');
    // statusline の台本と hangar の CLI が、claude の中でこの値から置き場を知る。
    expect(env.get('HANGAR_HOME')).toBe('/leak/home');
  });

  it('シェルのタブにも印を渡さない', async () => {
    const out = path.join(home, 'tab-env.txt');
    const shell = path.join(home, 'fake-shell');
    fs.writeFileSync(shell, `#!/bin/sh\nenv > "${out}.tmp" && mv "${out}.tmp" "${out}"\nsleep 30\n`, { mode: 0o755 });
    const rm = make({ shell });
    const r = rm.start({ projectId: 'p1' });
    rm.openTab(r.run.id);
    await waitFor(() => fs.existsSync(out));
    const env = lines(out);
    for (const n of RUN_DROPPED_ENV) expect(env.has(n), n).toBe(false);
    expect(env.get('CLAUDE_CODE_USE_BEDROCK')).toBe('1');
  });
});

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
    const rm = make({ tmux: fakeTmux({ status: 1, stderr: 'lost server\n' }) });
    expect(rm.recoverAtStartup()).toEqual([]);
    expect(rm.getRun('r1')?.endedAt).toBeNull();
    expect(rm.getTab('t1')?.closedAt).toBeNull();
  });

  it('tmux サーバが動いていないだけなら、run もタブも閉じる', () => {
    // 呼び出しは成功していて、本当にセッションが 1 つも無い。これは観測できている。
    seedRun();
    const rm = make({ tmux: fakeTmux({ status: 1, stderr: 'no server running on /tmp/tmux-501/default\n' }) });
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

  it('生きたシェルタブが残っている run では消さない（tick 経由）', () => {
    // Claude の tmux セッションだけが消え、シェルタブは動いている状態。
    // ここで消すと、生きているシェルに UI から到達も停止もできなくなる。
    const { runId, sessionId, tabId } = seedRun();
    const rm = make({ tmux: fakeTmux({ status: 0, stdout: 'hangar-r1-t1\n' }) });
    expect(rm.tick().ended.map((x) => x.id)).toEqual([runId]);
    expect(rm.getTab(tabId)?.closedAt).toBeNull();
    expect(deletedAt(sessionId)).toBeNull();
  });

  it('シェルタブも消えていれば tick 経由でも消す', () => {
    const { runId, sessionId } = seedRun();
    const rm = make({ tmux: fakeTmux({ status: 0 }) });
    expect(rm.tick().ended.map((x) => x.id)).toEqual([runId]);
    expect(deletedAt(sessionId)).not.toBeNull();
  });

  it('claudeDir が読めないときは見送る。観測できないことと本文が無いことは違う', () => {
    const { runId, sessionId } = seedRun();
    const rm = make({ tmux: null, claudeDir: '/nonexistent/claude' });
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

describe('run のログの掃除（tmux 不要）', () => {
  it('起動のたびに古いログを落とし、動いている run のログは残す', () => {
    // ログは run ごとに増える。消す経路が無いと、使うほど際限なく溜まる。
    const logs = path.join(home, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const put = (runId: string, mtime: number) => {
      const f = path.join(logs, `run-${runId}.log`);
      fs.writeFileSync(f, 'x');
      fs.utimesSync(f, mtime, mtime);
    };
    // r1 は動いている run のログで、いちばん古い。
    seedRun();
    put('r1', 1);
    const old = Array.from({ length: MAX_RUN_LOGS + 5 }, (_, i) => `old${i}`);
    old.forEach((id, i) => put(id, 1000 + i));

    // tmux を呼ばずに起動を最後まで通す。ログの掃除だけを見たい。
    make({ tmux: fakeTmux({ status: 0 }) }).start({ projectId: 'p1' });

    const names = fs.readdirSync(logs);
    expect(names).toContain('run-r1.log');
    expect(names).toHaveLength(MAX_RUN_LOGS + 1);
    expect(names).toContain(`run-${old.at(-1)}.log`);
    expect(names).not.toContain('run-old0.log');
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

describe('transcript の中の指示へ跳ぶ（tmux 不要）', () => {
  /** 画面はいつも transcript で、指示 a が見えている。送ったキーを記録する。 */
  function paneTmux() {
    const sent: string[][] = [];
    const tmux = {
      capturePane: (name: string) => { sent.push(['capture', name]); return '❯ a\n\n  Showing detailed transcript · ctrl+o to toggle'; },
      sendKeys: (name: string, ...keys: string[]) => { sent.push([name, ...keys]); },
    } as unknown as Tmux;
    return { tmux, sent };
  }

  it('run の Claude のタブへ、1 文字ずつ -l で送る', async () => {
    const { runId } = seedRun();
    const { tmux, sent } = paneTmux();
    const rm = make({ tmux });
    expect(await rm.jumpToPrompt(runId, ['a', 'b'], 0, 'bottom')).toEqual({ found: true });
    const keys = sent.filter((s) => s[0] !== 'capture');
    expect(keys).toEqual([[`hangar-${runId}`, '-l', 'G'], [`hangar-${runId}`, '-l', '{'], [`hangar-${runId}`, '-l', '{']]);
  });

  it('指示の行の記号は、続けて 3 回見つからなかったときに初めて互換のずれとして記録する', async () => {
    // 描き直しの遅れなどで 1 回見つからないことは普段でも起きる。1 回ごとに記録すると誤報になる。
    const { runId } = seedRun();
    const tmux = {
      capturePane: () => '  返答だけが見えている\n\n  Showing detailed transcript · ctrl+o to toggle',
      sendKeys: () => {},
    } as unknown as Tmux;
    const seen: Drift[] = [];
    const rm = make({ tmux, compat: { note: (d) => seen.push(d) } });
    expect(await rm.jumpToPrompt(runId, ['a'], 0, 'bottom')).toEqual({ found: false, reason: 'notFound' });
    expect(await rm.jumpToPrompt(runId, ['a'], 0, 'bottom')).toEqual({ found: false, reason: 'notFound' });
    expect(seen).toEqual([]);
    expect(await rm.jumpToPrompt(runId, ['a'], 0, 'bottom')).toEqual({ found: false, reason: 'notFound' });
    expect(seen).toEqual([{ contract: 'screen', value: 'prompt-marker=(missing)', version: null }]);
  });

  it('終わった run と知らない run には送らない', async () => {
    const { runId } = seedRun({ endedAt: 2 });
    const { tmux, sent } = paneTmux();
    const rm = make({ tmux });
    expect(() => rm.jumpToPrompt(runId, ['a'], 0, 'bottom')).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => rm.leaveTranscript('nope')).toThrow(expect.objectContaining({ status: 404 }));
    expect(sent).toEqual([]);
  });
});

describe('画面の口を偽物に差し替える（tmux 不要）', () => {
  /** 名前の集合だけを持つ偽の画面。tmux もプロセスも起こさない。 */
  function fakePanes() {
    const open = new Map<string, { cwd: string; command: string[]; env: Record<string, string> }>();
    const calls: string[] = [];
    const sent: string[][] = [];
    /** transcript で、指示 a が見えている画面。 */
    const TRANSCRIPT = '❯ a\n\n  Showing detailed transcript · ctrl+o to toggle';
    let screen = '❯ \n';
    const panes: PaneOps = {
      open: (o) => {
        if (open.has(o.name)) throw new Error(`duplicate: ${o.name}`);
        open.set(o.name, { cwd: o.cwd, command: o.command, env: o.env ?? {} });
        calls.push(`open ${o.name}`);
      },
      close: (name) => { open.delete(name); calls.push(`close ${name}`); },
      list: () => [...open.keys()],
      capture: () => screen,
      sendText: (name, text) => { sent.push([name, 'text', text]); },
      sendKey: (name, key) => { sent.push([name, 'key', key]); screen = TRANSCRIPT; },
      prepareForOutsideTerminals: () => { calls.push('prepare'); },
    };
    return { panes, open, calls, sent };
  }

  it('起動、シェルタブ、見張り、停止が、口だけを通って動く', () => {
    const f = fakePanes();
    const rm = make({ panes: f.panes });
    const r = rm.start({ projectId: 'p1' });
    const pane = f.open.get(r.run.tmuxName)!;
    expect(pane.cwd).toBe(cwd);
    expect(pane.command).toContain(fake.bin);
    // run の印は、OS によってコマンドか環境のどちらかで渡る（launch/command.ts）。
    expect([...pane.command, ...Object.entries(pane.env).map(([k, v]) => `${k}=${v}`)]).toContain(`HANGAR_RUN_ID=${r.run.id}`);
    // 外の端末のための設定は run の起動のときだけ確かめる。シェルタブでは確かめない。
    const tab = rm.openTab(r.run.id);
    expect(f.calls).toEqual([`open ${r.run.tmuxName}`, 'prepare', `open ${tab.tmuxName}`]);
    expect(f.open.get(tab.tmuxName)!.cwd).toBe(cwd);
    expect(rm.tick()).toEqual({ ended: [], closedTabs: [] });
    // シェルタブが自分で終わったら、見張りがタブだけを閉じる。
    f.open.delete(tab.tmuxName);
    expect(rm.tick().closedTabs.map((t) => t.id)).toEqual([tab.id]);
    expect(rm.kill(r.run.id).endReason).toBe('killed');
    expect(f.open.size).toBe(0);
    expect(f.calls.at(-1)).toBe(`close ${r.run.tmuxName}`);
  });

  it('画面が自分で消えたら、見張りが run を exited で閉じる', () => {
    const f = fakePanes();
    const rm = make({ panes: f.panes });
    const r = rm.start({ projectId: 'p1' });
    f.open.clear();
    expect(rm.tick().ended.map((e) => [e.id, e.endReason])).toEqual([[r.run.id, 'exited']]);
  });

  it('画面を作れなかったら、run を閉じて 400 を投げる', () => {
    const f = fakePanes();
    const rm = make({ panes: { ...f.panes, open: () => { throw new Error('no room'); } } });
    expect(() => rm.start({ projectId: 'p1' })).toThrow(expect.objectContaining({ status: 400, message: 'tmux の起動に失敗しました: no room' }));
    expect(rm.listAlive().runs).toEqual([]);
  });

  it('観測できなかった見回りでは何も閉じない', () => {
    const f = fakePanes();
    const rm = make({ panes: f.panes });
    const r = rm.start({ projectId: 'p1' });
    rm.setPanes({ ...f.panes, list: () => null });
    expect(rm.tick()).toEqual({ ended: [], closedTabs: [] });
    expect(rm.getRun(r.run.id)!.endedAt).toBeNull();
  });

  it('transcript へ跳ぶときは、ctrl+o をキーとして、ほかを文字として送る', async () => {
    const f = fakePanes();
    const rm = make({ panes: f.panes });
    const { runId } = seedRun();
    // はじめは入力欄の画面。ctrl+o で transcript に切り替わる。
    expect(await rm.jumpToPrompt(runId, ['a', 'b'], 0, 'bottom')).toEqual({ found: true });
    expect(f.sent).toEqual([[`hangar-${runId}`, 'key', 'ctrl+o'], [`hangar-${runId}`, 'text', 'G'], [`hangar-${runId}`, 'text', '{'], [`hangar-${runId}`, 'text', '{']]);
    f.sent.length = 0;
    expect(await rm.leaveTranscript(runId)).toEqual({ left: true });
    expect(f.sent).toEqual([[`hangar-${runId}`, 'text', 'q']]);
  });
});

describe('addDirs の検査（tmux 不要）', () => {
  it('- で始まる値は 400 で弾き、行を作らない', () => {
    // --add-dir は可変長オプションなので、値がそのまま claude のフラグとして食われる。
    const rm = make({ tmux: null });
    expect(() => rm.start({ projectId: 'p1', addDirs: ['--dangerously-skip-permissions'] })).toThrow(expect.objectContaining({ status: 400, message: '追加ディレクトリに - で始まる値は使えません: --dangerously-skip-permissions' }));
    expect(() => rm.start({ projectId: 'p1', addDirs: ['-p'] })).toThrow(/追加ディレクトリ/);
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

describe.skipIf(!TMUX)('トークンを argv に載せない（tmux 上）', () => {
  // 64 桁の 16 進。実物のトークンと同じ形にして、ps から拾えないことを確かめる。
  const TOKEN = 'a1b2c3d4'.repeat(8);

  it('claude の argv にトークンが出ず、ps からも読めない', async () => {
    const rm = make({ token: TOKEN });
    const r = rm.start({ projectId: 'p1' });
    const args = await launchedArgs(r.run.id);
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(args.join(' ')).not.toContain('Bearer');

    const cfgPath = args[1]!;
    expectMode(cfgPath, 0o600);
    // 設定ファイルにも本体のトークンは書かない。入るのはこの run 専用の秘密だけである。
    expect(fs.readFileSync(cfgPath, 'utf8')).not.toContain(TOKEN);
    expect(fs.readFileSync(cfgPath, 'utf8')).toContain(`Bearer ${mcpSecretFor(db, r.sessionId)}`);

    // 実際に ps で確かめる。偽の claude が動いている間に読む。
    const ps = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' });
    expect(ps).toContain('fake-claude');
    expect(ps).not.toContain(TOKEN);

    // run が終わったら設定ファイルは残さない。
    rm.kill(r.run.id);
    expect(fs.existsSync(cfgPath)).toBe(false);
  });

  it('消し忘れた設定ファイルは、次の起動と起動時の回復で拾う', async () => {
    const rm = make({ token: TOKEN });
    const stale = path.join(home, 'mcp', '00000000-0000-7000-8000-000000000000.json');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, '{}', { mode: 0o600 });
    const r = rm.start({ projectId: 'p1' });
    await launchedArgs(r.run.id);
    expect(fs.existsSync(stale)).toBe(false);
    // 動いている run のものは残す。
    expect(fs.existsSync(path.join(home, 'mcp', `${r.sessionId}.json`))).toBe(true);

    fs.writeFileSync(stale, '{}', { mode: 0o600 });
    make({ token: TOKEN, tmux: null }).recoverAtStartup();
    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe.skipIf(!TMUX)('run に配る秘密は、その run の入口しか開けない（tmux 上）', () => {
  // 64 桁の 16 進。実物のトークンと同じ形にする。
  const TOKEN = 'a1b2c3d4'.repeat(8);
  const rpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  const hdr = (secret: string) => ({ authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
  const mcp = () => createMcpApp({ db, deviceId: 'd', port: 4177, token: TOKEN, live: () => [], runs: { start: () => { throw new Error('not in this test'); } },
    usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }), memos: new MemoStore({ db, deviceId: 'd', home }) });

  /** --mcp-config に書かれた鍵。閉じ込められた claude が自分で読める唯一の鍵である。 */
  const credential = (cfgPath: string): string => (JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { mcpServers: { hangar: { headers: { Authorization: string } } } }).mcpServers.hangar.headers.Authorization.replace('Bearer ', '');

  it('設定ファイルの鍵は本体のトークンではなく、共通 /mcp を開けない', async () => {
    const rm = make({ token: TOKEN });
    const r = rm.start({ projectId: 'p1' });
    const args = await launchedArgs(r.run.id);
    const got = credential(args[1]!);
    expect(got).not.toBe(TOKEN);
    expect(got).toBe(mcpSecretFor(db, r.sessionId));
    const app = mcp();
    // 自分の入口は開く。
    expect((await app.request(`/s/${r.sessionId}`, { method: 'POST', headers: hdr(got), body: rpcBody })).status).toBe(200);
    // 共通の入口は開かない。ここが開くと、他のプロジェクトのメモに書けてしまう。
    expect((await app.request('/', { method: 'POST', headers: hdr(got), body: rpcBody })).status).toBe(401);
    // /api も開かない。
    const api = new Hono();
    api.use('*', authMiddleware(TOKEN, 4177));
    api.get('/bootstrap', (c) => c.json({ ok: true }));
    expect((await api.request('/bootstrap', { headers: hdr(got) })).status).toBe(401);
  });

  it('run が終わったら秘密は無効になる', async () => {
    const rm = make({ token: TOKEN });
    const r = rm.start({ projectId: 'p1' });
    const args = await launchedArgs(r.run.id);
    const got = credential(args[1]!);
    rm.kill(r.run.id);
    expect(mcpSecretFor(db, r.sessionId)).toBeNull();
    expect((await mcp().request(`/s/${r.sessionId}`, { method: 'POST', headers: hdr(got), body: rpcBody })).status).toBe(401);
  });

  it('消し忘れた秘密は、次の起動と起動時の回復で拾う', async () => {
    const rm = make({ token: TOKEN });
    issueMcpSecret(db, '00000000-0000-7000-8000-000000000000', 1);
    const r = rm.start({ projectId: 'p1' });
    await launchedArgs(r.run.id);
    expect(mcpSecretFor(db, '00000000-0000-7000-8000-000000000000')).toBeNull();
    expect(mcpSecretFor(db, r.sessionId)).not.toBeNull();

    issueMcpSecret(db, '00000000-0000-7000-8000-000000000000', 1);
    make({ token: TOKEN, tmux: null }).recoverAtStartup();
    expect(mcpSecretFor(db, '00000000-0000-7000-8000-000000000000')).toBeNull();
  });
});

describe('区切りを付けたセッションを止める（tmux 不要）', () => {
  /** シェルのタブの tmux セッションだけが残っている偽の tmux。Claude のセッションは落とせたことになる。 */
  const tmuxWithoutRun = () => fakeTmux({ status: 0, stdout: 'hangar-r1-t1\n' });

  it('落とせたことを tmux で確かめてから、run を parked で終わらせる。シェルのタブは残す', () => {
    const { runId, sessionId, tabId } = seedRun();
    addTranscript(sessionId);
    const rm = make({ tmux: tmuxWithoutRun() });
    const ended: RunDto[] = [];
    rm.on({ runEnded: (r) => ended.push(r) });
    expect(rm.park(sessionId)).toBe(true);
    expect(ended.map((r) => [r.id, r.endReason])).toEqual([[runId, 'parked']]);
    expect(rm.getRun(runId)!.endedAt).not.toBeNull();
    // kill と違い、タブは閉じない。動かしていたサーバなどを黙って落とさない。
    expect(rm.getTab(tabId)).not.toBeNull();
    expect(rm.tick()).toEqual({ ended: [], closedTabs: [] });
  });

  it('tmux が無ければ何もしない。止められていないのに run を閉じると、動いている claude を見失う', () => {
    const { runId, sessionId } = seedRun();
    addTranscript(sessionId);
    const rm = make({ tmux: null });
    expect(rm.park(sessionId)).toBe(false);
    expect(rm.getRun(runId)!.endedAt).toBeNull();
  });

  it('tmux を呼べなかったときは run を閉じず、次の見回りで消えたのを見てから parked で閉じる', () => {
    const { runId, sessionId } = seedRun();
    addTranscript(sessionId);
    const rm = make({ tmux: fakeTmux({ status: 1, stderr: 'lost server\n' }) });
    expect(rm.park(sessionId)).toBe(true);
    expect(rm.getRun(runId)!.endedAt).toBeNull();
    rm.setPanes(tmuxPaneOps(tmuxWithoutRun()));
    expect(rm.tick().ended.map((r) => [r.id, r.endReason])).toEqual([[runId, 'parked']]);
  });

  it('落としたはずのセッションが残っていたら、run は閉じない。後で自分で終わったら exited にする', () => {
    const { runId, sessionId } = seedRun();
    addTranscript(sessionId);
    const rm = make({ tmux: fakeTmux({ status: 0, stdout: 'hangar-r1\nhangar-r1-t1\n' }) });
    expect(rm.park(sessionId)).toBe(true);
    expect(rm.getRun(runId)!.endedAt).toBeNull();
    expect(rm.tick().ended).toEqual([]);
    rm.setPanes(tmuxPaneOps(tmuxWithoutRun()));
    expect(rm.tick().ended.map((r) => [r.id, r.endReason])).toEqual([[runId, 'exited']]);
  });

  it('止めるものが無ければ偽を返し、何も終わらせない', () => {
    const { sessionId } = seedRun({ endedAt: 5 });
    const rm = make({ tmux: tmuxWithoutRun() });
    const ended: RunDto[] = [];
    rm.on({ runEnded: (r) => ended.push(r) });
    expect(rm.park(sessionId)).toBe(false);
    expect(rm.park('nope')).toBe(false);
    expect(ended).toEqual([]);
  });

  it('他の端末の run は止めない', () => {
    const { runId, sessionId } = seedRun();
    const row = db.prepare('select * from runs where id = ?').get(runId) as Record<string, unknown>;
    upsertShared(db, 'runs', { ...row, device_id: 'other' }, 'other');
    const rm = make({ tmux: tmuxWithoutRun() });
    expect(rm.park(sessionId)).toBe(false);
    expect(rm.getRun(runId)!.endedAt).toBeNull();
  });

  it('hangar の run が無いバックグラウンドのセッションは、本体を claude stop で止める', () => {
    const id = seedOldSession();
    const live = [liveEntry({ status: 'idle', background: { jobId: 'abcd1234' } })];
    const f = fakeProcs(live);
    const rm = make({ tmux: null, live: () => live, procs: f.procs });
    expect(rm.park(id)).toBe(true);
    expect(f.calls.claude).toEqual([{ args: ['stop', 'abcd1234'], cwd }]);
  });

  it('外のターミナルで動く claude（run もバックグラウンドの id も無い）は止めない', () => {
    const id = seedOldSession();
    const live = [liveEntry({ status: 'idle' })];
    const f = fakeProcs(live);
    const rm = make({ tmux: tmuxWithoutRun(), live: () => live, procs: f.procs });
    expect(rm.park(id)).toBe(false);
    expect(f.calls.claude).toEqual([]);
    expect(f.calls.terminate).toEqual([]);
  });
});

describe.skipIf(!TMUX)('区切りを付けたセッションを止める（tmux 上）', () => {
  it('Claude の tmux セッションだけを落とし、シェルのタブの tmux セッションは残す', async () => {
    const rm = make();
    const r = rm.start({ projectId: 'p1' });
    await launchedArgs(r.run.id);
    addTranscript(r.sessionId);
    const t1 = rm.openTab(r.run.id);
    expect(rm.park(r.sessionId)).toBe(true);
    await waitFor(() => !tmux!.hasSession(r.run.tmuxName));
    expect(tmux!.hasSession(t1.tmuxName)).toBe(true);
    expect(rm.getRun(r.run.id)!.endReason).toBe('parked');
    // 終わった run でも、開いたシェルのタブがあれば一覧に残る。
    expect(rm.listAlive().tabs.map((t) => t.id)).toContain(t1.id);
    rm.closeTab(t1.id);
  });
});

describe.skipIf(!TMUX)('アカウント', () => {
  let userHome: string;
  let accounts: AccountStore;
  const envOf = async (runId: string) => {
    await launchedArgs(runId);
    // 偽の claude は起動のたびに 1 行を足すので、最後の行がこの run のものである。
    return fs.readFileSync(fake.envFile, 'utf8').trimEnd().split('\n').at(-1) + '\n';
  };
  beforeEach(() => {
    userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-user-'));
    fake = writeFakeClaude(home, { recordEnv: ['CLAUDE_CONFIG_DIR'] });
    accounts = new AccountStore({ home, primaryDir: claudeDir, homeDir: userHome });
  });
  afterEach(() => fs.rmSync(userHome, { recursive: true, force: true }));
  const params = (runId: string) => JSON.parse((db.prepare('select launch_params from runs where id = ?').get(runId) as { launch_params: string }).launch_params) as { account?: string };

  it('最初のアカウントでは CLAUDE_CONFIG_DIR を足さず、run に primary と残す', async () => {
    const r = make({ accounts }).start({ projectId: 'p1' });
    expect(await envOf(r.run.id)).toBe('CLAUDE_CONFIG_DIR=\n');
    expect(params(r.run.id).account).toBe('primary');
  });

  it('アカウントを指定すると、置き場のリンクを張ってから、その置き場で起こす', async () => {
    const a = accounts.add({ name: '大学' });
    const r = make({ accounts }).start({ projectId: 'p1', account: a.id });
    expect(await envOf(r.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
    expect(fs.readlinkSync(path.join(a.dir, 'projects'))).toBe(path.join(claudeDir, 'projects'));
    expect(params(r.run.id).account).toBe(a.id);
  });

  it('指定が無ければ、いまのアカウントで起こす', async () => {
    const a = accounts.add({ name: '大学' });
    accounts.setCurrent(a.id);
    const r = make({ accounts }).start({ projectId: 'p1' });
    expect(await envOf(r.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
  });

  it('知らないアカウントは 400 で断り、セッションの行を作らない', () => {
    const before = (db.prepare('select count(*) n from sessions').get() as { n: number }).n;
    expect(() => make({ accounts }).start({ projectId: 'p1', account: 'nope' })).toThrow('アカウントが見つかりません');
    expect((db.prepare('select count(*) n from sessions').get() as { n: number }).n).toBe(before);
  });

  it('リンクの場所に実ファイルがあれば 400 で断り、ファイルは残す', () => {
    const a = accounts.add({ name: '大学' });
    fs.mkdirSync(a.dir);
    fs.mkdirSync(path.join(a.dir, 'projects'));
    const before = (db.prepare('select count(*) n from sessions').get() as { n: number }).n;
    expect(() => make({ accounts }).start({ projectId: 'p1', account: a.id })).toThrow('置き場の projects が共有のリンクではありません');
    expect(fs.lstatSync(path.join(a.dir, 'projects')).isDirectory()).toBe(true);
    expect((db.prepare('select count(*) n from sessions').get() as { n: number }).n).toBe(before);
  });

  it('再開は最後に動かしたアカウントで起こす。消えたアカウントは最初のアカウントに落とす', async () => {
    const a = accounts.add({ name: '大学' });
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1', account: a.id });
    await envOf(first.run.id);
    // 本文の無い start は閉じるときにセッションの行ごと消えるので、先に本文があることにする。
    addTranscript(first.sessionId);
    m.kill(first.run.id);
    expect(accountFor(accounts, first.sessionId)).toBe(a.id);
    const again = m.resume(first.sessionId);
    expect(await envOf(again.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
    m.kill(again.run.id);
    accounts.remove(a.id);
    expect(accountFor(accounts, first.sessionId)).toBe('primary');
  });

  it('ターミナルから：CLAUDE_CONFIG_DIR が無ければいまのアカウント、登録済みの置き場ならそのアカウント、未登録ならそのまま渡して記録しない', async () => {
    const a = accounts.add({ name: '大学' });
    const b = accounts.add({ name: '個人' });
    accounts.setCurrent(a.id);
    // run の tmux 名は uuid の先頭 8 桁で、約 65 秒の刻みで重なる。生きたままだと次の起動が断られるので、確かめたら止める。
    const m = make({ accounts });
    const r1 = m.startFromTerminal(fromTerminal(cwd, [], { PATH: process.env.PATH ?? '' }));
    expect(await envOf(r1.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
    expect(params(r1.run.id).account).toBe(a.id);
    m.kill(r1.run.id);
    const r2 = m.startFromTerminal(fromTerminal(cwd, [], { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: b.dir + '/' }));
    expect(await envOf(r2.run.id)).toBe(`CLAUDE_CONFIG_DIR=${b.dir}/\n`);
    expect(params(r2.run.id).account).toBe(b.id);
    m.kill(r2.run.id);
    const r3 = m.startFromTerminal(fromTerminal(cwd, [], { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: '/elsewhere' }));
    expect(await envOf(r3.run.id)).toBe('CLAUDE_CONFIG_DIR=/elsewhere\n');
    expect(params(r3.run.id).account).toBeUndefined();
  });

  it('ターミナルから再開するとき、未登録の置き場を付けたら、最後のアカウントを記録しない', async () => {
    const a = accounts.add({ name: '大学' });
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1', account: a.id });
    await envOf(first.run.id);
    // 本文の無い start は閉じるときにセッションの行ごと消えるので、先に本文があることにする。
    addTranscript(first.sessionId);
    m.kill(first.run.id);
    const uuid = (db.prepare('select provider_session_id p from sessions where id = ?').get(first.sessionId) as { p: string }).p;
    const r = m.startFromTerminal(fromTerminal(cwd, ['-r', uuid], { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: '/elsewhere' }));
    expect(await envOf(r.run.id)).toBe('CLAUDE_CONFIG_DIR=/elsewhere\n');
    expect(params(r.run.id).account).toBeUndefined();
  });

  it('フォークは、最後に動かしたアカウントの置き場のリンクが壊れていれば 400 で断り、セッションの行を作らない', async () => {
    const a = accounts.add({ name: '大学' });
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1', account: a.id });
    await envOf(first.run.id);
    addTranscript(first.sessionId);
    m.kill(first.run.id);
    // リンクを実ディレクトリに置き換えて壊す。
    fs.rmSync(path.join(a.dir, 'projects'));
    fs.mkdirSync(path.join(a.dir, 'projects'));
    const before = (db.prepare('select count(*) n from sessions').get() as { n: number }).n;
    expect(() => m.fork(first.sessionId)).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('置き場の projects が共有のリンクではありません') }));
    expect((db.prepare('select count(*) n from sessions').get() as { n: number }).n).toBe(before);
  });

  it('attach は、そのセッションを最後に動かしたアカウントを引き継ぎ、その置き場で claude attach を起こす', async () => {
    const a = accounts.add({ name: '大学' });
    const m0 = make({ accounts });
    const first = m0.start({ projectId: 'p1', account: a.id });
    await envOf(first.run.id);
    addTranscript(first.sessionId);
    m0.kill(first.run.id);
    const uuid = (db.prepare('select provider_session_id p from sessions where id = ?').get(first.sessionId) as { p: string }).p;
    const live = [{ sessionId: uuid, status: 'idle' as const, name: null, nameSource: null, cwd, pid: 777, background: { jobId: 'abcd1234' } }];
    const m = make({ accounts, live: () => live });
    const r = m.attach(first.sessionId);
    expect(r.run.kind).toBe('resume');
    expect(await envOf(r.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
    expect(params(r.run.id).account).toBe(a.id);
    expect(accountFor(accounts, first.sessionId)).toBe(a.id);
  });

  it('ターミナルから新規：いまのアカウントのリンクが壊れていれば 400 で断り、セッションの行を作らない', () => {
    const a = accounts.add({ name: '大学' });
    accounts.setCurrent(a.id);
    fs.mkdirSync(path.join(a.dir, 'projects'), { recursive: true });
    const before = (db.prepare('select count(*) n from sessions').get() as { n: number }).n;
    expect(() => make({ accounts }).startFromTerminal(fromTerminal(cwd, [], { PATH: process.env.PATH ?? '' }))).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('置き場の projects が共有のリンクではありません') }));
    expect((db.prepare('select count(*) n from sessions').get() as { n: number }).n).toBe(before);
  });

  it('ターミナルの CLAUDE_CONFIG_DIR が空文字なら、付けていないものとして、いまのアカウントの置き場で起こす', async () => {
    const a = accounts.add({ name: '大学' });
    accounts.setCurrent(a.id);
    const r = make({ accounts }).startFromTerminal(fromTerminal(cwd, [], { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: '' }));
    expect(await envOf(r.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
    expect(params(r.run.id).account).toBe(a.id);
  });

  const endedAt = (runId: string) => (db.prepare('select ended_at from runs where id = ?').get(runId) as { ended_at: number | null }).ended_at;
  const endReason = (runId: string) => (db.prepare('select end_reason from runs where id = ?').get(runId) as { end_reason: string }).end_reason;

  it('switchAccount：動いているセッションを止め、同じ会話を別のアカウントで再開する', async () => {
    const a = accounts.add({ name: '大学' });
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    // 本文の無い start は止めるときにセッションの行ごと消えるので、先に本文があることにする。
    addTranscript(first.sessionId);
    const next = await m.switchAccount(first.sessionId, a.id);
    expect(next.sessionId).toBe(first.sessionId);
    expect(next.run.id).not.toBe(first.run.id);
    expect(endReason(first.run.id)).toBe('killed');
    expect(await envOf(next.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
    expect(accountFor(accounts, first.sessionId)).toBe(a.id);
    const args = readArgs(fake.argsFile);
    expect(args[args.indexOf('-r') + 1]).toBe((db.prepare('select provider_session_id p from sessions where id = ?').get(first.sessionId) as { p: string }).p);
  });

  it('switchAccount：止まっているセッションは、そのまま別のアカウントで再開する', async () => {
    const a = accounts.add({ name: '大学' });
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    addTranscript(first.sessionId);
    m.kill(first.run.id);
    const next = await m.switchAccount(first.sessionId, a.id);
    expect(await envOf(next.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
  });

  it('switchAccount：知らないアカウントは、セッションを止める前に 400 で断る', async () => {
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    addTranscript(first.sessionId);
    await expect(m.switchAccount(first.sessionId, 'nope')).rejects.toThrow(expect.objectContaining({ status: 400, message: 'アカウントが見つかりません' }));
    expect(endedAt(first.run.id)).toBeNull();
  });

  it('switchAccount：リンクが壊れているアカウントも、止める前に断る', async () => {
    const a = accounts.add({ name: '大学' });
    fs.mkdirSync(a.dir);
    fs.writeFileSync(path.join(a.dir, 'projects'), 'x');
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    addTranscript(first.sessionId);
    await expect(m.switchAccount(first.sessionId, a.id)).rejects.toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('共有のリンクではありません') }));
    expect(endedAt(first.run.id)).toBeNull();
  });

  it('switchAccount：止めたあともレジストリに残り続けたら 409 で断る。元の run は閉じたまま', async () => {
    const a = accounts.add({ name: '大学' });
    let slept = 0;
    const m = make({ accounts, isLive: () => true, sleep: async (ms) => { slept += ms; } });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    addTranscript(first.sessionId);
    await expect(m.switchAccount(first.sessionId, a.id)).rejects.toThrow(expect.objectContaining({ status: 409, message: expect.stringContaining('前の Claude がまだ終了していません') }));
    expect(slept).toBeGreaterThanOrEqual(5000);
    expect(endReason(first.run.id)).toBe('killed');
  });

  it('switchAccount：同じアカウントへの切り替えは 409 で断り、何も止めない', async () => {
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    addTranscript(first.sessionId);
    await expect(m.switchAccount(first.sessionId, 'primary')).rejects.toThrow(expect.objectContaining({ status: 409, message: 'このセッションはもうそのアカウントで実行中です' }));
    expect(endedAt(first.run.id)).toBeNull();
  });

  it('switchAccount：本文のまだ無いセッションは、止める前に 400 で断る。run もセッションの行も残る', async () => {
    const a = accounts.add({ name: '大学' });
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    await expect(m.switchAccount(first.sessionId, a.id)).rejects.toThrow(expect.objectContaining({ status: 400, message: 'このセッションにはまだトランスクリプトがありません。そのアカウントで新しいセッションを始めてください' }));
    expect(endedAt(first.run.id)).toBeNull();
    expect(db.prepare('select 1 from sessions where id = ?').get(first.sessionId)).toBeTruthy();
  });

  it('switchAccount：作業ディレクトリが消えていれば、止める前に 400 で断る', async () => {
    const a = accounts.add({ name: '大学' });
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    addTranscript(first.sessionId);
    fs.rmSync(cwd, { recursive: true, force: true });
    await expect(m.switchAccount(first.sessionId, a.id)).rejects.toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('ディレクトリが見つかりません') }));
    expect(endedAt(first.run.id)).toBeNull();
  });

  it('switchAccount：hangar の run が無いのにレジストリに残っていれば、待たずに「hangar の外で実行中」と 409 で断る', async () => {
    const a = accounts.add({ name: '大学' });
    let slept = 0;
    const m = make({ accounts, isLive: () => true, sleep: async (ms) => { slept += ms; } });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    addTranscript(first.sessionId);
    m.kill(first.run.id);
    await expect(m.switchAccount(first.sessionId, a.id)).rejects.toThrow(expect.objectContaining({ status: 409, message: 'このセッションは hangar の外で実行中です' }));
    expect(slept).toBe(0);
  });

  it('switchAccount：バックグラウンドのサービスが持つセッションは、何も止めずに 409 で断る', async () => {
    const a = accounts.add({ name: '大学' });
    const m0 = make({ accounts });
    const first = m0.start({ projectId: 'p1' });
    await envOf(first.run.id);
    addTranscript(first.sessionId);
    const uuid = (db.prepare('select provider_session_id p from sessions where id = ?').get(first.sessionId) as { p: string }).p;
    const live = [{ sessionId: uuid, status: 'idle' as const, name: null, nameSource: null, cwd, pid: 777, background: { jobId: 'abcd1234' } }];
    const message = 'バックグラウンドセッションは、アカウントを切り替えられません。停止してから、そのアカウントで再開してください';
    // hangar の run（claude attach）が動いているとき。
    const m = make({ accounts, live: () => live });
    await expect(m.switchAccount(first.sessionId, a.id)).rejects.toThrow(expect.objectContaining({ status: 409, message }));
    expect(endedAt(first.run.id)).toBeNull();
    // hangar の run が無いとき（サービスだけが動いている）も、同じ文言で断る。
    m.kill(first.run.id);
    const killedAt = endedAt(first.run.id);
    await expect(m.switchAccount(first.sessionId, a.id)).rejects.toThrow(expect.objectContaining({ status: 409, message }));
    expect(endedAt(first.run.id)).toBe(killedAt);
  });

  it('accounts を渡さない RunManager は今までどおり動く', async () => {
    const r = make().start({ projectId: 'p1' });
    expect(await envOf(r.run.id)).toBe('CLAUDE_CONFIG_DIR=\n');
    expect(params(r.run.id).account).toBeUndefined();
  });
});
