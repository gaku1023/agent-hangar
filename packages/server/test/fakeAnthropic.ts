import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 本物の claude に向ける、偽の Anthropic API（ANTHROPIC_BASE_URL で向ける）。
 * 最後の発言の合言葉で、Bash か AskUserQuestion（1 問）を呼ぶ。道具の結果が返ったら、その中身を text で返して終える。
 * 道具の結果（tool_result）の文字は results に溜める。試験が、claude が答えをどう受け取ったかを見る。
 * モデルは使わないので、料金はかからない。
 */
export type FakeAnthropic = { url: string; results: string[]; close(): Promise<void> };

const ASK = { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'r' }, { label: 'Blue', description: 'b' }] }] };

function textOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b: { type?: string; text?: string; content?: unknown; is_error?: boolean }) => (b.type === 'text' ? (b.text ?? '') : b.type === 'tool_result' ? `TOOL_RESULT:${JSON.stringify(b.content)}${b.is_error ? ' ERR' : ''}` : '')).join(' ');
}

export async function startFakeAnthropic(command: string): Promise<FakeAnthropic> {
  const results: string[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let j: { messages?: { content?: unknown }[]; tools?: unknown[]; stream?: boolean; model?: string } = {};
      try { j = JSON.parse(body); } catch { /* 読めなければ空 */ }
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ input_tokens: 10 }));
      }
      const last = j.messages?.at(-1)?.content;
      const lastText = textOf(last);
      const isResult = Array.isArray(last) && last.some((b: { type?: string }) => b.type === 'tool_result');
      if (isResult) results.push(lastText);
      let block: { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'text'; text: string };
      const kind = (j.tools ?? []).length > 0 && !isResult ? /ASK|BASH/.exec(lastText)?.[0] : undefined;
      if (kind === 'BASH') block = { type: 'tool_use', id: `toolu_${++n}`, name: 'Bash', input: { command, description: 'write out' } };
      else if (kind === 'ASK') block = { type: 'tool_use', id: `toolu_${++n}`, name: 'AskUserQuestion', input: ASK };
      else block = { type: 'text', text: `REPLY ${lastText.slice(0, 200)}` };
      const stop = block.type === 'tool_use' ? 'tool_use' : 'end_turn';
      if (!j.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: j.model, content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (e: string, d: unknown) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
      ev('message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      if (block.type === 'tool_use') {
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      } else {
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } });
      }
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, results, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
