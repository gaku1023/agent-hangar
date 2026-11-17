import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import { orchestratorOf, type OrchestratorSetting } from '@agent-hangar/shared';
import { agentsOf } from '../agent/agents.ts';
import { claudeDriverFor } from '../boot/agents.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { AGENT_RUN_DROPPED_ENV } from '../launch/env.ts';
import { createOpencodeDriver } from '../provider/opencode/driver.ts';
import { ORCHESTRATOR_OPENCODE_RULES } from '../provider/opencode/permissionPreset.ts';
import { ServeManager } from '../provider/opencode/serve/manager.ts';
import { ServeRegistry } from '../provider/opencode/serve/registry.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { realProcOps } from '../provider/claude-code/process/procs.ts';
import type { PaneOps } from '../tmux/pane.ts';
import { readFakeOpencodeLog, writeFakeOpencode, type FakeOpencodeEvent } from '../../test/fake-opencode.ts';
import { until } from '../../test/fake-opencode-events.ts';
import { writeFakeClaude } from '../../test/fake-claude.ts';
import { liveSourceOf } from '../../test/fake-live.ts';
import { posixDescribe, posixIt } from '../../test/platform.ts';
import { RunManager } from './manager.ts';

const ev = <K extends FakeOpencodeEvent['ev']>(log: FakeOpencodeEvent[], k: K) => log.filter((e): e is Extract<FakeOpencodeEvent, { ev: K }> => e.ev === k);
type Row = { id: string; provider: string; provider_session_id: string; cwd: string; project_id: string | null };

// 統括を opencode で起こす（docs/design.md「統括」）。偽の opencode の serve を本当に起こし、画面は開いた中身を記録するだけにする。
posixDescribe('RunManager.startOrchestrator（opencode）', () => {
  let db: Db;
  let home: string;
  let serves: ServeManager[];
  let setting: OrchestratorSetting;
  beforeEach(() => {
    db = openDb(':memory:');
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-orch-oc-home-'));
    serves = [];
    setting = orchestratorOf({ enabled: true, agent: 'opencode', model: 'lmstudio/qwen3.5-9b', effort: '' });
  });
  afterEach(async () => {
    for (const s of serves) await s.stopAll();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const sessions = (): Row[] => db.prepare('select id, provider, provider_session_id, cwd, project_id from sessions where deleted_at is null').all() as Row[];

  const make = (o: { enabled?: boolean } = {}) => {
    const { bin, logFile } = writeFakeOpencode(path.join(home, 'oc'), {});
    const enabled = () => o.enabled !== false;
    const manager = new ServeManager({ enabled, bin: () => bin, version: async () => '2.2.0', registry: new ServeRegistry(path.join(home, 'serves.json')), killGraceMs: 300, watchMs: 50 });
    serves.push(manager);
    const configs: string[] = [];
    const watched = {
      ensure: (id: string, x?: { configContent?: string }) => { configs.push(x?.configContent ?? ''); return manager.ensure(id, x); },
      get: (id: string) => manager.get(id),
      stop: (id: string) => manager.stop(id),
    };
    // 許可のひな形は入り（統括の規則がそれに代わることを見る）。
    const opencode = createOpencodeDriver({ serves: () => watched, droppedEnv: AGENT_RUN_DROPPED_ENV, mcpPollMs: 10, mcpWaitMs: 2000, report: () => {}, permissions: () => [{ action: 'shell', resource: '*', effect: 'ask' }] });
    const fakeClaude = writeFakeClaude(home);
    const claude = claudeDriverFor({ home, token: 'tok', language: () => 'ja', claudeBin: () => fakeClaude.bin, live: liveSourceOf(), transcript: claudeTranscriptSource({ claudeDir: home }), procs: () => realProcOps });
    const opened: { name: string; cwd: string; command: string[] }[] = [];
    const panes: PaneOps = { open: (p) => { opened.push(p); }, close: () => {}, list: () => [], capture: () => '', sendText: () => {}, sendKey: () => {}, prepareForOutsideTerminals: () => {} };
    const rm = new RunManager({
      db, deviceId: 'd', home, panes, claudeBin: fakeClaude.bin, claudeDir: home, port: 4177, token: 'tok', shell: 'sh', language: () => 'ja',
      procs: { ...realProcOps, listJobs: () => [] },
      agents: agentsOf([claude, opencode]), claude,
      agentEnabled: (k) => k === 'claude-code' || (k === 'opencode' && enabled()),
      agentBin: (k) => (k === 'opencode' ? bin : null),
      injection: () => ({ askStatusAtEnd: true, liveHints: true, opencode: 'minimal' }),
      orchestrator: () => setting,
    });
    return { rm, opened, configs, manager, log: () => readFakeOpencodeLog(logFile) };
  };

  posixIt('専用の cwd、統括の規則（serve の設定と会話の permissions）、役の文、設定のモデルで起こす。プロジェクトには属さない', async () => {
    const { rm, opened, configs, log } = make();
    const r = await rm.startOrchestrator({ agent: 'opencode' });
    const dir = path.join(home, 'orchestrator');
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(sessions()).toEqual([expect.objectContaining({ id: r.sessionId, provider: 'opencode', cwd: dir, project_id: null })]);
    expect(JSON.parse(configs[0]!).permissions).toEqual(ORCHESTRATOR_OPENCODE_RULES);
    const create = ev(log(), 'create')[0]!;
    expect(create.body).toMatchObject({ title: 'Orchestrator', model: { providerID: 'lmstudio', id: 'qwen3.5-9b' }, permissions: ORCHESTRATOR_OPENCODE_RULES });
    expect(create.body).not.toHaveProperty('agent');
    const inst = String(ev(log(), 'instructions')[0]!.body.value);
    expect(inst).toContain('[hangar]');
    expect(inst).not.toContain('プロジェクト：');
    // 統括は自動承認を付けない。
    expect(opened[0]!.command).not.toContain('--auto');
    expect(JSON.parse((db.prepare('select launch_params from runs where id = ?').get(r.run.id) as { launch_params: string }).launch_params)).toMatchObject({ agent: 'opencode', name: 'Orchestrator' });
  });

  posixIt('アカウントを渡されても opencode には無いので捨てて起こす', async () => {
    const { rm } = make();
    const r = await rm.startOrchestrator({ agent: 'opencode', account: 'acc-1' });
    expect(sessions()).toEqual([expect.objectContaining({ id: r.sessionId, provider: 'opencode' })]);
  });

  posixIt('設定で opencode が切なら、行も serve も残さずに断る', async () => {
    const { rm, log } = make({ enabled: false });
    await expect(rm.startOrchestrator({ agent: 'opencode' })).rejects.toMatchObject({ status: 400 });
    expect(sessions()).toEqual([]);
    expect(ev(log(), 'start')).toEqual([]);
  });

  posixIt('再開でも統括の規則で serve を起こし、会話の permissions を当て直す', async () => {
    const { rm, manager, configs, log } = make();
    const r = await rm.startOrchestrator({ agent: 'opencode' });
    setting = { ...setting, sessionId: r.sessionId };
    rm.tick(); rm.tick();
    await until(() => manager.get(r.sessionId) === null);
    const again = await rm.resumeWith(r.sessionId, {});
    expect(again.run.kind).toBe('resume');
    expect(JSON.parse(configs.at(-1)!).permissions).toEqual(ORCHESTRATOR_OPENCODE_RULES);
    const id = ev(log(), 'create')[0]!.id;
    expect(ev(log(), 'patch')).toEqual([expect.objectContaining({ id, body: { permissions: ORCHESTRATOR_OPENCODE_RULES } })]);
  });
});
