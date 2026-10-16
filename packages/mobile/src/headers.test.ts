import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** _headers を、道の行ごとに、その下の見出しの行の並びへ分ける。 */
function blocks(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#') || line.trim() === '') continue;
    if (!/^\s/.test(line)) {
      cur = [];
      out.set(line.trim(), cur);
      continue;
    }
    cur?.push(line.trim());
  }
  return out;
}

describe('_headers', () => {
  const file = path.resolve(import.meta.dirname, '../_headers');
  const b = blocks(fs.readFileSync(file, 'utf8'));

  it('/app/ の入口にも /app/* と同じ見出しを付ける（* が入口に当たらない場合に備える）', () => {
    expect(b.get('/app/*')).toBeDefined();
    expect(b.get('/app/')).toEqual(b.get('/app/*'));
    expect(b.get('/app/')!.some((l) => l.startsWith('Content-Security-Policy:'))).toBe(true);
  });
});
