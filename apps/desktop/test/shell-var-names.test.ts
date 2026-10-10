import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 台本の中の「$名前」の直後に、ASCII でない字（全角のかっこや読点）を置かない。
 * bash は、ロケールが UTF-8 のとき、$名前 の直後の多バイトの字を変数名の続きとして読む（macOS の bash 3.2 で起きる）。
 * set -u の台本はそこで「unbound variable」と止まる。手元の試験はロケールを渡さないので通ってしまい、release で初めて落ちた。
 * 直すときは ${名前} と書く。PowerShell も同じ書き方にそろえる。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const BAD = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/u;

function scriptFiles(): string[] {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout
    .split('\0')
    .filter((f) => /\.(sh|ya?ml|ps1)$/.test(f))
    .filter((f) => fs.existsSync(path.join(ROOT, f)));
}

describe('台本の変数名の直後', () => {
  it('台本と workflow と action が見つかる（探し方が空振りしていない）', () => {
    const files = scriptFiles();
    expect(files).toContain('apps/desktop/scripts/repack-updater-macos.sh');
    expect(files).toContain('.github/workflows/release.yml');
  });

  it('$名前 の直後に ASCII でない字が無い（あれば ${名前} と書く）', () => {
    const hits: string[] = [];
    for (const f of scriptFiles()) {
      fs.readFileSync(path.join(ROOT, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (BAD.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
