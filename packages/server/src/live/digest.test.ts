import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { addIntent } from './intents.ts';
import { buildLiveDigest, LiveDigester } from './digest.ts';

const SID = 'bbbbbbbb-0000-4000-8000-000000000001';
const at = (s: number) => Date.UTC(2026, 9, 1, 1, 0, s);
const T = (s: number) => new Date(at(s)).toISOString();
const base = (s: number) => ({ uuid: `x${s}-${Math.random()}`, timestamp: T(s), cwd: '/w/live', sessionId: SID });
const user = (s: number, content: unknown) => ({ type: 'user', message: { role: 'user', content }, ...base(s) });
const toolUse = (s: number, id: string, name: string, input: unknown) => ({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name, input }] }, ...base(s) });
const result = (s: number, id: string, text: string, extra: Record<string, unknown> = {}, isError = false) => ({ ...user(s, [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }]), ...extra });
const say = (s: number, text: string) => ({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] }, ...base(s) });
const notify = (s: number, agentId: string, status: string) => user(s, `<task-notification>\n<task-id>${agentId}</task-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`);
const launched = (agentId: string) => ({ toolUseResult: { agentId, status: 'async_launched', isAsync: true } });

let dir: string;
let db: Db;
let sid: string;

function write(file: string, rows: unknown[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
async function index() {
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  sid = (db.prepare('select id from sessions where provider_session_id = ?').get(SID) as { id: string }).id;
}
const proj = () => path.join(dir, 'projects', '-w-live');
const sub = (agentId: string) => path.join(proj(), SID, 'subagents', `agent-${agentId}.jsonl`);

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-live-')); db = openDb(':memory:'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('buildLiveDigest', () => {
  beforeEach(async () => {
    write(path.join(proj(), `${SID}.jsonl`), [
      user(0, '前の指示'),
      toolUse(0.2, 'toolu_prev', 'Agent', { description: '前のターンの担当', prompt: 'p', run_in_background: true }),
      result(0.3, 'toolu_prev', 'Async agent launched', launched('aaa0')),
      user(1, 'レビューを並べて'),
      toolUse(2, 'toolu_a1', 'Agent', { description: 'クラウドを査読', prompt: 'p', run_in_background: true }),
      result(3, 'toolu_a1', 'Async agent launched', launched('aaa1')),
      toolUse(4, 'toolu_a2', 'Agent', { description: '文書を直す', prompt: 'p', run_in_background: true }),
      result(5, 'toolu_a2', 'Async agent launched', launched('aaa2')),
      toolUse(6, 'toolu_a3', 'Agent', { description: '壊れる担当', prompt: 'p' }),
      result(7, 'toolu_a3', 'Agent type not found', {}, true),
      toolUse(7.5, 'toolu_a9', 'Agent', { description: 'まだ始まらない担当', prompt: 'p', run_in_background: true }),
      result(7.6, 'toolu_a9', 'Async agent launched', launched('aaa9')),
      notify(20, 'aaa2', 'completed'),
      user(21, '[Request interrupted by user]'),
    ]);
    write(sub('aaa0'), [
      user(0.5, '前のターンの担当です。README を見て'),
      toolUse(12, 'toolu_s0', 'Read', { file_path: '/w/live/README.md' }),
    ]);
    write(sub('aaa1'), [
      user(2.5, 'クラウドを査読して'),
      toolUse(10, 'toolu_s1', 'Bash', { command: 'npx vitest run', description: 'テストを走らせる' }),
      result(11, 'toolu_s1', 'ok'),
    ]);
    write(sub('aaa2'), [
      user(4.5, '文書を直して'),
      toolUse(8, 'toolu_s2', 'Read', { file_path: '/w/live/README.md' }),
      result(9, 'toolu_s2', 'x'),
      say(19, '# 済：README を 3 か所直した\n詳細は次のとおり'),
    ]);
    await index();
  });

  it('今のターンの頭は、中断の知らせを除いた最後の指示', () => {
    const d = buildLiveDigest(db, sid);
    const seq = (db.prepare("select seq from event_index where session_id = ? and parent_agent is null and kind = 'user' order by seq").all(sid) as { seq: number }[]).map((r) => r.seq);
    // 3 つの指示（前の指示、レビューを並べて、中断）のうち 2 つ目。
    expect(d.turnStartSeq).toBe(seq[1]);
  });

  it('レーンは今のターンに起こした本と、前のターンから動き続けている本', () => {
    const d = buildLiveDigest(db, sid);
    expect(d.agents.map((a) => [a.agentId, a.title, a.state, a.linked])).toEqual([
      ['aaa1', 'クラウドを査読', 'running', true],
      ['aaa2', '文書を直す', 'done', true],
      ['tool:toolu_a3', '壊れる担当', 'error', false],
      ['aaa9', 'まだ始まらない担当', 'running', true],
      ['aaa0', '前のターンの担当です。README を見て', 'running', true],
    ]);
  });

  it('動いている本は最後の手を、終わった本は最後の報告の 1 行目を持つ', () => {
    const d = buildLiveDigest(db, sid);
    const by = (id: string) => d.agents.find((a) => a.agentId === id)!;
    expect(by('aaa1').last).toEqual({ text: 'テストを走らせる', mono: false, kind: 'run', isError: false });
    expect(by('aaa1').report).toBeNull();
    expect(by('aaa1')).toMatchObject({ startedAt: at(2.5), lastAt: at(11) });
    expect(by('aaa2').report).toBe('済：README を 3 か所直した');
    // まだ transcript の無い本は、起こした時刻だけを持ち、落ちない。
    expect(by('aaa9')).toMatchObject({ last: null, report: null, startedAt: at(7.5), lastAt: at(7.5) });
  });

  it('意図は最新の 1 件と、書いてから呼んだツールの数（主線とサブエージェントの合計）', () => {
    addIntent(db, sid, 'レビューを並べて待つ', at(5));
    const d = buildLiveDigest(db, sid);
    // at(5) より後のツール呼び出し：a3（6）、a9（7.5）、aaa2 の Read（8）、aaa1 の Bash（10）、aaa0 の Read（12）。
    expect(d.intent).toEqual({ text: 'レビューを並べて待つ', at: at(5), stepsSince: 5, inThisTurn: true });
  });

  it('今のターンより前に書かれた意図は inThisTurn が偽', () => {
    addIntent(db, sid, '前のターンの意図', at(0.1));
    expect(buildLiveDigest(db, sid).intent).toMatchObject({ text: '前のターンの意図', inThisTurn: false });
  });

  it('意図が一度も書かれていなければ null', () => {
    expect(buildLiveDigest(db, sid).intent).toBeNull();
  });
});

describe('agentId の無い古い記録', () => {
  it('Agent の呼び出しと、今のターンに始まったサブエージェントを順番で突き合わせる', async () => {
    write(path.join(proj(), `${SID}.jsonl`), [
      user(1, '調べて'),
      toolUse(2, 'toolu_o1', 'Task', { description: '古い形の担当', prompt: 'p' }),
      result(9, 'toolu_o1', '報告です'),
    ]);
    write(sub('old1'), [user(3, '古い形の担当です'), say(8, '調べ終えた')]);
    await index();
    expect(buildLiveDigest(db, sid).agents).toEqual([
      expect.objectContaining({ agentId: 'old1', title: '古い形の担当', state: 'done', linked: true, report: '調べ終えた' }),
    ]);
  });
});

describe('LiveDigester', () => {
  it('索引と意図が変わっていなければ、同じ要約をそのまま返す', async () => {
    write(path.join(proj(), `${SID}.jsonl`), [user(1, '見て')]);
    await index();
    const g = new LiveDigester(db);
    const a = g.digest(sid);
    expect(g.digest(sid)).toBe(a);
    addIntent(db, sid, '新しい意図', at(2));
    expect(g.digest(sid)).not.toBe(a);
  });
});
