import { defineConfig } from 'vitest/config';

// Windows はプロセスの起動が遅く、CLI を起こす試験が既定の 5 秒に届くことがある。Windows でだけ上限を延ばす。
const testTimeout = process.platform === 'win32' ? 20_000 : 5_000;
export default defineConfig({ test: { name: 'cli', environment: 'node', include: ['src/**/*.test.ts'], testTimeout } });
