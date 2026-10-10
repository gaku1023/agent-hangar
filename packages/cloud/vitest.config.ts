import { defineConfig } from 'vitest/config';
// 試験ごとの beforeEach は Miniflare（workerd）を 1 つ起こす。
// Windows の CI 走者では、平常でも 1 回に 1.5〜2 秒かかり、他の project の試験と重なると 10 秒を超えて Hook timed out になる。
// 既定の 10 秒では余裕が無いので、hook の上限だけを広げる（試験の本体の上限は据え置く）。
export default defineConfig({ test: { name: 'cloud', environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000 } });
