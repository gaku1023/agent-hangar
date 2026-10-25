import fs from 'node:fs';
import path from 'node:path';
import { compareClaudeVersions } from '@agent-hangar/shared';

/** opencode の見本の置き場。版ごとのディレクトリ（packages/server/test/fixtures/opencode/<版>/）を作る。採り方は各版の README.md にある。 */
export const FIXTURE_OPENCODE_DIR = path.join(import.meta.dirname, 'fixtures', 'opencode');

/** 採った見本 1 つ。 */
export type OpencodeFixture = { version: string; dir: string };
const VERSION_DIR = /^\d+\.\d+\.\d+$/;

/** 採った見本の一覧。版の古い順。opencode の版も x.y.z なので、Claude の版と同じ比べ方で並べる。 */
export function opencodeFixtures(): OpencodeFixture[] {
  if (!fs.existsSync(FIXTURE_OPENCODE_DIR)) return [];
  return fs.readdirSync(FIXTURE_OPENCODE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && VERSION_DIR.test(e.name))
    .map((e) => ({ version: e.name, dir: path.join(FIXTURE_OPENCODE_DIR, e.name) }))
    .sort((a, b) => compareClaudeVersions(a.version, b.version));
}

export function newestOpencodeFixture(): OpencodeFixture | null {
  return opencodeFixtures().at(-1) ?? null;
}

export function readOpencodeFixture(f: OpencodeFixture, name: string): string {
  return fs.readFileSync(path.join(f.dir, name), 'utf8');
}
