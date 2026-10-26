import fs from 'node:fs';
import path from 'node:path';
import { compareClaudeVersions } from '@agent-hangar/shared';

/** codex の見本の置き場。版ごとのディレクトリ（packages/server/test/fixtures/codex-compat/<版>/）を作る。採り方は各版の README.md にある。 */
export const FIXTURE_CODEX_COMPAT_DIR = path.join(import.meta.dirname, 'fixtures', 'codex-compat');

export type CodexFixture = { version: string; dir: string };
const VERSION_DIR = /^\d+\.\d+\.\d+$/;

/** 採った見本の一覧。版の古い順。codex の版も x.y.z なので、Claude の版と同じ比べ方で並べる。 */
export function codexFixtures(): CodexFixture[] {
  if (!fs.existsSync(FIXTURE_CODEX_COMPAT_DIR)) return [];
  return fs.readdirSync(FIXTURE_CODEX_COMPAT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && VERSION_DIR.test(e.name))
    .map((e) => ({ version: e.name, dir: path.join(FIXTURE_CODEX_COMPAT_DIR, e.name) }))
    .sort((a, b) => compareClaudeVersions(a.version, b.version));
}

export const newestCodexFixture = (): CodexFixture | null => codexFixtures().at(-1) ?? null;
export const readCodexFixture = (f: CodexFixture, name: string): string => fs.readFileSync(path.join(f.dir, name), 'utf8');
export const readCodexFixtureJson = <T>(f: CodexFixture, name: string): T => JSON.parse(readCodexFixture(f, name)) as T;
