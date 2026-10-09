import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import type { LiveSession } from '../provider/claude-code/types.ts';
import { ASIDE_SETTLE_MS, AsideReader } from './aside.ts';

// 本体は入力を受け付けていて、裏でサブエージェントだけが動いている。Claude の登録はこのとき busy としか書かない。
const SID = 'cccccccc-0000-4000-8000-000000000001';
const at = (s: number) => Date.UTC(2026, 9, 7, 1, 0, s);
const T = (s: number) => new Date(at(s)).toISOString();
const base = (s: number) => ({ uuid: `x${s}-${Math.random()}`, timestamp: T(s), cwd: '/w/aside', sessionId: SID });
const user = (s: number, content: unknown) => ({ type: 'user', message: { role: 'user', content }, ...base(s) });
const toolUse = (s: number, id: string, name: string, input: unknown) => ({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name, input }] }, ...base(s) });
const result = (s: number, id: string, text: string, extra: Record<string, unknown> = {}) => ({ ...user(s, [{ type: 'tool_result', tool_use_id: id, content: text, is_error: false }]), ...extra });
const say = (s: number, text: string) => ({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] }, ...base(s) });
const system = (s: number, subtype: string) => ({ type: 'system', subtype, ...base(s) });
const notify = (s: number, agentId: string) => user(s, `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>`);
const launched = (agentId: string) => ({ toolUseResult: { agentId, status: 'async_launched', isAsync: true } });
/** 裏の担当を 1 本起こして、本体のターンを 10 秒で終える。 */
const launchAndEnd = () => [
  user(0, 'レビューを裏で回して'),
  toolUse(1, 'toolu_a1', 'Agent', { description: 'コードレビュー', prompt: 'p', run_in_background: true }),
  result(2, 'toolu_a1', 'Async agent launched', launched('aaa1')),
  say(3, '返ってきたら直します'),
  system(10, 'stop_hook_summary'),
  system(10, 'turn_duration'),
];
const END = at(10);

let dir: string;
let db: Db;

function write(rows: unknown[]) {
  const file = path.join(dir, 'projects', '-w-aside', `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
async function index(rows: unknown[]) {
  write(rows);
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
}
const busy = (over: Partial<LiveSession> = {}): LiveSession => ({ sessionId: SID, status: 'busy', name: null, nameSource: null, cwd: '/w/aside', pid: 1, statusAt: at(0), ...over });
const read = (live: LiveSession[], now: number) => new AsideReader(db).apply(live, now);

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-aside-')); db = openDb(':memory:'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('裏だけ動いている（サブエージェント）', () => {
  it('ターンが終わって落ち着いたのに作業中のままなら、裏で動いている本数を付ける', async () => {
    await index(launchAndEnd());
    expect(read([busy()], END + ASIDE_SETTLE_MS)).toEqual([{ ...busy(), aside: { shell: false, agents: 1 } }]);
  });
  it('ターンが終わった直後は付けない（裏の無いターンでも、休みへ移るまで少しかかる）', async () => {
    await index(launchAndEnd());
    expect(read([busy()], END + ASIDE_SETTLE_MS - 1)).toEqual([busy()]);
  });
  it('作業中になったのがターンの終わりより後なら付けない（新しい指示が索引にまだ載っていない）', async () => {
    await index(launchAndEnd());
    expect(read([busy({ statusAt: END + 500 })], END + 10_000)).toEqual([busy({ statusAt: END + 500 })]);
  });
  it('ターンの終わりの後に新しい指示、知らせ、返答があれば付けない', async () => {
    for (const next of [user(12, '次はこれ'), notify(12, 'aaa1'), say(12, '続けます')]) {
      await index([...launchAndEnd(), next]);
      expect(read([busy()], END + 10_000)).toEqual([busy()]);
    }
  });
  it('ターンの終わりの後に来た要約などの記録は、本体の動きとみなさない', async () => {
    await index([...launchAndEnd(), system(30, 'away_summary')]);
    expect(read([busy()], END + 10_000)[0]!.aside).toEqual({ shell: false, agents: 1 });
  });
  it('裏の担当が数えられなくても（workflow など）、作業中のままなら 0 本として付ける', async () => {
    await index([user(0, '流して'), say(3, '流しました'), system(10, 'turn_duration')]);
    expect(read([busy()], END + 10_000)[0]!.aside).toEqual({ shell: false, agents: 0 });
  });
  it('作業中でないもの、シェルの印が付いたもの、hangar が知らない会話はそのまま', async () => {
    await index(launchAndEnd());
    const shell = busy({ aside: { shell: true, agents: 0 } });
    const live = [busy({ status: 'idle' }), shell, busy({ sessionId: 'unknown' })];
    expect(read(live, END + 10_000)).toEqual(live);
  });
});
