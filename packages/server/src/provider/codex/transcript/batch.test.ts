import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileBatch, TranscriptFile } from '../../../agent/types.ts';
import { CODEX_LEGACY, CODEX_ONE_TURN, CODEX_TOOLS, fixtureBytes, makeCodexHome, putRollout } from '../../../../test/codexFixtures.ts';
import { readCodexBatch } from './batch.ts';

let home: string;
beforeEach(() => { home = makeCodexHome(); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const fileOf = (path: string, sessionId: string): TranscriptFile => ({ path, sessionId, agentId: null, deviceId: null });
const strip = (b: FileBatch) => ({ ...b, fold: undefined });
const totalUsage = (b: FileBatch) => b.records.reduce((a, r) => ({ input: a.input + (r.facts.usage?.input ?? 0), output: a.output + (r.facts.usage?.output ?? 0) }), { input: 0, output: 0 });

describe('readCodexBatch', () => {
  it('paginated の 1 ターンを束にする：agent、cwd、reset、使用量、ターンの終わり', () => {
    const p = putRollout(home, 'r.jsonl', fixtureBytes(CODEX_ONE_TURN.file));
    const b = readCodexBatch(fileOf(p, CODEX_ONE_TURN.id), 0);
    expect(b).toMatchObject({ agent: 'codex', providerSessionId: CODEX_ONE_TURN.id, agentId: null, cwd: '/work/sample', reset: true, badLines: 0 });
    expect(b.nextByte).toBe(fixtureBytes(CODEX_ONE_TURN.file).length);
    expect(totalUsage(b)).toEqual({ input: 1200, output: 70 });
    expect(b.records.filter((r) => r.endsTurn)).toHaveLength(1);
    expect(b.records.filter((r) => r.typedPrompt)).toHaveLength(1);
    // 「いま」は最後のツール呼び出し。
    expect(b.fold!.activity(null).next).toMatchObject({ tool: 'Bash', summary: 'Bash ls -la', toolId: 'call_one', question: null });
  });

  it('legacy（合成）は先頭の history_mode が無いので、token_count から使用量を取る', () => {
    const p = putRollout(home, 'l.jsonl', fixtureBytes(CODEX_LEGACY.file));
    const b = readCodexBatch(fileOf(p, CODEX_LEGACY.id), 0);
    expect(totalUsage(b)).toEqual({ input: 400, output: 30 });
  });

  it('途中のバイト位置から読んでも、同じ rollout の mode で数える（paginated の token_count から足さない）', () => {
    const p = putRollout(home, 'r.jsonl', fixtureBytes(CODEX_ONE_TURN.file));
    const all = readCodexBatch(fileOf(p, CODEX_ONE_TURN.id), 0);
    const mid = all.records[10]!.locator;
    expect(mid.kind).toBe('file');
    const from = mid.kind === 'file' ? mid.offset : 0;
    const tail = readCodexBatch(fileOf(p, CODEX_ONE_TURN.id), from);
    expect(tail.reset).toBe(false);
    expect(totalUsage(tail).output).toBeLessThanOrEqual(70);
    // 最初の束の後半と同じ事実になる。
    expect(tail.records.map((r) => r.facts)).toEqual(all.records.slice(10).map((r) => r.facts));
  });

  it('nextByte から続けて読むと、全体を一度に読んだものと同じ events と facts になる。行の途中で切れた末尾は次回に回る', () => {
    const body = fixtureBytes(CODEX_TOOLS.file);
    const p = `${home}/t.jsonl`;
    // 最後の行の途中まで。
    const cut = body.length - 40;
    fs.writeFileSync(p, body.subarray(0, cut));
    const f = fileOf(p, CODEX_TOOLS.id);
    const first = readCodexBatch(f, 0);
    expect(first.nextByte).toBeLessThan(cut);
    fs.writeFileSync(p, body);
    const second = readCodexBatch(f, first.nextByte);
    const whole = readCodexBatch(f, 0);
    expect(second.reset).toBe(false);
    const flat = (bs: FileBatch[]) => bs.flatMap((b) => b.records.map((r) => ({ events: r.events.map((e) => ({ ...e, seq: 0 })), facts: r.facts, loc: r.locator })));
    expect(flat([first, second])).toEqual(flat([whole]));
  });

  it('追記された rollout を from から読むと、増えた行だけの束になる（reset は偽）', () => {
    const p = `${home}/t.jsonl`;
    fs.writeFileSync(p, fixtureBytes(CODEX_ONE_TURN.file));
    const f = fileOf(p, CODEX_ONE_TURN.id);
    const first = readCodexBatch(f, 0);
    fs.appendFileSync(p, '{"timestamp":"2026-10-26T05:30:00.000Z","type":"event_msg","payload":{"type":"task_started","model_context_window":1000}}\n');
    const next = readCodexBatch(f, first.nextByte);
    expect(next.reset).toBe(false);
    expect(next.records).toHaveLength(1);
    expect(next.records[0]!.facts.contextSize).toBe(1000);
  });

  it('壊れた行と type の無い行は badLines に数えて飛ばす', () => {
    const p = `${home}/t.jsonl`;
    fs.writeFileSync(p, `${fixtureBytes(CODEX_ONE_TURN.file).toString('utf8')}not json\n{"no":"type"}\n`);
    const b = readCodexBatch(fileOf(p, CODEX_ONE_TURN.id), 0);
    expect(b.badLines).toBe(2);
  });

  it('外の会話の cwd は、最後の thread_settings_applied を優先する', () => {
    const b = readCodexBatch(fileOf(putRollout(home, 't.jsonl', fixtureBytes(CODEX_TOOLS.file)), CODEX_TOOLS.id), 0);
    expect(b.cwd).toBe('/work/sample/sub');
  });

  it('.jsonl を .jsonl.zst に置き換えたあと、同じ論理パスで読むと 0 行の束で、reset は偽（event_index が変わらない前提）', () => {
    const logical = `${home}/rollout-z.jsonl`;
    putRollout(home, 'rollout-z.jsonl', fixtureBytes(CODEX_ONE_TURN.file));
    const first = readCodexBatch(fileOf(logical, CODEX_ONE_TURN.id), 0);
    fs.rmSync(logical);
    putRollout(home, 'rollout-z.jsonl.zst', fixtureBytes(`${CODEX_ONE_TURN.file}.zst`));
    const again = readCodexBatch(fileOf(logical, CODEX_ONE_TURN.id), first.nextByte);
    expect(strip(again)).toMatchObject({ records: [], reset: false, nextByte: first.nextByte, badLines: 0 });
  });

  it('壊れた zst は束を作らず投げる', () => {
    putRollout(home, 'bad.jsonl.zst', 'garbage');
    expect(() => readCodexBatch(fileOf(`${home}/bad.jsonl`, 'x'), 0)).toThrow();
  });

  it('展開後の長さが from より短い（作り直し）ときは reset で先頭から', () => {
    const logical = `${home}/rollout-z.jsonl`;
    putRollout(home, 'rollout-z.jsonl.zst', fixtureBytes(`${CODEX_ONE_TURN.file}.zst`));
    const b = readCodexBatch(fileOf(logical, CODEX_ONE_TURN.id), 10_000_000);
    expect(b.reset).toBe(true);
    expect(b.records.length).toBeGreaterThan(5);
  });
});
