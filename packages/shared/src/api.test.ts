import { describe, expect, it } from 'vitest';
import type { BootstrapDto, LaunchResultDto, RunDto, ServerEvent, SettingsDto, TabDto } from './index.ts';

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
    const s: SettingsDto = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'terminal', codePath: null };
    const b: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: s, projects: [], sessions: [], live: [], runs: [], tabs: [], index: { phase: 'idle', done: 0, total: 0 }, version: '0' };
    expect(b.runs).toEqual([]);
    expect(b.settings.terminalApp).toBe('terminal');
  });
});
