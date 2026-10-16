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

  it('/app/* だけに明示する（/app/ の段を足すと重なって見出しが二重に付く）', () => {
    expect(b.get('/app/')).toBeUndefined();
    const rules = b.get('/app/*')!;
    expect(rules.some((l) => l.startsWith('Content-Security-Policy:'))).toBe(true);
    expect(rules.filter((l) => l.startsWith('Content-Security-Policy:'))).toHaveLength(1);
  });

  it('img-src は self、data:、blob:（写真のサムネイルを blob: で出す）', () => {
    const csp = b.get('/app/*')!.find((l) => l.startsWith('Content-Security-Policy:'))!;
    expect(csp).toMatch(/img-src 'self' data: blob:;/);
  });
});
