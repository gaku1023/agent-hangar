import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageDto } from '@agent-hangar/shared';
import { ClaudeHeadlessSummarizer, spawnText, type SpawnText } from './claude.ts';
import type { Drift } from '../compat/types.ts';
import { CANNED_INPUT } from '../../../summary/input.ts';
import { SummarizerError } from '../../../summary/types.ts';

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
    expect(out).toEqual({ title: 'T', oneLiner: 'O', body: 'B', state: 'in_progress', nextSteps: ['n'], model: 'haiku' });
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
  it('structured_output の状態の提案を要約に添え、--json-schema にも項目を載せる', async () => {
    const so = { ...good.structured_output, proposed_status: 'done', proposed_note: '直して main に入れた', proposed_return_in_days: 0 };
    const spawnWith: SpawnText = async () => ({ code: 0, stdout: JSON.stringify({ ...good, structured_output: so }), stderr: '' });
    const spawn = vi.fn(spawnWith);
    const out = await new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(null), spawn }).summarize(CANNED_INPUT);
    expect(out.proposal).toEqual({ status: 'done', note: '直して main に入れた', returnInDays: null });
    expect(JSON.parse(spawn.mock.calls[0]![1][6]!).required).toEqual(expect.arrayContaining(['proposed_status', 'proposed_note', 'proposed_return_in_days']));
  });
  it('-p の JSON に structured_output が無ければ、ずれとして知らせる。読めたときは知らせない', async () => {
    const seen: Drift[] = [];
    const compat = { note: (d: Drift) => seen.push(d) };
    const bad = new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(null), spawn: async () => ({ code: 0, stdout: '{"type":"result","result":"x"}', stderr: '' }), compat });
    await expect(bad.summarize(CANNED_INPUT)).rejects.toBeInstanceOf(SummarizerError);
    expect(seen).toEqual([{ contract: 'cli', value: 'print-json.structured_output=(missing)', version: null }]);
    await new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(null), spawn: spawnOk, compat }).summarize(CANNED_INPUT);
    expect(seen).toHaveLength(1);
  });
});

describe('spawnText', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-summary-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  // -p の JSON は要約の本文を含むので、パイプの容量（8KB〜16KB）を越えうる。
  // claude はパイプへ非同期に書いて書き切る前に終わることがあるので、標準出力はファイルへ書かせて読む。
  it('標準入力を渡し、パイプの容量を越える標準出力を最後まで読む。標準エラーも集める', async () => {
    const big = JSON.stringify({ ...good, result: 'x'.repeat(80 * 1024) });
    const js = path.join(tmp, 'claude.mjs');
    fs.writeFileSync(js, [
      'let s = "";',
      'for await (const c of process.stdin) s += c;',
      'process.stderr.write(`read ${s.length}\\n`);',
      `process.stdout.write(${JSON.stringify(big)});`,
      'process.exit(0);',
    ].join('\n'));
    const r = await spawnText(process.execPath, [js], CANNED_INPUT.text, 10_000);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(big);
    expect(r.stderr).toBe(`read ${CANNED_INPUT.text.length}\n`);
  });
  it('0 以外の終了コードを返し、時間を過ぎたら止めて投げる', async () => {
    const bad = path.join(tmp, 'bad.mjs');
    fs.writeFileSync(bad, 'process.stderr.write("rate limited\\n");\nprocess.exit(2);\n');
    expect(await spawnText(process.execPath, [bad], '', 10_000)).toEqual({ code: 2, stdout: '', stderr: 'rate limited\n' });
    const hang = path.join(tmp, 'hang.mjs');
    fs.writeFileSync(hang, 'setInterval(() => {}, 1000);\n');
    await expect(spawnText(process.execPath, [hang], '', 300)).rejects.toThrow('300 ミリ秒で応答がありませんでした');
  });
});
