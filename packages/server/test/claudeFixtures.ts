import fs from 'node:fs';
import path from 'node:path';
import { compareClaudeVersions } from '@agent-hangar/shared';
import { FIXTURE_CLAUDE_DIR } from './fixtures.ts';

/** 採った見本 1 つ。dir は packages/server/test/fixtures/claude/<版>/ である。手書きの見本（同じ置き場の直下）とは別に置く。 */
export type ClaudeFixture = { version: string; dir: string; sessionId: string };
const VERSION_DIR = /^\d+\.\d+\.\d+$/;

/** 採った見本の一覧。版の古い順。 */
export function claudeFixtures(): ClaudeFixture[] {
  return fs.readdirSync(FIXTURE_CLAUDE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && VERSION_DIR.test(e.name))
    .map((e) => {
      const dir = path.join(FIXTURE_CLAUDE_DIR, e.name);
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as { sessionId: string };
      return { version: e.name, dir, sessionId: meta.sessionId };
    })
    .sort((a, b) => compareClaudeVersions(a.version, b.version));
}

export function newestClaudeFixture(): ClaudeFixture | null {
  return claudeFixtures().at(-1) ?? null;
}

export function readFixtureText(f: ClaudeFixture, name: string): string {
  return fs.readFileSync(path.join(f.dir, name), 'utf8');
}

export function readFixtureJsonl(f: ClaudeFixture, name: string): unknown[] {
  return readFixtureText(f, name).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as unknown);
}

/** サブエージェントのトランスクリプトの名前（subagents/agent-<id>.jsonl）。 */
export function fixtureSubagents(f: ClaudeFixture): string[] {
  const d = path.join(f.dir, 'subagents');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).sort().map((n) => `subagents/${n}`) : [];
}
