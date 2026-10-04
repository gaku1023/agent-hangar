import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const sheets = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));

describe('字の太さ', () => {
  // Hiragino Sans は 520 や 560 を 600 に、650 や 680 を 700 に丸めて描く。
  // 中間の値を書くと欧文だけが細くなり、同じ行の和文と欧文で太さが割れる。
  it('太さは 400、500、600、700 だけを使う', () => {
    const odd: string[] = [];
    for (const f of sheets) {
      const css = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of css.matchAll(/font-weight:\s*(\d+)/g)) if (!['400', '500', '600', '700'].includes(m[1]!)) odd.push(`${f}: ${m[1]}`);
      // font の一括指定の先頭に書いた太さも見る（font: 600 12px/1 …）。
      for (const m of css.matchAll(/font:\s*(\d{3})\s/g)) if (!['400', '500', '600', '700'].includes(m[1]!)) odd.push(`${f}: font ${m[1]}`);
    }
    expect(odd).toEqual([]);
  });
});
