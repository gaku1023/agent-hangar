import { defineConfig } from 'vitest/config';

// Windows はプロセスの起動とファイルの読み書きが遅く、GitHub Actions のランナーでは既定の 5 秒に届く試験が出る
// （実測：db.test の 1 件が 5.3 秒）。Windows でだけ上限を延ばす。
const testTimeout = process.platform === 'win32' ? 20_000 : 5_000;
export default defineConfig({ test: { name: 'server', environment: 'node', include: ['src/**/*.test.ts', 'test/**/*.test.ts'], testTimeout } });
