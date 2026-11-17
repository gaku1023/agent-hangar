import { defineConfig } from 'vitest/config';
// 参加コードの試験は本番の回数（PBKDF2 300 万回）を 1 つの試験で 2 回回す。遅い Windows のランナーでは 5 秒を超えた。
export default defineConfig({ test: { name: 'shared', environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 30_000 } });
