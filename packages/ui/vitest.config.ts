import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Vitest 5 では environmentMatchGlobs が無いので、この設定をコンテナにして環境ごとに子プロジェクトを分ける。
// 子プロジェクトはこの設定を継承し、名前は「ui」を前置した形になる。
const domGlobs = ['src/views/**/*.test.{ts,tsx}', 'src/intent/**/*.test.{ts,tsx}', 'src/Root.test.tsx'];

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'ui',
    setupFiles: ['src/test/setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          exclude: domGlobs,
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: domGlobs,
        },
      },
    ],
  },
});
