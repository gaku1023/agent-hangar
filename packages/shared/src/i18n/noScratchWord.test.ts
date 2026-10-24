import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 用語集で「クイックセッション」に統一した語（旧称）が、リポジトリの本体に戻っていないかを見張る。
 * 辞書と CLI の文は glossary の試験が見るが、DB に入れる名前、画面の組み立て、コメント、README、設計書はその外にあり、
 * サイドバーの見出しが DB の旧称をそのまま出したことがある（2026-10-24）。
 * 英語の内部名（isScratch など）は同期と DB の列に入っているので対象にしない。日本語の語だけを見る。
 * 過去の計画書（docs/plans、docs/superpowers）は当時の記録なので見ない。
 * この試験のファイル自身に語を書かないよう、文字コードで組む。
 */
const OLD = '\u30b9\u30af\u30e9\u30c3\u30c1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'server-dist', 'target', 'gen', '.git', '.claude', 'plans', 'superpowers']);
const TEXT = /\.(ts|tsx|mts|mjs|js|rs|md|json|css|html|sh|ps1|nsh|toml|yml|yaml)$/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...files(path.join(dir, e.name)));
    } else if (TEXT.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

describe('旧称（クイックセッションの前の呼び名）が本体に残っていない', () => {
  it('packages、apps、README、docs の直下に出てこない', () => {
    const targets = [
      ...files(path.join(ROOT, 'packages')),
      ...files(path.join(ROOT, 'apps')),
      ...files(path.join(ROOT, 'docs')),
      ...fs.readdirSync(ROOT).filter((f) => /^README.*\.md$/.test(f)).map((f) => path.join(ROOT, f)),
    ];
    const hits = targets.flatMap((f) =>
      fs.readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (line.includes(OLD) ? [`${path.relative(ROOT, f)}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
