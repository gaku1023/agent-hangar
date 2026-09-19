import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: 'cloud', environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 30_000 } });
