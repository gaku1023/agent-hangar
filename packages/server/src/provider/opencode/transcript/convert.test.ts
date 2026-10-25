import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@agent-hangar/shared';
import { fixtureMessages } from '../../../../test/fake-opencode-events.ts';
import { convertMessage, convertMessages, settledCount } from './convert.ts';

// 記録した 2.1.4 の本文（test/fixtures/opencode/2.1.4/README.md の「本文」）。答えの data は新しい順なので、古い順に直して渡す。
const oldestFirst = (name: string) => [...fixtureMessages(name).data].reverse() as Record<string, unknown>[];
const ALL = oldestFirst('messages.json');

/** 並びを見るのに要る欄だけにする。 */
const brief = (e: TranscriptEvent): string => {
  switch (e.kind) {
    case 'user': case 'assistant': case 'thinking': return `${e.kind}:${e.text}`;
    case 'tool_call': return `call:${e.name}:${e.summary}`;
    case 'tool_result': return `result:${e.isError ? 'error' : 'ok'}`;
    case 'system': return `system:${e.subtype ?? ''}`;
    default: return e.kind;
  }
};

describe('convertMessages（記録した 2.1.4 の本文）', () => {
  const records = convertMessages(ALL);
  const events = records.flatMap((r) => r.events);

  it('メッセージ 1 つを記録 1 つにし、イベントを古い順に並べる', () => {
    expect(records).toHaveLength(ALL.length);
    expect(events.map(brief)).toEqual([
      'user:Run echo, record the intent, write and edit a file, then ask me a question.',
      'thinking:I will run echo first.', 'call:Bash:Bash echo hangar-capture', 'result:ok',
      'system:instructions',
      'thinking:I will run echo first.', 'call:Bash:Bash echo hangar-capture', 'result:ok',
      'call:mcp__hangar__set_turn_intent:mcp__hangar__set_turn_intent', 'result:ok',
      'call:Write:Write /work/repo/notes.txt', 'result:ok',
      'call:Edit:Edit /work/repo/notes.txt', 'result:ok',
      'call:Read:Read /work/repo/notes.txt', 'result:ok',
      'call:AskUserQuestion:AskUserQuestion', 'result:ok',
      'thinking:The user picked a color; wrap up.', 'assistant:All done.',
      'system:idle',
      'user:Sleep please.',
      'call:Bash:Bash sleep 20', 'result:error', 'system:error',
      'system:idle',
      'user:Say hi.',
      'assistant:Hi.',
      'system:idle',
    ]);
  });

  it('seq は束の中で 0 から通しで振る', () => {
    expect(events.map((e) => e.seq)).toEqual([...events.keys()]);
  });

  it('shell は description が無いので、summary は命令の 1 行目から作る', () => {
    const call = events.find((e) => e.kind === 'tool_call' && e.name === 'Bash')!;
    expect(call).toMatchObject({ kind: 'tool_call', toolId: 'call_shell_1', summary: 'Bash echo hangar-capture', input: { command: 'echo hangar-capture\necho second-line' } });
  });

  it('道具の結果は呼び出しのすぐ後に置き、本文の文を text に持つ', () => {
    const i = events.findIndex((e) => e.kind === 'tool_call' && e.toolId === 'call_shell_1');
    expect(events[i + 1]).toMatchObject({ kind: 'tool_result', toolId: 'call_shell_1', text: 'hangar-capture\nsecond-line\n', isError: false });
  });

  it('編集の道具は共通の名前と引数の形に直し、触ったファイルを filePath に持つ', () => {
    const edit = events.find((e) => e.kind === 'tool_call' && e.name === 'Edit');
    expect(edit).toMatchObject({ toolId: 'call_edit_6', filePath: '/work/repo/notes.txt', input: { file_path: '/work/repo/notes.txt', old_string: 'beta', new_string: 'gamma' } });
    const write = events.find((e) => e.kind === 'tool_call' && e.name === 'Write');
    expect(write).toMatchObject({ filePath: '/work/repo/notes.txt', input: { file_path: '/work/repo/notes.txt', content: 'alpha\nbeta\n' } });
    const read = events.find((e) => e.kind === 'tool_call' && e.name === 'Read');
    expect(read).toMatchObject({ filePath: '/work/repo/notes.txt', input: { file_path: '/work/repo/notes.txt' } });
  });

  it('question は AskUserQuestion の形にし、問いの並びはそのまま持つ', () => {
    const q = events.find((e) => e.kind === 'tool_call' && e.name === 'AskUserQuestion');
    expect(q).toMatchObject({ toolId: 'call_question_8', input: { questions: [{ question: 'Which color do you prefer?', header: 'Color' }] } });
  });

  it('Code Mode の execute は metadata.toolCalls を MCP の道具の呼び出しに展開する', () => {
    const call = events.find((e) => e.kind === 'tool_call' && e.name.startsWith('mcp__'));
    expect(call).toMatchObject({ toolId: 'call_execute_4#0', name: 'mcp__hangar__set_turn_intent', input: { text: 'Capture the transcript' } });
    expect(events.find((e) => e.kind === 'tool_result' && e.toolId === 'call_execute_4#0')).toMatchObject({ text: 'ok', isError: false });
    expect(events.some((e) => e.kind === 'tool_call' && e.name === 'execute')).toBe(false);
  });

  it('interrupt で止まった道具は失敗の結果にし、手順の失敗を system に残す', () => {
    const r = events.find((e) => e.kind === 'tool_result' && e.isError);
    expect(r).toMatchObject({ toolId: 'call_shell_10', text: 'Tool execution interrupted' });
    expect(events.find((e) => e.kind === 'system' && e.subtype === 'error')).toMatchObject({ text: 'Step interrupted' });
  });

  it('ターンの終わり（idle）は、読む中身の無い system にして endsTurn を立てる', () => {
    const idles = records.filter((r) => r.endsTurn);
    expect(idles).toHaveLength(3);
    for (const r of idles) expect(r.events).toEqual([expect.objectContaining({ kind: 'system', subtype: 'idle', text: 'idle' })]);
  });

  it('利用者の発言は打った発言として数える', () => {
    const users = records.filter((r) => r.facts.isUserTurn);
    expect(users.map((r) => (r.events[0] as { text: string }).text)).toEqual([
      'Run echo, record the intent, write and edit a file, then ask me a question.', 'Sleep please.', 'Say hi.',
    ]);
    expect(users.every((r) => r.typedPrompt === true)).toBe(true);
  });

  it('返答の記録は、モデル・トークン・コスト・文脈の量を facts に持つ', () => {
    const first = records[1]!;
    expect(first.facts).toEqual({ isUserTurn: false, ts: 1792902392286, model: 'mock/mock', usage: { input: 10, output: 3 }, costUsd: 0, contextTokens: 10 });
    expect(records[0]!.facts).toEqual({ isUserTurn: true, ts: 1792902392280 });
    expect(records.every((r) => r.locator.kind === 'stored')).toBe(true);
  });

  it('知らない種類のメッセージは捨てずに meta にする', () => {
    const r = convertMessage({ id: 'msg_x', type: 'compaction', time: { created: 5 }, summary: 's' }, 7);
    expect(r.events).toEqual([{ kind: 'meta', seq: 7, ts: 5, name: 'compaction', value: { summary: 's' } }]);
  });

  it('呼び出しの無い execute は execute のまま残す', () => {
    const r = convertMessage({ id: 'msg_y', type: 'assistant', time: { created: 9, completed: 10 }, content: [
      { type: 'tool', id: 'call_e', name: 'execute', state: { status: 'completed', input: { code: 'return 1 + 1;' }, content: [{ type: 'text', text: '2' }], metadata: { toolCalls: [] } } },
    ] }, 0);
    expect(r.events.map(brief)).toEqual(['call:execute:execute', 'result:ok']);
    expect(r.events[0]).toMatchObject({ input: { code: 'return 1 + 1;' } });
  });

  it('知らない道具は名前と引数をそのまま持つ', () => {
    const r = convertMessage({ id: 'msg_z', type: 'assistant', time: { created: 9, completed: 10 }, content: [
      { type: 'tool', id: 'call_w', name: 'webfetch', state: { status: 'completed', input: { url: 'https://example.com' }, content: [{ type: 'text', text: 'page' }] } },
    ] }, 0);
    expect(r.events[0]).toMatchObject({ kind: 'tool_call', name: 'webfetch', input: { url: 'https://example.com' }, summary: 'webfetch https://example.com' });
  });
});

describe('settledCount（未作成の扱い）', () => {
  it('終わったメッセージだけなら全部を確定とする', () => {
    expect(settledCount(ALL)).toBe(ALL.length);
  });

  it('まだ終わっていない返答（completed の無い assistant）とその後ろは、まだ無いものとして数えない', () => {
    const form = oldestFirst('messages-while-form.json');
    const n = settledCount(form);
    expect(n).toBe(form.length - 1);
    expect(form[n]).toMatchObject({ type: 'assistant' });
    expect((form[n]!.time as Record<string, unknown>).completed).toBeUndefined();
    const running = oldestFirst('messages-while-running.json');
    expect(settledCount(running)).toBe(running.length - 1);
  });

  it('completed の無い返答でも、後ろにターンの終わり（idle）があれば確定とする', () => {
    const stuck = { id: 'msg_a', type: 'assistant', time: { created: 1 }, content: [] };
    const idle = { id: 'msg_b', type: 'idle', time: { created: 2 }, outcome: 'interrupted' };
    expect(settledCount([stuck])).toBe(0);
    expect(settledCount([stuck, idle])).toBe(2);
  });
});
