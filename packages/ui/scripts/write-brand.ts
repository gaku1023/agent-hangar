/** ロゴのファイルを、src/brand/logo.ts の原図の関数から書き出す。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_FILES } from '../src/brand/logo.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
for (const f of BRAND_FILES) {
  fs.writeFileSync(path.join(repo, f.path), f.make());
  console.log(`wrote ${f.path}`);
}
