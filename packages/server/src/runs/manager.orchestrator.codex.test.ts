import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { orchestratorOf, type OrchestratorSetting } from '@agent-hangar/shared';
import { agentsOf } from '../agent/agents.ts';
import { claudeDriverFor } from '../boot/agents.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { AGENT_RUN_DROPPED_ENV } from '../launch/env.ts';
import { ensureSession } from '../indexer/write.ts';
import { createCodexDriver, type CodexDriver } from '../provider/codex/driver.ts';
import { LaunchQueue } from '../provider/opencode/serve/queue.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { realProcOps } from '../provider/claude-code/process/procs.ts';
import type { PaneOps } from '../tmux/pane.ts';
import { writeFakeClaude } from '../../test/fake-claude.ts';
import { writeFakeCodex, type FakeCodexOptions } from '../../test/fake-codex.ts';
import { liveSourceOf } from '../../test/fake-live.ts';
import { posixDescribe } from '../../test/platform.ts';
import { RunManager } from './manager.ts';

type Row = { id: string; provider: string; provider_session_id: string; cwd: string; project_id: string | null };

// 統括を Codex で起こす（docs/design.md「統括」）。偽の codex の app-server を本当に起こし、画面は開いた中身を記録するだけにする。
posixDescribe('RunManager.startOrchestrator（Codex）', () => {
  let db: Db;
  let home: string;
  let cwd: string;
  let drivers: CodexDriver[];
  let setting: OrchestratorSetting;
  beforeEach(() => {
    db = openDb(':memory:');
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-orch-cx-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-orch-cx-cwd-'));
    drivers = [];
    setting = orchestratorOf({ enabled: true, model: 'gpt-x', effort: 'low' });
    upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'pr1', project_id: 'p1', device_id: 'd', path: cwd, resolved: 1 }, 'd');
  });
  afterEach(async () => {
    for (const s of sessions()) await drivers[0]?.launch.release({ sessionId: s.id, providerSessionId: s.provider_session_id, cwd: s.cwd }, 'killed');
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const sessions = (): Row[] => db.prepare('select id, provider, provider_session_id, cwd, project_id from sessions where deleted_at is null').all() as Row[];

  const make = (o: { enabled?: boolean; fake?: FakeCodexOptions } = {}) => {
    const logFile = path.join(home, 'boot.jsonl');
    const rpcLog = path.join(home, 'rpc.jsonl');
    const bin = writeFakeCodex(path.join(home, 'cx'), { logFile, rpcLogFile: rpcLog, ...(o.fake ?? {}) });
    const codex = createCodexDriver({ bin: () => bin, home, droppedEnv: AGENT_RUN_DROPPED_ENV, graceMs: 500, mcpPollMs: 10, mcpWaitMs: 1000, queue: new LaunchQueue(), report: () => {} });
    drivers.push(codex);
    const fakeClaude = writeFakeClaude(home);
    const claude = claudeDriverFor({ home, token: 'tok', language: () => 'ja', claudeBin: () => fakeClaude.bin, live: liveSourceOf(), transcript: claudeTranscriptSource({ claudeDir: home }), procs: () => realProcOps });
    const opened: { name: string; cwd: string; command: string[] }[] = [];
    const panes: PaneOps = {
      open: (p) => { opened.push(p); },
      close: () => {},
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
      agentBin: (k) => (k === 'codex' ? bin : null),
      injection: () => ({ askStatusAtEnd: true, liveHints: true, codex: 'minimal' }),
      orchestrator: () => setting,
    });
    const boots = (): { argv: string[] }[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] }) : []);
    const rpcs = (): { method?: string; params?: Record<string, unknown> }[] => (fs.existsSync(rpcLog) ? fs.readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> }) : []);
    return { rm, opened, boots, rpcs };
  };

  /** app-server の -c の値（key=value の value）。 */
  const configOf = (argv: string[], key: string): string | undefined => argv.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);

  it('専用の cwd、read-only の sandbox、承認 never（昇格を求められない）、役の文、設定のモデルと effort で起こす。プロジェクトの段は足さず、プロジェクトにも属さない', async () => {
    const { rm, opened, boots } = make();
    const r = await rm.startOrchestrator({ agent: 'codex' });
    const dir = path.join(home, 'orchestrator');
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(sessions()).toEqual([expect.objectContaining({ id: r.sessionId, provider: 'codex', cwd: dir, project_id: null })]);
    const argv = boots()[0]!.argv;
    expect(configOf(argv, 'sandbox_mode')).toBe('"read-only"');
    expect(configOf(argv, 'approval_policy')).toBe('"never"');
    expect(configOf(argv, 'mcp_servers.hangar.default_tools_approval_mode')).toBe('"approve"');
    expect(configOf(argv, 'model')).toBe('"gpt-x"');
    expect(configOf(argv, 'model_reasoning_effort')).toBe('"low"');
    const inst = JSON.parse(configOf(argv, 'developer_instructions')!) as string;
    expect(inst).toContain('[hangar]');
    expect(inst).toContain('[voice]');
    expect(inst).not.toContain('プロジェクト：');
    const cmd = opened[0]!.command;
    expect(cmd.slice(cmd.indexOf(path.join(home, 'cx', 'codex')))).toEqual(expect.arrayContaining(['-m', 'gpt-x', '-s', 'read-only', '-a', 'never']));
    expect(cmd).not.toContain('--remote-control');
    expect(JSON.parse((db.prepare('select launch_params from runs where id = ?').get(r.run.id) as { launch_params: string }).launch_params)).toMatchObject({ agent: 'codex', name: 'Orchestrator' });
  });

  it('統括でない read-only の Codex の会話は、承認 on-request のまま', async () => {
    const { rm, opened, boots } = make();
    await rm.start({ agent: 'codex', projectId: 'p1', permissionMode: 'read-only' });
    expect(configOf(boots()[0]!.argv, 'approval_policy')).toBe('"on-request"');
    const cmd = opened[0]!.command;
    expect(cmd.slice(cmd.indexOf(path.join(home, 'cx', 'codex')))).toEqual(expect.arrayContaining(['-s', 'read-only', '-a', 'on-request']));
  });

  it('Claude Code を渡す（または省く）と、今までどおり同期で起こす', () => {
    const { rm } = make();
    const r = rm.startOrchestrator({ agent: 'claude-code' });
    expect(r).not.toBeInstanceOf(Promise);
    expect(sessions()).toEqual([expect.objectContaining({ id: r.sessionId, provider: 'claude-code' })]);
  });

  it('設定で Codex が切なら、行も app-server も残さずに断る', async () => {
    const { rm, boots } = make({ enabled: false });
    await expect(rm.startOrchestrator({ agent: 'codex' })).rejects.toMatchObject({ status: 400 });
    expect(sessions()).toEqual([]);
    expect(boots()).toEqual([]);
  });

  it('再開でも read-only と役の文で起こす', async () => {
    const EXT = '01bffff0-0000-7000-8000-00000000e0a1';
    const dir = path.join(home, 'orchestrator');
    fs.mkdirSync(dir, { recursive: true });
    const { rm, boots, rpcs } = make({ fake: { knownThreads: [{ id: EXT, cwd: dir }] } });
    const sid = ensureSession(db, EXT, dir, 'd', 'codex');
    setting = { ...setting, sessionId: sid };
    await rm.resumeWith(sid, {});
    expect(rpcs().find((x) => x.method === 'thread/resume')!.params).toMatchObject({ threadId: EXT, sandbox: 'read-only', approvalPolicy: 'never' });
    const argv = boots()[0]!.argv;
    expect(configOf(argv, 'sandbox_mode')).toBe('"read-only"');
    expect(configOf(argv, 'approval_policy')).toBe('"never"');
    expect(JSON.parse(configOf(argv, 'developer_instructions')!)).toContain('[hangar]');
  });
});
