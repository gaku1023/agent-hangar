import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVE_ECHO, PROMPT_HI, PROMPT_SLEEP, PROMPT_TURN, startMockLlm } from './opencodeHarness.ts';

/**
 * 互換の見張り（opencodeLive.test.ts）の模擬 LLM が、筋書きのどこにいるかを取り違えないことを見る。
 * 本物の opencode は要らない。ふだんの npm test で走る。
 */
const TOOLS = ['shell', 'execute', 'write', 'edit', 'read', 'question'];

type Msg = { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string };

describe('模擬 LLM の筋書き', () => {
  let dir: string;
  let llm: Awaited<ReturnType<typeof startMockLlm>>;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mock-llm-'));
    llm = await startMockLlm({ repo: dir });
  });
  afterAll(async () => {
    await llm.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 1 回頼み、SSE から道具の名前（無ければ文）を読む。 */
  async function next(messages: Msg[], tools = TOOLS): Promise<{ tool: string | null; text: string }> {
    const r = await fetch(`${llm.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock', stream: true, messages, tools: tools.map((name) => ({ type: 'function', function: { name, parameters: {} } })) }),
    });
    let tool: string | null = null;
    let text = '';
    for (const line of (await r.text()).split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const c = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string; tool_calls?: { function?: { name?: string } }[] } }[] };
      const d = c.choices?.[0]?.delta;
      tool ??= d?.tool_calls?.[0]?.function?.name ?? null;
      text += d?.content ?? '';
    }
    return { tool, text };
  }
  const called = (id: string, name: string, result: string): Msg[] => [
    { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content: result },
  ];
  /** opencode 2.1.4 が、hangar の MCP の道具が後から増えたときにターンの途中へ差し込む知らせ（利用者の発言として届く）。 */
  const CATALOG_NOTICE = 'The Code Mode tool catalog has changed.\n\nNew tools are available in addition to those previously listed:\n  - tools.hangar.set_turn_intent({\n  text: string,\n}): Promise<unknown> // Record what this turn is about.';

  it('TURN は shell から始め、道具の結果の数で先へ進む', async () => {
    expect((await next([{ role: 'system', content: 'sys' }, { role: 'user', content: PROMPT_TURN }])).tool).toBe('shell');
    expect((await next([{ role: 'user', content: PROMPT_TURN }, ...called('a', 'shell', `${LIVE_ECHO}\n`)])).tool).toBe('execute');
    expect((await next([{ role: 'user', content: PROMPT_TURN }, ...called('a', 'shell', 'x')], TOOLS.filter((t) => t !== 'execute'))).tool).toBe('write');
  });

  it('ターンの途中に差し込まれた知らせを、新しい発言と取り違えない', async () => {
    const msgs: Msg[] = [
      { role: 'user', content: PROMPT_TURN },
      ...called('a', 'shell', 'hangar-live\n'),
      { role: 'user', content: [{ type: 'text', text: CATALOG_NOTICE }] },
    ];
    expect((await next(msgs)).tool).toBe('execute');
    expect((await next([...msgs, ...called('b', 'execute', 'ok')])).tool).toBe('write');
  });

  it('SLEEP と HI は筋書きの頭で選ぶ', async () => {
    expect((await next([{ role: 'user', content: PROMPT_SLEEP }])).tool).toBe('shell');
    expect((await next([{ role: 'user', content: PROMPT_SLEEP }, ...called('a', 'shell', '')])).text).toBe('Woke up.');
    expect((await next([{ role: 'user', content: PROMPT_TURN }, { role: 'assistant', content: 'All done.' }, { role: 'user', content: PROMPT_HI }])).text).toBe('Hi.');
  });
});
