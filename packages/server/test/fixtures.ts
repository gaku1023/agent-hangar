import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_CLAUDE_DIR = fileURLToPath(new URL('./fixtures/claude', import.meta.url));
export const SESSION_ALPHA = 'aaaaaaaa-0000-4000-8000-000000000001';
export const SESSION_BETA = 'aaaaaaaa-0000-4000-8000-000000000002';
export const SESSION_OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';

/** フィクスチャを一時ディレクトリに複製する。追記や削除を試すテストで使う。 */
export function copyFixtureClaudeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-fixture-'));
  fs.cpSync(FIXTURE_CLAUDE_DIR, dir, { recursive: true });
  return dir;
}
