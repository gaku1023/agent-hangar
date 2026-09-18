import { describe, expect, it, vi } from 'vitest';
import type { UsageDto } from '@agent-hangar/shared';
import { ClaudeHeadlessSummarizer, type SpawnText } from './claude.ts';
import { CANNED_INPUT } from './input.ts';
import { SummarizerError } from './types.ts';

const usage = (sevenDay: number | null): UsageDto => ({ fiveHour: null, sevenDay: sevenDay === null ? null : { usedPercent: sevenDay, resetsAt: null }, updatedAt: 1 });
const good = { type: 'result', structured_output: { title: 'T', one_liner: 'O', body: 'B', state: 'in_progress', next_steps: ['n'] }, result: '{}', total_cost_usd: 0.02 };
const spawnOk: SpawnText = async () => ({ code: 0, stdout: JSON.stringify(good), stderr: 'Enterprise policy warning\n' });

describe('ClaudeHeadlessSummarizer', () => {
  it('claude -p を呼び、structured_output を読む', async () => {
    const spawn = vi.fn(spawnOk);
    const s = new ClaudeHeadlessSummarizer({ claudeBin: '/usr/local/bin/claude', hourlyCap: 20, usage: () => usage(10), spawn });
    expect(s.id).toBe('claude-headless');
    expect(await s.available()).toBe(true);
    const out = await s.summarize(CANNED_INPUT);
    expect(out).toEqual({ title: 'T', oneLiner: 'O', body: 'B', state: 'in_progress', nextSteps: ['n'] });
    const [cmd, args, stdin, timeout] = spawn.mock.calls[0]!;
    expect(cmd).toBe('/usr/local/bin/claude');
    expect(args.slice(0, 6)).toEqual(['-p', '--model', 'haiku', '--output-format', 'json', '--json-schema']);
    expect(JSON.parse(args[6]!)).toMatchObject({ type: 'object', required: expect.arrayContaining(['title']) });
    expect(args).toContain('--no-session-persistence');
    expect(args.slice(-2)).toEqual(['--tools', '']);
    expect(stdin).toBe(CANNED_INPUT.text);
    expect(timeout).toBe(120_000);
    expect(s.callsInLastHour()).toBe(1);
  });
  it('上限、7 日の使用率、claude の不在で available が偽になる', async () => {
    let t = 0;
    const s = new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 2, usage: () => usage(null), spawn: spawnOk, now: () => t });
    await s.summarize(CANNED_INPUT); await s.summarize(CANNED_INPUT);
    expect(await s.available()).toBe(false);
    t = 3_600_001;
    expect(await s.available()).toBe(true);
    expect(await new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(80), spawn: spawnOk }).available()).toBe(false);
    expect(await new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(79.9), spawn: spawnOk }).available()).toBe(true);
    expect(await new ClaudeHeadlessSummarizer({ claudeBin: null, hourlyCap: 20, usage: () => usage(null), spawn: spawnOk }).available()).toBe(false);
  });
  it('終了コードが 0 でない、JSON でない、structured_output が無いときは失敗し、呼び出しは数える', async () => {
    const bad: SpawnText = async () => ({ code: 1, stdout: '', stderr: 'rate limited' });
    const s = new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(null), spawn: bad });
    await expect(s.summarize(CANNED_INPUT)).rejects.toThrow(/rate limited/);
    expect(s.callsInLastHour()).toBe(1);
    await expect(new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(null), spawn: async () => ({ code: 0, stdout: 'nope', stderr: '' }) }).summarize(CANNED_INPUT)).rejects.toThrow(SummarizerError);
    await expect(new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(null), spawn: async () => ({ code: 0, stdout: JSON.stringify({ result: 'x' }), stderr: '' }) }).summarize(CANNED_INPUT)).rejects.toThrow(/structured_output/);
    await expect(new ClaudeHeadlessSummarizer({ claudeBin: null, hourlyCap: 20, usage: () => usage(null), spawn: spawnOk }).summarize(CANNED_INPUT)).rejects.toThrow(/claude/);
  });
});
