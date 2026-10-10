import { defineConfig } from 'vitest/config';

// Windows はプロセスの起動が遅く、CLI を起こす試験が既定の 5 秒に届くことがある。Windows でだけ上限を延ばす。
// DB を開いて控えを取る試験は、混んだランナーで 20 秒を超えた（setup cloud の控えの失敗の試験）。サーバの試験と同じ 60 秒にそろえる。
const testTimeout = process.platform === 'win32' ? 60_000 : 5_000;
export default defineConfig({ test: { name: 'cli', environment: 'node', include: ['src/**/*.test.ts'], testTimeout } });
