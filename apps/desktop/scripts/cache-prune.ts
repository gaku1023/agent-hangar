// main の古い Actions のキャッシュを選ぶ。.github/workflows/cache-prune.yml が動かす。
// 使い方:
//   node --experimental-strip-types scripts/cache-prune.ts stale <gh cache list --json id,key,lastAccessedAt の出力>
//     族（ロックファイルの指紋を除いた鍵）ごとに、いちばん新しく使われた 1 つを残し、ほかの id を 1 行に 1 つ書く。
// リポジトリのキャッシュは 10GB までで、超えると古いものから消える。ロックファイルが変わるたびに鍵の違うキャッシュが main に積もり、
// 使われない分が main の Rust のキャッシュを押し出しうるので、使われなくなった分を先に消す。
// cache-prune.yml は npm ci をしないので、Node が型を剥がすだけで動く書き方（import は node: だけ）にしておく。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Cache {
  id: number;
  key: string;
  lastAccessedAt: string;
}

/**
 * 鍵からロックファイルの指紋を除いた族。知らない形の鍵は undefined（消さない）。
 * setup-node は「node-cache-OS-arch-npm-指紋」、rust-cache は「接頭辞-ジョブ-OS-arch-環境の指紋-ロックの指紋」である。
 */
export function cacheFamily(key: string): string | undefined {
  if (/^node-cache-.+-[0-9a-f]+$/.test(key)) return key.replace(/-[0-9a-f]+$/, '');
  if (/^v0-rust-.+-[0-9a-f]+-[0-9a-f]+$/.test(key)) return key.replace(/-[0-9a-f]+-[0-9a-f]+$/, '');
  return undefined;
}

/** 族ごとに、いちばん新しく使われた 1 つを残し、ほかを返す。時刻が同じなら鍵の順で決める。 */
export function staleCaches(list: Cache[]): Cache[] {
  const keep = new Map<string, Cache>();
  for (const c of list) {
    const f = cacheFamily(c.key);
    if (f === undefined) continue;
    const k = keep.get(f);
    if (!k || c.lastAccessedAt > k.lastAccessedAt || (c.lastAccessedAt === k.lastAccessedAt && c.key > k.key)) keep.set(f, c);
  }
  return list.filter((c) => {
    const f = cacheFamily(c.key);
    return f !== undefined && keep.get(f) !== c;
  });
}

function main(argv: string[]): number {
  const [cmd, file] = argv;
  if (cmd === 'stale' && file) {
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as Cache[];
    if (!Array.isArray(list)) throw new Error(`stale: ${file} is not a list`);
    for (const c of staleCaches(list)) process.stdout.write(`${c.id}\n`);
    return 0;
  }
  console.error('usage: cache-prune.ts stale <caches.json>');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
