import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 設定の同期の作り直し（段 4 の PR 14〜18）で消した旧実装の語と、旧実装の振る舞いの説明が、
 * 文書とコードのコメントに現役の話として戻っていないかを見張る。
 * 旧実装の記録を消す移行（migrations.ts）、旧い設定の鍵を捨てる読み込み（paths.ts）、互換の説明（compat.ts）、
 * それらの試験、設計書の「旧」を断った箇所は、消したことを書く場所なので許す。
 * 過去の計画書（docs/plans、docs/superpowers）は当時の記録なので見ない。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'server-dist', 'target', 'gen', '.git', '.claude', 'plans', 'superpowers']);
const TEXT = /\.(ts|tsx|mts|mjs|js|rs|md|json|sh|ps1|toml|yml|yaml)$/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...files(path.join(dir, e.name)));
    } else if (TEXT.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

const targets = [
  ...files(path.join(ROOT, 'packages')),
  ...files(path.join(ROOT, 'apps')),
  ...files(path.join(ROOT, 'docs')),
  ...fs.readdirSync(ROOT).filter((f) => /^README.*\.md$/.test(f)).map((f) => path.join(ROOT, f)),
];
const rel = (f: string): string => path.relative(ROOT, f).split(path.sep).join('/');
const lines = (f: string): string[] => fs.readFileSync(f, 'utf8').split('\n');
const SELF = 'packages/server/src/sync/config/noLegacyTerms.test.ts';

/** 消した旧実装の識別子。 */
const OLD_IDS = /syncClaudeConfig|claudeConfig\.ts|ClaudeConfigSync|ConfigPreviewDialog|configSyncApi|HOME_MARKER|onConfigEntries|sync\/config\/(preview|pull)/;
/** 消したことを書く場所（移行、旧い鍵の読み捨て、互換の説明）。 */
const MIGRATION_FILES = new Set([
  'packages/server/src/db/migrations.ts',
  'packages/server/src/config/paths.ts',
  'packages/cloud/src/compat.ts',
  'packages/server/test/legacyMigrations.ts',
]);

describe('設定の同期の旧実装の語が現役の話として残っていない', () => {
  it('旧実装の識別子は、試験と移行と、設計書の「旧」を断った行にしか出ない', () => {
    const hits = targets.flatMap((f) => {
      const r = rel(f);
      if (r === SELF || /\.test\.tsx?$/.test(r) || MIGRATION_FILES.has(r)) return [];
      return lines(f).flatMap((line, i) => (OLD_IDS.test(line) && !(r === 'docs/design.md' && /旧|消した/.test(line)) ? [`${r}:${i + 1}`] : []));
    });
    expect(hits).toEqual([]);
  });

  it('ホームの目印 __HANGAR_HOME__ は、運ばない（行わない）と断る行にしか出ない', () => {
    const hits = targets.flatMap((f) => {
      const r = rel(f);
      if (r === SELF) return [];
      return lines(f).flatMap((line, i) => (line.includes('__HANGAR_HOME__') && !/行わない|しない|使わない/.test(line) ? [`${r}:${i + 1}`] : []));
    });
    expect(hits).toEqual([]);
  });

  it('設計書と README は、statusLine のスクリプトを運ぶとは書かない', () => {
    const hits = ['docs/design.md', 'README.md'].flatMap((r) =>
      lines(path.join(ROOT, r)).flatMap((line, i) => (/statusLine\.command.{0,6}が指すスクリプト、/.test(line) && !/運ばない|運びません/.test(line) ? [`${r}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
