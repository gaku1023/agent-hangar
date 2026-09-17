// spikes/12-summarize-local/summarize.mjs
import { compress } from './compress.mjs';
import { schema } from './schema.mjs';

const [file, model = 'qwen3.6-35b-a3b-mlx'] = process.argv.slice(2);
const input = compress(file);
const t = Date.now();
const res = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model, temperature: 0.2,
    messages: [
      { role: 'system', content: '以下はコーディングエージェントのセッションログの抜粋です。日本語で、指定の JSON だけを返してください。title は名詞句、one_liner は 1 文、body は 2〜3 文、next_steps は具体的な行動。' },
      { role: 'user', content: input },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'session_summary', strict: true, schema } },
  }),
});
const j = await res.json();
const text = j.choices?.[0]?.message?.content ?? '';
console.log(JSON.stringify({ model, file: file.split('/').pop(), inputChars: input.length, ms: Date.now() - t, usage: j.usage, error: j.error }));
try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log('NOT JSON:', text.slice(0, 500)); }
