// spikes/12-summarize-local/compress.mjs
import fs from 'node:fs';
export function compress(file, maxChars = 12000) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const items = [];
  for (const l of lines) {
    if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch { continue; }
    const content = r.message?.content; if (content == null) continue;
    if (typeof content === 'string') { if (r.type === 'user') items.push(`[user] ${content.slice(0, 2000)}`); continue; }
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (r.type === 'user' && c.type === 'text') items.push(`[user] ${c.text.slice(0, 2000)}`);
      if (r.type === 'assistant' && c.type === 'text') items.push(`[assistant] ${c.text.slice(0, 600)}`);
      if (c.type === 'tool_use') items.push(`[tool] ${c.name} ${c.input?.file_path ?? c.input?.command ?? ''}`.slice(0, 200));
    }
  }
  let text = items.join('\n');
  if (text.length > maxChars) {                       // 中盤を間引き、最初と最後を残す
    const head = items.slice(0, Math.floor(items.length * 0.3));
    const tail = items.slice(-Math.floor(items.length * 0.3));
    text = [...head, `[... ${items.length - head.length - tail.length} 件を省略 ...]`, ...tail].join('\n').slice(0, maxChars);
  }
  return text;
}
if (process.argv[1]?.endsWith('compress.mjs')) console.log(compress(process.argv[2]));
