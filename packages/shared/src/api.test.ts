import { describe, expect, it } from 'vitest';
import type { ArtifactDto, BootstrapDto, ConfigPreviewDto, DeviceDto, Intent, LaunchResultDto, MemoDto, PromoteResultDto, RunDto, ServerEvent, SessionDto, SessionLockDto, SettingsDto, SummarizerTestDto, SyncStatusDto, TabDto, TodoDto, UsageDto } from './index.ts';

describe('フェーズ 2 の DTO', () => {
  it('RunDto と TabDto と LaunchResultDto が組み立てられる', () => {
    const run: RunDto = { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 };
    const tab: TabDto = { id: 'r1', runId: 'r1', sessionId: 's1', kind: 'agent', title: 'Claude', tmuxName: 'hangar-r1', createdAt: 1, closedAt: null };
    const r: LaunchResultDto = { run, sessionId: 's1', tabs: [tab] };
    expect(r.tabs[0]!.kind).toBe('agent');
    const ev: ServerEvent = { type: 'run.started', run, tabs: [tab] };
    expect(ev.type).toBe('run.started');
    const ended: ServerEvent = { type: 'run.ended', run: { ...run, endedAt: 2, endReason: 'exited' } };
    expect(ended.type).toBe('run.ended');
  });
  it('SettingsDto と BootstrapDto に新しい項目がある', () => {
    const s: SettingsDto = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false };
    const b: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: s, projects: [], sessions: [], live: [], runs: [], tabs: [], usage: { fiveHour: null, sevenDay: null, updatedAt: null }, todos: [], artifacts: [], summaryPending: [], index: { phase: 'idle', done: 0, total: 0 }, version: '0', sync: { state: 'off', url: null, lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 0, claudeConfig: { enabled: false, confirmed: false } }, devices: [] };
    expect(b.runs).toEqual([]);
    expect(b.settings.terminalApp).toBe('terminal');
  });
});

describe('フェーズ 3 の DTO', () => {
  it('UsageDto、TodoDto、MemoDto、ArtifactDto が組み立てられる', () => {
    const usage: UsageDto = { fiveHour: { usedPercent: 47, resetsAt: 1_700_000_000_000 }, sevenDay: null, updatedAt: 1 };
    const todo: TodoDto = { id: 't1', projectId: 'p1', text: 'x', done: false, position: 1, sessionId: null, updatedAt: 1 };
    const memo: MemoDto = { projectId: 'p1', markdown: '# m', updatedAt: 1 };
    const art: ArtifactDto = { id: 'a1', projectId: 'p1', url: 'https://claude.ai/code/artifact/x', title: 't', description: null, favicon: '📊', filePath: null, fileExists: false, firstPublishedAt: 1, lastPublishedAt: 2, versionCount: 2, sessionIds: ['s1'] };
    const evs: ServerEvent[] = [{ type: 'usage.update', usage }, { type: 'todos.update', projectId: 'p1', todos: [todo] }, { type: 'memo.update', memo }, { type: 'artifact.upsert', artifact: art }, { type: 'summary.pending', sessionId: 's1' }, { type: 'summary.updated', sessionId: 's1' }, { type: 'summary.failed', sessionId: 's1', message: 'x' }];
    expect(evs.map((e) => e.type)).toHaveLength(7);
  });
  it('SettingsDto、SessionDto、BootstrapDto に新しい項目がある', () => {
    const s: SettingsDto = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false };
    const ses: SessionDto = { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: null, cwd: '/x', firstPrompt: null, aiTitle: null, startedAt: null, lastActivityAt: null, memo: null, hasTranscript: false, live: null, summary: null, fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, lock: null, remoteOnly: false };
    const b: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: s, projects: [], sessions: [ses], live: [], runs: [], tabs: [], usage: { fiveHour: null, sevenDay: null, updatedAt: null }, todos: [], artifacts: [], summaryPending: [], index: { phase: 'idle', done: 0, total: 0 }, version: '0', sync: { state: 'off', url: null, lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 0, claudeConfig: { enabled: false, confirmed: false } }, devices: [] };
    expect(b.summaryPending).toEqual([]);
    const r: PromoteResultDto = { project: { id: 'p', name: 'n', status: 'active', isScratch: false, path: '/w/n', resolved: true, lastActivityAt: null, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 }, session: ses, moved: true, reason: null };
    expect(r.moved).toBe(true);
    const t: SummarizerTestDto = { ok: false, tried: [{ id: 'lmstudio', message: 'x' }] };
    expect(t.ok).toBe(false);
  });
  it('Intent に gitInit、split.resize、summarizer.test、artifact.openEditor がある', () => {
    const is: Intent[] = [{ type: 'session.promote.submit', id: 's1', name: 'n', gitInit: true, moveFiles: false }, { type: 'split.resize', ratio: 0.4 }, { type: 'summarizer.test' }, { type: 'artifact.openEditor', id: 'a1' }];
    expect(is).toHaveLength(4);
  });
});

describe('フェーズ 4 の DTO', () => {
  it('ロック、同期の状態、端末、設定の下見が組み立てられる', () => {
    const lock: SessionLockDto = { deviceId: 'd2', deviceName: 'mini', runId: 'r1', heartbeatAt: 1, stale: false };
    const status: SyncStatusDto = { state: 'idle', url: 'https://x.workers.dev', lastPushAt: 1, lastPullAt: 2, pending: 0, error: null, deviceCount: 2, claudeConfig: { enabled: true, confirmed: false } };
    const device: DeviceDto = { id: 'd2', name: 'mini', platform: 'darwin', lastSeenAt: 3, self: false };
    const preview: ConfigPreviewDto = { entries: [{ path: 'skills/x/SKILL.md', action: 'create', localMtime: null, remoteMtime: 4, remoteDevice: 'mini', size: 10 }], confirmed: false };
    expect(lock.stale).toBe(false);
    expect(status.claudeConfig.enabled).toBe(true);
    expect(device.self).toBe(false);
    expect(preview.entries[0]!.action).toBe('create');
  });
  it('同期と端末の ServerEvent がある', () => {
    const status: SyncStatusDto = { state: 'pushing', url: null, lastPushAt: null, lastPullAt: null, pending: 3, error: null, deviceCount: 1, claudeConfig: { enabled: false, confirmed: false } };
    const evs: ServerEvent[] = [{ type: 'sync.status', status }, { type: 'sync.applied', table: 'sessions', rowId: 's1' }, { type: 'devices.update', devices: [] }];
    expect(evs.map((e) => e.type)).toEqual(['sync.status', 'sync.applied', 'devices.update']);
  });
  it('この PC で再開と設定の同期の Intent がある', () => {
    const is: Intent[] = [{ type: 'session.resumeHere', id: 's1' }, { type: 'session.resumeHere', id: 's1', overwrite: true }, { type: 'sync.config.preview' }, { type: 'sync.config.apply' }, { type: 'sync.joinToken.show' }];
    expect(is).toHaveLength(5);
  });
});
