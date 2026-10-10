import { vi } from 'vitest';
import { relaxSqliteSync } from './fastSqlite.ts';

// Windows でだけ、試験の DB から fsync を省く（理由は fastSqlite.ts）。macOS と Linux は実物と同じ振る舞いのまま走らせる。
vi.mock('better-sqlite3', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('better-sqlite3') }>();
  return { ...actual, default: process.platform === 'win32' ? relaxSqliteSync(actual.default) : actual.default };
});
