import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LaunchParams } from '@agent-hangar/shared';
import { agentsOf } from '../agent/agents.ts';
import { claudeDriverFor } from '../boot/agents.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { AGENT_RUN_DROPPED_ENV } from '../launch/env.ts';
import { SECRET_ENV_DIR, secretEnvPath } from '../launch/secretEnv.ts';
import { ensureSession } from '../indexer/write.ts';
import { createCodexDriver, type CodexDriver } from '../provider/codex/driver.ts';
import { TUI_TOKEN_ENV } from '../provider/codex/appServer.ts';
import { LaunchQueue } from '../provider/opencode/serve/queue.ts';
import { isProcessAlive } from '../provider/opencode/serve/spawn.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { realProcOps } from '../provider/claude-code/process/procs.ts';
import type { PaneOps } from '../tmux/pane.ts';
import { writeFakeClaude } from '../../test/fake-claude.ts';
import { writeFakeCodex, type FakeCodexOptions } from '../../test/fake-codex.ts';
import { liveSourceOf } from '../../test/fake-live.ts';
import { posixDescribe } from '../../test/platform.ts';
import { RunManager } from './manager.ts';

type Row = { id: string; provider: string; provider_session_id: string; deleted_at: number | null };
const until = async (f: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// 偽の codex の app-server を本当に起こす。画面（tmux）は開いた中身を記録するだけの口にする。
posixDescribe('RunManager.start で Codex を起こす（materialize）', () => {
  let db: Db;
  let home: string;
  let cwd: string;
  let drivers: CodexDriver[];
  beforeEach(() => {
    db = openDb(':memory:');
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-cx-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-cx-cwd-'));
    drivers = [];
    upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'pr1', project_id: 'p1', device_id: 'd', path: cwd, resolved: 1 }, 'd');
  });
  afterEach(async () => {
    for (const s of sessions()) await drivers[0]?.launch.release({ sessionId: s.id, providerSessionId: s.provider_session_id, cwd }, 'killed');
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const sessions = (): Row[] => db.prepare('select id, provider, provider_session_id, deleted_at from sessions where deleted_at is null').all() as Row[];

  const make = (o: { enabled?: boolean; bin?: string | null; fake?: FakeCodexOptions; injection?: 'minimal' | 'claude' | 'none' } = {}) => {
    const logFile = path.join(home, 'boot.jsonl');
    const rpcLog = path.join(home, 'rpc.jsonl');
    const bin = writeFakeCodex(path.join(home, 'cx'), { logFile, rpcLogFile: rpcLog, ...(o.fake ?? {}) });
    const codex = createCodexDriver({ bin: () => (o.bin === undefined ? bin : o.bin), home, droppedEnv: AGENT_RUN_DROPPED_ENV, graceMs: 500, mcpPollMs: 10, mcpWaitMs: 1000, queue: new LaunchQueue(), report: () => {} });
    drivers.push(codex);
    const fakeClaude = writeFakeClaude(home);
    const claude = claudeDriverFor({ home, token: 'tok', language: () => 'ja', claudeBin: () => fakeClaude.bin, live: liveSourceOf(), transcript: claudeTranscriptSource({ claudeDir: home }), procs: () => realProcOps });
    const opened: { name: string; cwd: string; command: string[]; env: Record<string, string> }[] = [];
    const closed: string[] = [];
    const panes: PaneOps = {
      open: (p) => { opened.push({ ...p, env: p.env ?? {} }); },
      close: (name) => { closed.push(name); },
      list: () => [],
      capture: () => '',
      sendText: () => {},
      sendKey: () => {},
      prepareForOutsideTerminals: () => {},
    };
    const enabled = o.enabled !== false;
    const rm = new RunManager({
      db, deviceId: 'd', home, panes, claudeBin: fakeClaude.bin, claudeDir: home, port: 4177, token: 'tok', shell: 'sh', language: () => 'ja',
      procs: { ...realProcOps, listJobs: () => [] },
      agents: agentsOf([claude, codex]), claude,
      agentEnabled: (k) => k === 'claude-code' || (k === 'codex' && enabled),
      agentBin: (k) => (k === 'codex' ? (o.bin === undefined ? bin : o.bin) : null),
      injection: () => ({ askStatusAtEnd: true, liveHints: true, codex: o.injection ?? 'minimal' }),
    });
    const rpcs = (): { ev: string; method?: string; params?: Record<string, unknown> }[] => (fs.existsSync(rpcLog) ? fs.readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { ev: string; method?: string; params?: Record<string, unknown> }) : []);
    return { rm, codex, bin, opened, closed, rpcs, booted: () => fs.existsSync(logFile) };
  };

  const params = (over: Partial<LaunchParams> = {}): LaunchParams => ({ agent: 'codex', projectId: 'p1', ...over });

  it('設定で有効にしていなければ、行も app-server も作らずに断る', async () => {
    const { rm, booted } = make({ enabled: false });
    const err = (await rm.start(params()).then(() => null, (e: unknown) => e)) as Error & { status: number };
    expect(err).toMatchObject({ status: 400 });
    expect(err.message).toBe('Codex は有効になっていません。設定の「Codex を有効にする」をオンにしてください');
    expect(sessions()).toEqual([]);
    expect(booted()).toBe(false);
  });

  it('codex が見つからなければ断る', async () => {
    const { rm, booted } = make({ bin: null });
    await expect(rm.start(params())).rejects.toMatchObject({ status: 400, message: 'codex が見つかりません（PATH を確認してください）' });
    expect(sessions()).toEqual([]);
    expect(booted()).toBe(false);
  });

  it('Codex が受けない指定（アカウント、追加ディレクトリ、worktree）は、行を作らずに断る。effort と permissionMode は受ける', async () => {
    const { rm, booted } = make();
    await expect(rm.start(params({ account: 'primary' }))).rejects.toMatchObject({ status: 400, message: 'account は Codex のセッションでは指定できません' });
    await expect(rm.start(params({ addDirs: ['/a'] }))).rejects.toMatchObject({ status: 400, message: 'addDirs は Codex のセッションでは指定できません' });
    await expect(rm.start(params({ worktree: 'w' }))).rejects.toMatchObject({ status: 400, message: 'worktree は Codex のセッションでは指定できません' });
    expect(sessions()).toEqual([]);
    expect(booted()).toBe(false);
    await expect(rm.start(params({ effort: 'low', permissionMode: 'read-only', prompt: 'x' }))).resolves.toBeTruthy();
  });

  it('権限や推論が Codex に通らない値なら、Codex を起動できなかったと断り、行を消す', async () => {
    const { rm, booted } = make();
    await expect(rm.start(params({ permissionMode: 'plan' }))).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Codex を起動できませんでした') });
    expect(sessions()).toEqual([]);
    expect(booted()).toBe(false);
  });

  it('初期プロンプトあり：仮の行 → app-server → thread/start と turn/start → ID の記録 → resume でつなぐ TUI、の順で起こす', async () => {
    const { rm, opened, rpcs } = make({ fake: { mcpPendingPolls: 1 } });
    const r = await rm.start(params({ name: 'しごと', prompt: '直して', permissionMode: 'full-access', effort: 'high', model: 'gpt-x' }));
    const start = rpcs().find((x) => x.method === 'thread/start')!;
    expect(start.params).toMatchObject({ cwd, model: 'gpt-x', approvalPolicy: 'never', sandbox: 'danger-full-access' });
    expect(String(start.params!.developerInstructions)).toContain('agent-hangar');
    const id = (rpcs().find((x) => x.method === 'turn/start')!.params as { threadId: string }).threadId;

    expect(sessions()).toEqual([expect.objectContaining({ id: r.sessionId, provider: 'codex', provider_session_id: id })]);
    expect(opened).toHaveLength(1);
    const cmd = opened[0]!.command;
    expect(cmd.slice(cmd.indexOf(path.join(home, 'cx', 'codex')))).toEqual(expect.arrayContaining(['--remote', '-m', 'gpt-x', '-s', 'danger-full-access', '-a', 'never', 'resume', id]));
    // token は argv にも tmux の環境にも載せず、0600 のファイルに置く。
    const secret = secretEnvPath(home, r.run.id);
    expect(fs.readFileSync(secret, 'utf8')).toMatch(new RegExp(`^${TUI_TOKEN_ENV}=.+\n$`));
    const token = fs.readFileSync(secret, 'utf8').trim().split('=')[1]!;
    expect(cmd.join('\n')).not.toContain(token);
    expect(JSON.stringify(opened[0]!.env)).not.toContain(token);
    // CLAUDE 系、HANGAR_*、CODEX_HOME を外す。
    const unset = cmd.slice(cmd.indexOf('-u'), cmd.indexOf('bash'));
    for (const n of ['CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'HANGAR_HOME', 'CODEX_HOME']) expect(unset).toContain(n);
    expect(JSON.parse((db.prepare('select launch_params from runs where id = ?').get(r.run.id) as { launch_params: string }).launch_params)).toMatchObject({ agent: 'codex', permissionMode: 'full-access' });
  });

  it('新しいセッションのダイアログの既定の送り（agent・model・effort=medium・permissionMode=auto）が、driver と入口をそのまま通る', async () => {
    const { rm, opened, rpcs } = make();
    const dialog: LaunchParams = { agent: 'codex', projectId: 'p1', prompt: 'やって', model: 'gpt-x', effort: 'medium', permissionMode: 'auto' };
    const r = await rm.start(dialog);
    const start = rpcs().find((x) => x.method === 'thread/start')!;
    expect(start.params).toMatchObject({ cwd, model: 'gpt-x', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    const cmd = opened[0]!.command;
    expect(cmd.slice(cmd.indexOf(path.join(home, 'cx', 'codex')))).toEqual(expect.arrayContaining(['-m', 'gpt-x', '-c', 'model_reasoning_effort="medium"']));
    expect(JSON.parse((db.prepare('select launch_params from runs where id = ?').get(r.run.id) as { launch_params: string }).launch_params)).toMatchObject({ agent: 'codex', model: 'gpt-x', effort: 'medium', permissionMode: 'auto' });
  });

  it('初期プロンプトなし：仮の ID のまま TUI を resume なしで開き、TUI がつないで thread/started が届いたら ID を記録する', async () => {
    const { rm, codex, opened, rpcs } = make();
    const r = await rm.start(params());
    expect(rpcs().map((x) => x.method)).not.toContain('thread/start');
    expect(opened[0]!.command).not.toContain('resume');
    expect(sessions()[0]!.provider_session_id).toMatch(/^pending:/);
    const s = codex.served(r.sessionId)!;
    const ws = new WebSocket(`${s.url}/?tui=1&cwd=${encodeURIComponent(cwd)}`, { headers: { authorization: `Bearer ${s.token}` } });
    await new Promise((res) => ws.once('open', res));
    await until(() => !sessions()[0]!.provider_session_id.startsWith('pending:'));
    expect(sessions()[0]!.provider_session_id).toBe(codex.served(r.sessionId)!.threadId);
    ws.close();
  });

  it('run を止めると、画面を閉じ、app-server も止める', async () => {
    const { rm, codex, closed } = make({ fake: { turnMs: 30_000 } });
    const r = await rm.start(params({ prompt: '長い' }));
    const pid = codex.served(r.sessionId)!.pid;
    rm.kill(r.run.id);
    expect(closed).toContain(r.run.tmuxName);
    await until(() => !isProcessAlive(pid));
    expect(codex.served(r.sessionId)).toBeNull();
    expect(fs.existsSync(secretEnvPath(home, r.run.id))).toBe(false);
  });

  it('終わった画面の「再開」：hangar の外で作られた会話（索引の provider=codex の行）も、thread/resume で開いて resume <ID> の TUI につなぐ', async () => {
    const EXT = '01bffff0-0000-7000-8000-00000000e001';
    const { rm, codex, opened, rpcs } = make({ fake: { knownThreads: [{ id: EXT, cwd: '/somewhere/else' }] } });
    const sid = ensureSession(db, EXT, cwd, 'd', 'codex');
    const r = await rm.resumeWith(sid, {});
    expect(rpcs().find((x) => x.method === 'thread/resume')!.params).toMatchObject({ threadId: EXT, cwd });
    expect(rpcs().map((x) => x.method)).not.toContain('turn/start');
    const cmd = opened[0]!.command;
    expect(cmd.slice(cmd.indexOf(path.join(home, 'cx', 'codex')))).toEqual(expect.arrayContaining(['--remote', 'resume', EXT]));
    expect(r.sessionId).toBe(sid);
    expect(codex.served(sid)?.threadId).toBe(EXT);
    expect(JSON.parse((db.prepare('select launch_params from runs where id = ?').get(r.run.id) as { launch_params: string }).launch_params)).toMatchObject({ agent: 'codex' });
  });

  it('最初の入力の前の会話は再開できない。Codex を起動できなかったと、理由つきで断り、app-server を残さない', async () => {
    const { rm, codex } = make();
    const sid = ensureSession(db, '01bffff0-0000-7000-8000-00000000dead', cwd, 'd', 'codex');
    await expect(rm.resumeWith(sid, {})).rejects.toMatchObject({ status: 400, message: 'Codex を起動できませんでした: この会話は、まだ最初の入力が送られていないため、再開できません。新しく始めてください' });
    expect(codex.served(sid)).toBeNull();
  });

  it('画面を開けなかったら、app-server を止め、仮の行と秘密の環境のファイルを残さない', async () => {
    const { rm, rpcs } = make();
    // 画面の口を壊す：tmux の確かめを通ったあと open が投げる。
    (rm as unknown as { deps: { panes: PaneOps } }).deps.panes.open = () => { throw new Error('no room'); };
    await expect(rm.start(params({ prompt: 'x' }))).rejects.toMatchObject({ status: 400 });
    expect(sessions()).toEqual([]);
    // 起こした app-server に SIGTERM が届いている（偽の codex が記録する）。
    await until(() => rpcs().some((x) => x.ev === 'sigterm'));
    const dir = path.join(home, SECRET_ENV_DIR);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });
});
