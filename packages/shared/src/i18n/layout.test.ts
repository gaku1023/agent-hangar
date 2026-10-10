import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from './en.ts';
import { ja } from './ja.ts';
import { MESSAGES } from './keys.ts';

/**
 * 辞書の割り方を守らせる試験。
 * 辞書は領域（鍵の最初の語）ごとのファイルに割ってある。
 * `keys/<領域>.ts`（鍵と引数の名前）、`ja/<領域>.ts`、`en/<領域>.ts` の 3 つで 1 組である。
 * 並行する PR が別の領域の文を足しても、同じ行でぶつからないための割り方なので、組が崩れたらここで止める。
 */
const here = dirname(fileURLToPath(import.meta.url));
const KINDS = ['keys', 'ja', 'en'] as const;
type Kind = (typeof KINDS)[number];

const areasOf = (kind: Kind): string[] =>
  readdirSync(join(here, kind))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.slice(0, -'.ts'.length))
    .sort();

/** 領域のファイルが 1 つだけ出す表を取り出す。 */
async function load(kind: Kind, area: string): Promise<Record<string, unknown>> {
  const mod = (await import(`./${kind}/${area}.ts`)) as Record<string, Record<string, unknown>>;
  const exported = Object.values(mod);
  expect([kind, area, exported.length]).toEqual([kind, area, 1]);
  return exported[0]!;
}

const AREAS = areasOf('keys');

describe('辞書の割り方', () => {
  it('領域が 1 つ以上あり、名前は小文字で始まる英数字である', () => {
    expect(AREAS.length).toBeGreaterThan(0);
    for (const area of AREAS) expect([area, area]).toEqual([area, area.match(/^[a-z][A-Za-z0-9]*$/)?.[0]]);
  });

  it('keys、ja、en は、同じ領域のファイルを同じだけ持つ', () => {
    // 片方だけにファイルがあるのは、領域の鍵を足して訳を忘れた（または逆の）形である。
    for (const kind of KINDS) expect([kind, areasOf(kind)]).toEqual([kind, AREAS]);
  });

  it('どのファイルも、自分の領域の鍵だけを持つ', async () => {
    // ファイルの名前が鍵の最初の語と同じなら、鍵の持ち主が 1 つに決まり、2 つのファイルが同じ鍵を持つことも無い。
    for (const kind of KINDS) {
      for (const area of AREAS) {
        const strays = Object.keys(await load(kind, area)).filter((key) => !key.startsWith(`${area}.`));
        expect([kind, area, strays]).toEqual([kind, area, []]);
      }
    }
  });

  it('ja と en は、領域ごとに keys と同じ鍵をちょうど持つ', async () => {
    for (const area of AREAS) {
      const keys = Object.keys(await load('keys', area)).sort();
      expect(keys.length).toBeGreaterThan(0);
      for (const kind of ['ja', 'en'] as const) expect([kind, area, Object.keys(await load(kind, area)).sort()]).toEqual([kind, area, keys]);
    }
  });

  it('束ねた表は、領域のファイルの鍵を 1 つも落とさず、足しもしない', async () => {
    const bundled = { keys: MESSAGES, ja, en } as const;
    for (const kind of KINDS) {
      const merged: string[] = [];
      for (const area of AREAS) merged.push(...Object.keys(await load(kind, area)));
      // 領域をまたいで鍵が重なっていれば、束ねるときにどちらかが黙って消える。
      expect([kind, new Set(merged).size]).toEqual([kind, merged.length]);
      expect([kind, Object.keys(bundled[kind]).sort()]).toEqual([kind, merged.sort()]);
    }
  });

  it('束ねた表の値は、領域のファイルの値そのものである', async () => {
    const bundled = { keys: MESSAGES, ja, en } as const;
    for (const kind of KINDS) {
      for (const area of AREAS) {
        for (const [key, value] of Object.entries(await load(kind, area))) expect([kind, key, (bundled[kind] as Record<string, unknown>)[key]]).toEqual([kind, key, value]);
      }
    }
  });

  it('keys.ts、ja.ts、en.ts は、領域のファイルを束ねるだけで、文を直に持たない', () => {
    // 文をここへ足すと、並行する PR が同じ行でぶつかる割り方へ戻ってしまう。
    for (const file of ['keys.ts', 'ja.ts', 'en.ts']) {
      const source = readFileSync(join(here, file), 'utf8');
      const entries = source.split('\n').filter((line) => /^\s*['"][a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){2,}['"]\s*:/.test(line));
      expect([file, entries]).toEqual([file, []]);
    }
  });
});
