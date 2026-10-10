import { defineConfig } from 'vitest/config';

// Windows はプロセスの起動とファイルの読み書きが遅く、GitHub Actions のランナーでは既定の 5 秒に届く試験が出る
// （実測：db.test の 1 件が 5.3 秒）。Windows でだけ上限を延ばす。
// ファイルの DB を何度も開く試験（開くたびにマイグレーションの前の控えを VACUUM INTO と fsync で取る）は、
// 混んだランナーで 1 件 24〜48 秒かかった（session_notes の移し替えの試験、手元の macOS では 0.1 秒）。
// Windows の試験の DB は fsync を省く（test/setup-sqlite.ts）。fsync が混んだディスクで数秒から数十秒かかり、並んで走る別の試験まで締め切りを越えたため。
const testTimeout = process.platform === 'win32' ? 60_000 : 5_000;
export default defineConfig({ test: { name: 'server', environment: 'node', include: ['src/**/*.test.ts', 'test/**/*.test.ts'], testTimeout, setupFiles: ['./test/setup-sqlite.ts'] } });
