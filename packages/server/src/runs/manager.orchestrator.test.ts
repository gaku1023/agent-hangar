import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orchestratorOf, type OrchestratorSetting } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { agentsOf } from '../agent/agents.ts';
import { claudeDriverFor } from '../boot/agents.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { realProcOps, type ProcOps } from '../provider/claude-code/process/procs.ts';
import { readArgs, writeFakeClaude } from '../../test/fake-claude.ts';
import { TMUX, removeDirsWhenIdle, removeTestSocket, testSocketPath, waitFor } from '../../test/tmux.ts';
import { tmuxPaneOps } from '../tmux/pane.ts';
import { Tmux } from '../tmux/tmux.ts';
import { liveSourceOf } from '../../test/fake-live.ts';
import { RunManager } from './manager.ts';

let db: Db;
let home: string;
let cwd: string;
let claudeDir: string;
let fake: { bin: string; argsFile: string; envFile: string };
let tmux: Tmux | null;
let setting: OrchestratorSetting;
const socketPath = testSocketPath();
const noJobs: ProcOps = { ...realProcOps, listJobs: () => [] };

beforeEach(() => {
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-orch-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-orch-cwd-'));
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-orch-claude-'));
  fs.mkdirSync(path.join(claudeDir, 'projects'));
  fake = writeFakeClaude(home);
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'pr1', project_id: 'p1', device_id: 'd', path: cwd, resolved: 1 }, 'd');
  tmux = TMUX ? new Tmux({ tmuxPath: TMUX, socketPath }) : null;
  setting = orchestratorOf({ enabled: true });
});
afterAll(() => removeTestSocket(socketPath));
afterEach(async () => {
  tmux?.killServer();
  await removeDirsWhenIdle([home, cwd, claudeDir]);
});

function make(o: { orchestrator?: boolean } = {}): RunManager {
  const claude = claudeDriverFor({ home, token: 'tok', language: () => 'ja', claudeBin: () => fake.bin, live: liveSourceOf(), transcript: claudeTranscriptSource({ claudeDir: home }), procs: () => noJobs });
  return new RunManager({
    db, deviceId: 'd', home, panes: tmux ? tmuxPaneOps(tmux) : null, claudeBin: fake.bin, claudeDir, port: 4177, token: 'tok', shell: 'sh', procs: noJobs, language: () => 'ja',
    agents: agentsOf([claude]), claude,
    ...(o.orchestrator === false ? {} : { orchestrator: () => setting }),
  });
}

const launchedArgs = async (runId: string) => {
  await waitFor(() => fs.existsSync(fake.argsFile) && readArgs(fake.argsFile).at(-1) === runId);
  return readArgs(fake.argsFile);
};
const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1]!;
const settingsOf = (argv: string[]) => JSON.parse(fs.readFileSync(valueOf(argv, '--settings'), 'utf8')) as { hooks: unknown; permissions?: { allow: string[]; deny: string[] } };

describe.skipIf(!TMUX)('RunManager.startOrchestrator', () => {
  it('専用の cwd、設定のモデルと effort、役の文で起こす。プロジェクトには属さない', async () => {
    setting = orchestratorOf({ enabled: true, model: 'opus', effort: 'low' });
    const r = make().startOrchestrator();
    const args = await launchedArgs(r.run.id);
    const dir = path.join(home, 'orchestrator');
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(db.prepare('select cwd, project_id from sessions where id = ?').get(r.sessionId)).toEqual({ cwd: dir, project_id: null });
    expect(valueOf(args, '--model')).toBe('opus');
    expect(valueOf(args, '--effort')).toBe('low');
    expect(valueOf(args, '--permission-mode')).toBe('default');
    const sys = valueOf(args, '--append-system-prompt');
    expect(sys).toContain('[hangar]');
    expect(sys).toContain('[voice]');
    // プロジェクトの段（TODO や場所）は渡さない。
    expect(sys).not.toContain('プロジェクト：');
  });

  it('run の settings に、hook に加えて permissions を書く。deny は手を動かす道具、allow は hangar の道具', async () => {
    const r = make().startOrchestrator();
    const s = settingsOf(await launchedArgs(r.run.id));
    expect(s.hooks).toBeDefined();
    expect(s.permissions?.deny).toEqual(['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch']);
    expect(s.permissions?.allow).toEqual(['mcp__hangar']);
  });

  it('設定が既定（Sonnet と medium）なら、それを渡す', async () => {
    setting = orchestratorOf({ enabled: true });
    const args = await launchedArgs(make().startOrchestrator().run.id);
    expect(valueOf(args, '--model')).toBe('sonnet');
    expect(valueOf(args, '--effort')).toBe('medium');
  });

  it('再開でも同じ指定（cwd、モデル、permissions）を渡す', async () => {
    const rm = make();
    const first = rm.startOrchestrator();
    await launchedArgs(first.run.id);
    setting = { ...setting, sessionId: first.sessionId };
    db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?)').run('/x/o.jsonl', first.sessionId, null, 10, 1, 10, 1);
    rm.kill(first.run.id);
    const again = rm.resume(first.sessionId);
    const args = await launchedArgs(again.run.id);
    expect(valueOf(args, '-r')).toBeTruthy();
    expect(valueOf(args, '--model')).toBe('sonnet');
    expect(valueOf(args, '--effort')).toBe('medium');
    expect(settingsOf(args).permissions?.deny).toContain('Bash');
  });

  it('統括でない会話の settings は permissions を持たず、モデルや役の文も足さない', async () => {
    setting = { ...setting, sessionId: 'someone-else' };
    const r = await make().start({ projectId: 'p1', name: 'plain' });
    const args = await launchedArgs(r.run.id);
    expect(settingsOf(args)).not.toHaveProperty('permissions');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--permission-mode');
    expect(valueOf(args, '--append-system-prompt')).not.toContain('[voice]');
  });

  it('orchestrator の口を渡さない RunManager は、統括を起こさない', () => {
    expect(() => make({ orchestrator: false }).startOrchestrator()).toThrow();
  });
});
